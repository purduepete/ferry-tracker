import { describe, expect, it, vi } from 'vitest';
import type { HighwayCamera } from '@ferry-tracker/shared';
import { assignCameras, CameraDirectory, type CameraTerminal } from '../src/cameras';
import type { WsdotClient } from '../src/wsdotClient';

const terminals: CameraTerminal[] = [
    { id: 7, name: 'Seattle', latitude: 47.6027, longitude: -122.3381 },
    { id: 3, name: 'Bainbridge Island', latitude: 47.6221, longitude: -122.5096 },
    { id: 11, name: 'Point Defiance', latitude: 47.3059, longitude: -122.5145 },
    { id: 12, name: 'Tahlequah', latitude: 47.3335, longitude: -122.5069 },
];

function camera(overrides: Partial<HighwayCamera> & { CameraID: number }): HighwayCamera {
    return {
        Title: 'WSF Camera',
        Description: null,
        ImageURL: 'https://images.wsdot.wa.gov/wsf/test.jpg',
        ImageWidth: 400,
        ImageHeight: 421,
        IsActive: true,
        SortOrder: 100,
        DisplayLatitude: 47.6027,
        DisplayLongitude: -122.3381,
        CameraLocation: { Latitude: 47.6027, Longitude: -122.3381, RoadName: 'Ferries' },
        ...overrides,
    };
}

describe('camera assignment', () => {
    it('reads the terminal off the title even when the island suffix is missing', () => {
        // Coordinates say Seattle, the title says Bainbridge, and the title wins.
        const assigned = assignCameras([camera({ CameraID: 1, Title: 'WSF Bainbridge Ferry Holding' })], terminals);
        expect(assigned.get(3)?.map((entry) => entry.id)).toEqual([1]);
        expect(assigned.has(7)).toBe(false);
    });

    it('falls back to proximity when a title names two terminals', () => {
        const assigned = assignCameras(
            [camera({ CameraID: 2, Title: 'WSF Seattle Ferry Bainbridge Holding' })],
            terminals
        );
        expect(assigned.get(7)?.map((entry) => entry.id)).toEqual([2]);
    });

    it('separates terminals that face each other across a narrow crossing', () => {
        const assigned = assignCameras(
            [
                camera({
                    CameraID: 3,
                    Title: 'WSF Ferry Holding',
                    CameraLocation: { Latitude: 47.3059, Longitude: -122.5145, RoadName: 'Ferries' },
                }),
                camera({
                    CameraID: 4,
                    Title: 'WSF Ferry Holding',
                    CameraLocation: { Latitude: 47.3335, Longitude: -122.5069, RoadName: 'Ferries' },
                }),
            ],
            terminals
        );
        expect(assigned.get(11)?.map((entry) => entry.id)).toEqual([3]);
        expect(assigned.get(12)?.map((entry) => entry.id)).toEqual([4]);
    });

    it('drops a camera further than the assignment cutoff from every terminal', () => {
        const assigned = assignCameras(
            [
                camera({
                    CameraID: 5,
                    Title: 'WSF Ferry Holding',
                    CameraLocation: { Latitude: 48.5, Longitude: -122.6, RoadName: 'Ferries' },
                }),
            ],
            terminals
        );
        expect(assigned.size).toBe(0);
    });

    it('drops retired cameras, non-ferry roads, and images hosted off WSDOT', () => {
        const assigned = assignCameras(
            [
                camera({ CameraID: 6, IsActive: false }),
                camera({ CameraID: 7, CameraLocation: { Latitude: 47.6027, Longitude: -122.3381, RoadName: 'SR 11' } }),
                camera({ CameraID: 8, ImageURL: 'https://example.com/webcam/colman.jpg' }),
                camera({ CameraID: 9, ImageURL: 'http://images.wsdot.wa.gov/wsf/test.jpg' }),
            ],
            terminals
        );
        expect(assigned.size).toBe(0);
    });

    it("orders a terminal's cameras the way WSDOT orders them", () => {
        const assigned = assignCameras(
            [
                camera({ CameraID: 20, Title: 'WSF Seattle Ferry B', SortOrder: 5200 }),
                camera({ CameraID: 21, Title: 'WSF Seattle Ferry A', SortOrder: 5100 }),
            ],
            terminals
        );
        expect(assigned.get(7)?.map((entry) => entry.id)).toEqual([21, 20]);
    });
});

describe('camera directory', () => {
    const ferryCamera = camera({ CameraID: 30, Title: 'WSF Seattle Ferry Holding' });
    const highwayCamera = camera({
        CameraID: 31,
        CameraLocation: { Latitude: 48.75, Longitude: -122.47, RoadName: 'SR 11' },
    });

    it('fetches once for concurrent cold reads and keeps only ferry cameras', async () => {
        const getHighwayCameras = vi.fn().mockResolvedValue([ferryCamera, highwayCamera]);
        const directory = new CameraDirectory({ getHighwayCameras } as unknown as WsdotClient);
        const [first, second] = await Promise.all([directory.list(), directory.list()]);
        expect(getHighwayCameras).toHaveBeenCalledTimes(1);
        expect(first.map((entry) => entry.CameraID)).toEqual([30]);
        expect(second).toEqual(first);
    });

    it('serves the cached list until the TTL expires', async () => {
        const getHighwayCameras = vi.fn().mockResolvedValue([ferryCamera]);
        let clock = 1_000;
        const directory = new CameraDirectory({ getHighwayCameras } as unknown as WsdotClient, () => clock);
        await directory.list();
        await directory.list();
        expect(getHighwayCameras).toHaveBeenCalledTimes(1);
        clock += 21_600_001;
        await directory.list();
        expect(getHighwayCameras).toHaveBeenCalledTimes(2);
    });

    it('answers with an empty list instead of failing when WSDOT is down', async () => {
        const getHighwayCameras = vi.fn().mockRejectedValue(new Error('HTTP 503'));
        const directory = new CameraDirectory({ getHighwayCameras } as unknown as WsdotClient);
        await expect(directory.list()).resolves.toEqual([]);
    });

    it('keeps the previous list when a later refresh fails', async () => {
        const getHighwayCameras = vi.fn().mockResolvedValueOnce([ferryCamera]).mockRejectedValue(new Error('HTTP 503'));
        let clock = 1_000;
        const directory = new CameraDirectory({ getHighwayCameras } as unknown as WsdotClient, () => clock);
        await directory.list();
        clock += 21_600_001;
        // The stale copy answers immediately while the failing refresh runs behind it.
        expect((await directory.list()).map((entry) => entry.CameraID)).toEqual([30]);
        await vi.waitFor(() => expect(getHighwayCameras).toHaveBeenCalledTimes(2));
        expect((await directory.list()).map((entry) => entry.CameraID)).toEqual([30]);
    });
});
