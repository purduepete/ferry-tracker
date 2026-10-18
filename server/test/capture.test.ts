import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureService } from '../src/capture/captureService';
import { RawArchive } from '../src/capture/rawArchive';
import { writeSailingSpaceObservations, writeVesselObservations } from '../src/capture/writers';
import type { AppConfig } from '../src/config';
import { openDatabase, type Db } from '../src/db/database';
import type { WsdotClient } from '../src/wsdotClient';

const ACCESS_CODE = '11112222-3333-4444-5555-666677778888';

function captureConfig(overrides: Partial<AppConfig['capture']> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    dataSource: 'live',
    apiAccessCode: ACCESS_CODE,
    secrets: [ACCESS_CODE],
    rawInspector: false,
    capture: {
      enabled: true,
      allowFixtureSource: false,
      dbPath: ':memory:',
      rawArchiveDir: '',
      vesselIntervalMs: 5,
      spaceIntervalMs: 1_000_000,
      referenceIntervalMs: 1_000_000,
      scheduleIntervalMs: 1_000_000,
      rollupIntervalMs: 1_000_000,
      retentionDays: null,
      dwellCeilingMinutes: 120,
      dockDebounceSeconds: 120,
      minFreeDiskMb: 0,
      statusEnabled: true,
      ...overrides,
    },
  };
}

function vessel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    VesselID: 1,
    VesselName: 'Tacoma',
    DepartingTerminalID: 7,
    DepartingTerminalName: 'Seattle',
    ArrivingTerminalID: 3,
    ArrivingTerminalName: 'Bainbridge Island',
    Latitude: 47.6,
    Longitude: -122.34,
    Speed: 12,
    Heading: 270,
    InService: true,
    AtDock: false,
    LeftDock: '/Date(1788282000000-0700)/',
    Eta: '/Date(1788284100000-0700)/',
    EtaBasis: 'Estimate',
    OpRouteAbbrev: ['sea-bi'],
    ScheduledDeparture: '/Date(1788282000000-0700)/',
    TimeStamp: '/Date(1788282060000-0700)/',
    ...overrides,
  };
}

function terminalSpace(driveUp: number, departure = '/Date(1788282000000-0700)/'): Record<string, unknown> {
  return {
    TerminalID: 7,
    TerminalName: 'Seattle',
    DepartingSpaces: [
      {
        Departure: departure,
        IsCancelled: false,
        VesselID: 1,
        VesselName: 'Tacoma',
        MaxSpaceCount: 200,
        SpaceForArrivalTerminals: [
          {
            TerminalID: 3,
            TerminalName: 'Bainbridge Island',
            VesselID: 1,
            VesselName: 'Tacoma',
            DisplayReservableSpace: true,
            ReservableSpaceCount: 40,
            DisplayDriveUpSpace: true,
            DriveUpSpaceCount: driveUp,
            MaxSpaceCount: 200,
            ArrivalTerminalIDs: [3],
          },
        ],
      },
    ],
  };
}

