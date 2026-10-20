import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeScheduleSnapshots } from '../src/capture/referenceWriters';
import { openDatabase, type Db } from '../src/db/database';
import type { WsdotClient } from '../src/wsdotClient';

const SEATTLE = 7;
const BAINBRIDGE = 3;

// 2026-09-12T20:00:00Z is 13:00 Pacific, so "today" is unambiguous and there is a real
// future and a real past inside the same service date.
const NOW = Date.parse('2026-09-12T20:00:00.000Z');

const mates = [
    {
        DepartingTerminalID: SEATTLE,
        DepartingDescription: 'Seattle',
        ArrivingTerminalID: BAINBRIDGE,
        ArrivingDescription: 'Bainbridge Island',
    },
];

function wsdotDate(iso: string): string {
    return `/Date(${Date.parse(iso)}-0700)/`;
}

function payload(times: Array<{ departing: string; vesselName?: string; arriving?: string }>): unknown {
    return {
        ScheduleID: 1,
        TerminalCombos: [
            {
                DepartingTerminalID: SEATTLE,
                DepartingTerminalName: 'Seattle',
                ArrivingTerminalID: BAINBRIDGE,
                ArrivingTerminalName: 'Bainbridge Island',
                Times: times.map((time) => ({
                    DepartingTime: wsdotDate(time.departing),
                    ArrivingTime: time.arriving ? wsdotDate(time.arriving) : null,
                    VesselID: 1,
                    VesselName: time.vesselName ?? 'Tacoma',
                    LoadingRule: 3,
                })),
            },
        ],
    };
}

function client(response: unknown): WsdotClient {
    return { getSchedule: vi.fn().mockResolvedValue(response) } as unknown as WsdotClient;
}

let db: Db;

beforeEach(() => {
    db = openDatabase(':memory:');
});

afterEach(() => {
    db.close();
});

async function rows(): Promise<
    Array<{ departing_time: string; vessel_name: string | null; withdrawn_at: string | null; service_date: string }>
> {
    return (await db
        .prepare(
            `SELECT service_date, departing_time, vessel_name, withdrawn_at
    FROM schedule_snapshot ORDER BY service_date, departing_time`
        )
        .all()) as never;
}

async function capture(response: unknown, now = NOW): Promise<void> {
    await writeScheduleSnapshots(db, client(response), mates, new Date(now).toISOString(), undefined, () => now);
}

describe('schedule snapshot reconcile', () => {
    it('withdraws a future slot WSDOT stopped publishing', async () => {
        await capture(payload([{ departing: '2026-09-12T22:00:00.000Z' }, { departing: '2026-09-12T23:00:00.000Z' }]));
        await capture(payload([{ departing: '2026-09-12T22:00:00.000Z' }, { departing: '2026-09-12T23:30:00.000Z' }]));

        const withdrawn = (await rows()).filter((row) => row.withdrawn_at !== null).map((row) => row.departing_time);
        expect(withdrawn).toEqual(['2026-09-12T23:00:00.000Z']);
        // Nothing is deleted: the rollup still needs the slot to pair a leg that ran anyway.
        expect(await rows()).toHaveLength(3);
    });

    it('clears the mark when WSDOT publishes the slot again', async () => {
        const full = payload([{ departing: '2026-09-12T22:00:00.000Z' }, { departing: '2026-09-12T23:00:00.000Z' }]);
        await capture(full);
        await capture(payload([{ departing: '2026-09-12T22:00:00.000Z' }]));
        expect((await rows()).filter((row) => row.withdrawn_at !== null)).toHaveLength(1);

        await capture(full);
        expect((await rows()).filter((row) => row.withdrawn_at !== null)).toHaveLength(0);
    });

    it('never withdraws a sailing that has already departed', async () => {
        await capture(payload([{ departing: '2026-09-12T16:00:00.000Z' }, { departing: '2026-09-12T22:00:00.000Z' }]));
        await capture(payload([{ departing: '2026-09-12T22:00:00.000Z' }]));

        const past = (await rows()).find((row) => row.departing_time === '2026-09-12T16:00:00.000Z');
        expect(past?.withdrawn_at).toBeNull();
    });

    it('withdraws nothing when the payload carries no times for the day', async () => {
        await capture(payload([{ departing: '2026-09-12T22:00:00.000Z' }]));
        await capture(payload([]));

        expect((await rows()).every((row) => row.withdrawn_at === null)).toBe(true);
    });

    it("leaves tomorrow alone when a post-midnight sailing arrives in today's payload", async () => {
        // scheduletoday can carry a sailing whose Pacific service date is already tomorrow. Treating
        // that lone row as tomorrow's whole schedule would withdraw the rest of the next day.
        await capture(
            payload([
                { departing: '2026-09-12T22:00:00.000Z' },
                { departing: '2026-09-13T07:30:00.000Z' },
                { departing: '2026-09-13T16:00:00.000Z' },
                { departing: '2026-09-13T17:00:00.000Z' },
            ])
        );
        await capture(payload([{ departing: '2026-09-12T22:00:00.000Z' }, { departing: '2026-09-13T07:30:00.000Z' }]));

        const tomorrow = (await rows()).filter((row) => row.service_date === '2026-09-13');
        expect(tomorrow).toHaveLength(3);
        expect(tomorrow.every((row) => row.withdrawn_at === null)).toBe(true);
    });

    it('refreshes the vessel on a slot that is still published', async () => {
        await capture(payload([{ departing: '2026-09-12T22:00:00.000Z', vesselName: 'Tacoma' }]));
        await capture(payload([{ departing: '2026-09-12T22:00:00.000Z', vesselName: 'Chimacum' }]));

        expect(await rows()).toEqual([expect.objectContaining({ vessel_name: 'Chimacum', withdrawn_at: null })]);
    });

    it('reconciles a pair WSDOT dropped from terminalmates', async () => {
        await capture(payload([{ departing: '2026-09-12T22:00:00.000Z' }, { departing: '2026-09-12T23:00:00.000Z' }]));

        // The pair is gone from mates, so only the stored-pair union keeps it reconciled.
        await writeScheduleSnapshots(
            db,
            client(payload([{ departing: '2026-09-12T22:00:00.000Z' }])),
            [],
            new Date(NOW).toISOString(),
            undefined,
            () => NOW
        );

        expect((await rows()).filter((row) => row.withdrawn_at !== null).map((row) => row.departing_time)).toEqual([
            '2026-09-12T23:00:00.000Z',
        ]);
    });

    it('bypasses the client cache so a stale payload cannot withdraw a live slot', async () => {
        const stub = client(payload([{ departing: '2026-09-12T22:00:00.000Z' }]));
        await writeScheduleSnapshots(db, stub, mates, new Date(NOW).toISOString(), undefined, () => NOW);
        expect(stub.getSchedule).toHaveBeenCalledWith(SEATTLE, BAINBRIDGE, false, true);
    });

    it('stamps each pair at the time its own payload landed', async () => {
        // Pairs are fetched one at a time, so the task start time can call an already sailed
        // departure "future" and withdraw it.
        let clock = NOW;
        const stub = {
            getSchedule: vi.fn().mockImplementation(async () => {
                clock += 3_600_000;
                return await Promise.resolve(payload([{ departing: '2026-09-12T22:00:00.000Z' }]));
            }),
        } as unknown as WsdotClient;

        await capture(payload([{ departing: '2026-09-12T20:30:00.000Z' }, { departing: '2026-09-12T22:00:00.000Z' }]));
        await writeScheduleSnapshots(db, stub, mates, new Date(NOW).toISOString(), undefined, () => clock);

        const early = (await rows()).find((row) => row.departing_time === '2026-09-12T20:30:00.000Z');
        expect(early?.withdrawn_at).toBeNull();
    });
});