describe('vessel observation dedupe', () => {
  let db: Db;
  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => db.close());

  const rows = async () => (await db.prepare('SELECT * FROM vessel_observation ORDER BY id').all()) as Array<Record<string, unknown>>;

  it('writes a second row when WSDOT reuses a timestamp but changes the content', async () => {
    (await writeVesselObservations(db, [vessel()], '2026-09-01T18:30:00.000Z'));
    const result = (await writeVesselObservations(db, [vessel({ Speed: 14 })], '2026-09-01T18:30:30.000Z'));

    expect(result.written).toBe(1);
    expect((await rows())).toHaveLength(2);
  });

  it('writes one row when the same record arrives twice', async () => {
    (await writeVesselObservations(db, [vessel()], '2026-09-01T18:30:00.000Z'));
    const result = (await writeVesselObservations(db, [vessel()], '2026-09-01T18:30:30.000Z'));

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect((await rows())).toHaveLength(1);
  });

  it('does not write per poll when the source timestamp is missing and nothing changed', async () => {
    (await writeVesselObservations(db, [vessel({ TimeStamp: null })], '2026-09-01T18:30:00.000Z'));
    (await writeVesselObservations(db, [vessel({ TimeStamp: null })], '2026-09-01T18:30:30.000Z'));
    const result = (await writeVesselObservations(db, [vessel({ TimeStamp: null })], '2026-09-01T18:31:00.000Z'));

    expect(result.skipped).toBe(1);
    expect((await rows())).toHaveLength(1);
  });

  it('records a change when the source timestamp is missing and the content moves', async () => {
    (await writeVesselObservations(db, [vessel({ TimeStamp: null })], '2026-09-01T18:30:00.000Z'));
    (await writeVesselObservations(db, [vessel({ TimeStamp: null, AtDock: true })], '2026-09-01T18:30:30.000Z'));

    expect((await rows())).toHaveLength(2);
  });

  it('stores booleans as bits and dates as ISO 8601 UTC', async () => {
    (await writeVesselObservations(db, [vessel()], '2026-09-01T18:30:00.000Z'));
    const [row] = (await rows());

    expect(row.in_service).toBe(1);
    expect(row.at_dock).toBe(0);
    expect(row.left_dock).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('sailing space observations', () => {
  let db: Db;
  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => db.close());

  const rows = async () => (await db.prepare('SELECT * FROM sailing_space_observation ORDER BY id').all()) as Array<Record<string, unknown>>;

  it('writes a baseline row for a sailing whose counts never change', async () => {
    (await writeSailingSpaceObservations(db, [terminalSpace(50)], '2026-09-01T18:30:00.000Z'));
    (await writeSailingSpaceObservations(db, [terminalSpace(50)], '2026-09-01T18:31:00.000Z'));

    const observations = (await rows());
    expect(observations).toHaveLength(1);
    expect(observations[0].observation_kind).toBe('baseline');
  });

  it('writes a change row and then a final row when the sailing leaves the payload', async () => {
    (await writeSailingSpaceObservations(db, [terminalSpace(50)], '2026-09-01T18:30:00.000Z'));
    (await writeSailingSpaceObservations(db, [terminalSpace(20)], '2026-09-01T18:31:00.000Z'));
    (await writeSailingSpaceObservations(db, [terminalSpace(20, '/Date(1788285600000-0700)/')], '2026-09-01T18:40:00.000Z'));

    const kinds = (await rows()).map((row) => row.observation_kind);
    expect(kinds).toEqual(['baseline', 'change', 'baseline', 'final']);
  });

  it('stores Pacific buckets alongside the departure', async () => {
    (await writeSailingSpaceObservations(db, [terminalSpace(50)], '2026-09-01T18:30:00.000Z'));
    const [row] = (await rows());

    expect(row.service_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.hour_local).toBeGreaterThanOrEqual(0);
    expect(row.hour_local).toBeLessThanOrEqual(23);
  });
});

describe('raw archive', () => {
  let db: Db;
  let directory: string;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    directory = await mkdtemp(path.join(tmpdir(), 'ferry-archive-'));
  });
  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('appends nothing when the response hash is unchanged', async () => {
    const archive = new RawArchive(db, directory, 0, [ACCESS_CODE]);
    const first = await archive.append('vessel_locations', '2026-09-01T18:30:00.000Z', [vessel()]);
    const second = await archive.append('vessel_locations', '2026-09-01T18:30:30.000Z', [vessel()]);

    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(second.reason).toBe('unchanged');
    expect(first.hash).toBe(second.hash);

    const files = (await db.prepare('SELECT * FROM archive_file').all()) as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0].member_count).toBe(1);
  });

  it('appends a new member when the response changes', async () => {
    const archive = new RawArchive(db, directory, 0, [ACCESS_CODE]);
    await archive.append('vessel_locations', '2026-09-01T18:30:00.000Z', [vessel()]);
    await archive.append('vessel_locations', '2026-09-01T18:30:30.000Z', [vessel({ Speed: 14 })]);

    const files = (await db.prepare('SELECT * FROM archive_file').all()) as Array<Record<string, unknown>>;
    expect(files[0].member_count).toBe(2);
  });
});

describe('capture loop', () => {
  let db: Db;
  let directory: string;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    directory = await mkdtemp(path.join(tmpdir(), 'ferry-capture-'));
  });
  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('never runs the same task twice at once', async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const client = {
      getVesselLocations: async () => {
        inFlight += 1;
        calls += 1;
        peak = Math.max(peak, inFlight);
        await settle(30);
        inFlight -= 1;
        return [vessel({ Speed: calls })];
      },
    } as unknown as WsdotClient;

    const service = new CaptureService(db, client, captureConfig({ rawArchiveDir: directory }));
    service.start();
    await settle(200);
    await service.stop();
    await settle(60);

    expect(calls).toBeGreaterThan(1);
    expect(peak).toBe(1);
  });

  it('records a redacted error and keeps polling after an API failure', async () => {
    let calls = 0;
    const client = {
      getVesselLocations: async () => {
        calls += 1;
        throw new Error(`WSDOT request failed: https://www.wsdot.wa.gov/Ferries/API/Vessels/rest/vessellocations?apiaccesscode=${ACCESS_CODE}`);
      },
    } as unknown as WsdotClient;

    const service = new CaptureService(db, client, captureConfig({ rawArchiveDir: directory }));
    service.start();
    await settle(120);
    await service.stop();
    await settle(30);

    const runs = (await db
      .prepare("SELECT * FROM capture_run WHERE task = 'vessel_locations' AND outcome = 'error'")
      .all()) as Array<Record<string, string>>;

    expect(calls).toBeGreaterThan(1);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      expect(run.error_detail).not.toContain(ACCESS_CODE);
      expect(run.error_detail).toContain('[redacted]');
      expect(run.error_category).toBe('unknown');
    }
  });

  it('reports status without any error detail', async () => {
    const client = { getVesselLocations: async () => [vessel()] } as unknown as WsdotClient;
    const service = new CaptureService(db, client, captureConfig({ rawArchiveDir: directory }));
    service.start();
    await settle(60);
    await service.stop();

    const status = JSON.stringify((await service.status()));
    expect(status).not.toContain(ACCESS_CODE);
    expect(status).toContain('vessel_locations');
  });

  it('refuses to start against fixtures unless explicitly allowed', async () => {
    const config = { ...captureConfig({ rawArchiveDir: directory }), dataSource: 'fixture' as const };
    const client = { getVesselLocations: async () => [vessel()] } as unknown as WsdotClient;
    const service = new CaptureService(db, client, config);
    service.start();
    await service.stop();

    expect(db.prepare('SELECT COUNT(*) AS total FROM capture_run').get()).toEqual({ total: 0 });
  });
});
