import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { openDatabase, type Db } from '../src/db/database';
import { DatabaseSailingHistory, MAX_HISTORY_DAYS, type RecordedLeg, type RecordedSpace, type SailingHistory } from '../src/history/sailingHistory';

const SEATTLE = 7;
const BAINBRIDGE = 3;
const DEPARTURE = '2026-09-01T18:00:00.000Z';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => db.close());

interface ObservationInput {
  departure?: string;
  arrivingTerminalId?: number;
  capturedAt: string;
  driveUp?: number | null;
  reservable?: number | null;
  max?: number | null;
  cancelled?: number;
}

function observe(inputs: ObservationInput[]): void {
  const insert = db.prepare(`INSERT INTO sailing_space_observation (
    captured_at, departing_terminal_id, departing_terminal_name, arriving_terminal_id, arriving_terminal_name,
    departure, vessel_id, vessel_name, is_cancelled, drive_up_space_count, reservable_space_count,
    max_space_count, observation_kind, service_date, weekday, hour_local
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const input of inputs) {
    insert.run(
      input.capturedAt,
      SEATTLE,
      'Seattle',
      input.arrivingTerminalId ?? BAINBRIDGE,
      'Bainbridge Island',
      input.departure ?? DEPARTURE,
      1,
      'Tacoma',
      input.cancelled ?? 0,
      input.driveUp === undefined ? 100 : input.driveUp,
      input.reservable === undefined ? null : input.reservable,
      input.max === undefined ? 202 : input.max,
      'departure',
      '2026-09-01',
      2,
      11,
    );
  }
}

function read(arrivingId = BAINBRIDGE): Map<string, RecordedSpace> {
  return new DatabaseSailingHistory(db).recordedSpaces(
    SEATTLE,
    arrivingId,
    '2026-09-01T12:00:00.000Z',
    '2026-09-02T06:00:00.000Z',
  );
}

interface LegInput {
  scheduledDeparture?: string | null;
  departedAt: string;
  dockArrivalAt?: string | null;
  delayMinutes?: number | null;
  confidence?: string;
  exclusionReason?: string | null;
  vesselId?: number;
}

function logLeg(inputs: LegInput[]): void {
  const insert = db.prepare(`INSERT INTO sailing_leg (
    vessel_id, vessel_name, departing_terminal_id, arriving_terminal_id, scheduled_departure,
    departed_at, dock_arrival_at, departure_delay_minutes, complete, confidence, exclusion_reason,
    service_date, weekday, hour_local
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '2026-09-01', 2, 11)`);

  inputs.forEach((input, index) => insert.run(
    input.vesselId ?? index + 1,
    'Tacoma',
    SEATTLE,
    BAINBRIDGE,
    input.scheduledDeparture === undefined ? DEPARTURE : input.scheduledDeparture,
    input.departedAt,
    input.dockArrivalAt ?? null,
    input.delayMinutes === undefined ? 6 : input.delayMinutes,
    input.confidence ?? 'high',
    input.exclusionReason ?? null,
  ));
}

function readLegs(): Map<string, RecordedLeg> {
  return new DatabaseSailingHistory(db).recordedLegs(SEATTLE, BAINBRIDGE, '2026-09-01T12:00:00.000Z', '2026-09-02T06:00:00.000Z');
}

function snapshot(rows: Array<{ departingTime: string; serviceDate?: string; vesselName?: string | null }>): void {
  const insert = db.prepare(`INSERT INTO schedule_snapshot (
    captured_at, service_date, departing_terminal_id, arriving_terminal_id, departing_time, arriving_time, vessel_id, vessel_name, loading_rule
  ) VALUES ('2026-09-01T12:00:00.000Z', ?, ?, ?, ?, NULL, 1, ?, 3)`);

  for (const row of rows) {
    insert.run(row.serviceDate ?? '2026-09-01', SEATTLE, BAINBRIDGE, row.departingTime, row.vesselName === undefined ? 'Tacoma' : row.vesselName);
  }
}

function withdraw(departingTime: string): void {
  db.prepare(`UPDATE schedule_snapshot SET withdrawn_at = '2026-09-01T13:00:00.000Z' WHERE departing_time = ?`).run(departingTime);
}

describe('recorded sailing legs', () => {
  it('returns the actual departure and delay for a scheduled sailing', () => {
    logLeg([{ departedAt: '2026-09-01T18:06:00.000Z' }]);

    expect(readLegs().get(DEPARTURE)).toEqual({
      scheduledDeparture: DEPARTURE,
      actualDeparture: '2026-09-01T18:06:00.000Z',
      actualArrival: null,
      departureDelayMinutes: 6,
    });
  });

  // WSDOT publishes arriving_time on almost no route, so the observed dock arrival is the
  // only arrival the Sailings table can show.
  it('returns the observed dock arrival once the crossing finished', () => {
    logLeg([{ departedAt: '2026-09-01T18:06:00.000Z', dockArrivalAt: '2026-09-01T18:41:00.000Z' }]);

    expect(readLegs().get(DEPARTURE)?.actualArrival).toBe('2026-09-01T18:41:00.000Z');
  });

  it('skips a leg the rollup graded down or excluded', () => {
    logLeg([
      { departedAt: '2026-09-01T18:06:00.000Z', confidence: 'low' },
      { departedAt: '2026-09-01T18:07:00.000Z', exclusionReason: 'dwell_ceiling', vesselId: 2 },
    ]);

    expect(readLegs().size).toBe(0);
  });

  it('skips a leg that reads as leaving early, since the slot match must be wrong', () => {
    logLeg([{ departedAt: '2026-09-01T17:51:00.000Z', delayMinutes: -9 }]);

    expect(readLegs().size).toBe(0);
  });

  it('keeps the earliest leg when two vessels claim one departure', () => {
    logLeg([
      { departedAt: '2026-09-01T18:12:00.000Z', delayMinutes: 12, vesselId: 2 },
      { departedAt: '2026-09-01T18:04:00.000Z', delayMinutes: 4, vesselId: 3 },
    ]);

    expect(readLegs().get(DEPARTURE)?.departureDelayMinutes).toBe(4);
  });
});

describe('recorded days', () => {
  it('lists service dates newest first and caps the window', () => {
    const dates = Array.from({ length: MAX_HISTORY_DAYS + 3 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`);
    snapshot(dates.map((serviceDate) => ({ serviceDate, departingTime: `${serviceDate}T18:00:00.000Z` })));

    const listed = new DatabaseSailingHistory(db).serviceDates(SEATTLE, BAINBRIDGE);

    expect(listed).toHaveLength(MAX_HISTORY_DAYS);
    expect(listed[0]).toBe(dates[dates.length - 1]);
  });

  it('leaves a future day off the list, since the timetable arrives before the recording', () => {
    const day = (offsetHours: number) => new Date(Date.now() + offsetHours * 60 * 60 * 1000).toISOString().slice(0, 10);
    const past = day(-36);
    const future = day(36);
    snapshot([
      { serviceDate: past, departingTime: `${past}T18:00:00.000Z` },
      { serviceDate: future, departingTime: `${future}T18:00:00.000Z` },
    ]);

    expect(new DatabaseSailingHistory(db).serviceDates(SEATTLE, BAINBRIDGE)).toEqual([past]);
  });

  it('builds a day of sailings from the timetable, space and legs', () => {
    snapshot([{ departingTime: DEPARTURE }, { departingTime: '2026-09-01T19:00:00.000Z' }]);
    observe([{ capturedAt: '2026-09-01T17:50:00.000Z', driveUp: 12 }]);
    logLeg([{ departedAt: '2026-09-01T18:06:00.000Z' }]);

    const day = new DatabaseSailingHistory(db).daySailings(SEATTLE, BAINBRIDGE, '2026-09-01');

    expect(day).toHaveLength(2);
    expect(day[0]).toEqual(expect.objectContaining({
      departingTime: DEPARTURE,
      driveUpSpaceCount: 12,
      spaceSource: 'recorded',
      actualDeparture: '2026-09-01T18:06:00.000Z',
      departureDelayMinutes: 6,
    }));
    expect(day[1]).toEqual(expect.objectContaining({ spaceAvailable: false, spaceSource: null, actualDeparture: null }));
  });

  it('reports no sailings for a day capture never saw', () => {
    expect(new DatabaseSailingHistory(db).daySailings(SEATTLE, BAINBRIDGE, '2026-07-04')).toEqual([]);
  });

  it('hides a slot WSDOT stopped publishing', () => {
    snapshot([{ departingTime: DEPARTURE }, { departingTime: '2026-09-01T19:00:00.000Z' }]);
    withdraw('2026-09-01T19:00:00.000Z');

    const day = new DatabaseSailingHistory(db).daySailings(SEATTLE, BAINBRIDGE, '2026-09-01');

    expect(day.map((sailing) => sailing.departingTime)).toEqual([DEPARTURE]);
  });

  it('drops a day whose sailings were all withdrawn, rather than offering an empty one', () => {
    snapshot([{ serviceDate: '2026-08-30', departingTime: '2026-08-30T18:00:00.000Z' }, { departingTime: DEPARTURE }]);
    withdraw('2026-08-30T18:00:00.000Z');

    expect(new DatabaseSailingHistory(db).serviceDates(SEATTLE, BAINBRIDGE)).toEqual(['2026-09-01']);
  });
});

describe('recorded sailing space', () => {
  it('returns the last reading taken before the boat sailed', () => {
    observe([
      { capturedAt: '2026-09-01T17:00:00.000Z', driveUp: 150 },
      { capturedAt: '2026-09-01T17:50:00.000Z', driveUp: 12 },
    ]);

    expect(read().get(DEPARTURE)).toEqual(expect.objectContaining({
      driveUpSpaceCount: 12,
      maxSpaceCount: 202,
      observedAt: '2026-09-01T17:50:00.000Z',
      leadSeconds: 600,
    }));
  });

  it('ignores readings captured after the departure time', () => {
    observe([
      { capturedAt: '2026-09-01T17:50:00.000Z', driveUp: 12 },
      { capturedAt: '2026-09-01T18:30:00.000Z', driveUp: 0 },
    ]);

    expect(read().get(DEPARTURE)?.driveUpSpaceCount).toBe(12);
  });

  it('reports nothing for a departure outside the window', () => {
    observe([{ departure: '2026-08-20T18:00:00.000Z', capturedAt: '2026-08-20T17:50:00.000Z' }]);

    expect(read().size).toBe(0);
  });

  it('reports nothing when every reading landed after departure', () => {
    observe([{ capturedAt: '2026-09-01T18:05:00.000Z' }]);

    expect(read().size).toBe(0);
  });

  // WSDOT files a multi-destination sailing against the departing terminal and puts the real
  // destinations in ArrivalTerminalIDs, so capture stores that row as Seattle to Seattle.
  it('falls back to the multi-destination row when no exact destination was stored', () => {
    observe([{ arrivingTerminalId: SEATTLE, capturedAt: '2026-09-01T17:50:00.000Z', driveUp: 40 }]);

    expect(read().get(DEPARTURE)?.driveUpSpaceCount).toBe(40);
  });

  it('prefers the exact destination over the multi-destination row', () => {
    observe([
      { arrivingTerminalId: SEATTLE, capturedAt: '2026-09-01T17:55:00.000Z', driveUp: 40 },
      { arrivingTerminalId: BAINBRIDGE, capturedAt: '2026-09-01T17:50:00.000Z', driveUp: 12 },
    ]);

    expect(read().get(DEPARTURE)?.driveUpSpaceCount).toBe(12);
  });

  it('keeps departures apart', () => {
    observe([
      { departure: '2026-09-01T18:00:00.000Z', capturedAt: '2026-09-01T17:50:00.000Z', driveUp: 12 },
      { departure: '2026-09-01T19:00:00.000Z', capturedAt: '2026-09-01T18:50:00.000Z', driveUp: 88 },
    ]);

    const recorded = read();
    expect(recorded.get('2026-09-01T18:00:00.000Z')?.driveUpSpaceCount).toBe(12);
    expect(recorded.get('2026-09-01T19:00:00.000Z')?.driveUpSpaceCount).toBe(88);
  });
});

const fixtureNow = Date.parse('2026-09-01T18:30:00.000Z');

function testConfig(): AppConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    dataSource: 'fixture',
    rawInspector: false,
    capture: {
      enabled: false,
      allowFixtureSource: false,
      dbPath: ':memory:',
      rawArchiveDir: '',
      vesselIntervalMs: 30_000,
      spaceIntervalMs: 60_000,
      referenceIntervalMs: 21_600_000,
      scheduleIntervalMs: 21_600_000,
      rollupIntervalMs: 900_000,
      retentionDays: null,
      dwellCeilingMinutes: 120,
      dockDebounceSeconds: 120,
      minFreeDiskMb: 512,
      statusEnabled: true,
    },
  };
}

function stubHistory(spaces: RecordedSpace[], legs: RecordedLeg[] = []): SailingHistory {
  return {
    recordedSpaces: () => new Map(spaces.map((space) => [space.departure, space])),
    recordedLegs: () => new Map(legs.map((leg) => [leg.scheduledDeparture, leg])),
    serviceDates: () => [],
    daySailings: () => [],
  };
}

const recorded: RecordedSpace = {
  departure: DEPARTURE,
  vesselId: 1,
  vesselName: 'Tacoma',
  isCancelled: false,
  driveUpSpaceCount: 9,
  reservableSpaceCount: null,
  maxSpaceCount: 202,
  observedAt: '2026-09-01T17:57:00.000Z',
  leadSeconds: 180,
};

async function schedule(history?: SailingHistory) {
  const app = createApp(testConfig(), () => fixtureNow, undefined, history);
  const response = await request(app)
    .get('/api/schedule?departingTerminalId=7&arrivingTerminalId=3&onlyRemaining=false')
    .expect(200);
  return response.body.data as Array<Record<string, unknown>>;
}

describe('schedule backfill', () => {
  it('fills a sailed departure the live feed no longer carries', async () => {
    const sailing = (await schedule(stubHistory([recorded]))).find((entry) => entry.departingTime === DEPARTURE);

    expect(sailing).toEqual(expect.objectContaining({
      spaceAvailable: true,
      spaceSource: 'recorded',
      spaceObservedAt: '2026-09-01T17:57:00.000Z',
      spaceLeadSeconds: 180,
      driveUpSpaceCount: 9,
      maxSpaceCount: 202,
    }));
  });

  it('leaves a live sailing untouched', async () => {
    const overwrite = { ...recorded, departure: '2026-09-01T17:00:00.000Z', driveUpSpaceCount: 9 };
    const sailing = (await schedule(stubHistory([overwrite]))).find((entry) => entry.departingTime === overwrite.departure);

    expect(sailing).toEqual(expect.objectContaining({
      spaceSource: 'live',
      driveUpSpaceCount: 176,
      spaceObservedAt: null,
    }));
  });

  it('reports no space source without a capture database', async () => {
    const sailing = (await schedule()).find((entry) => entry.departingTime === DEPARTURE);

    expect(sailing).toEqual(expect.objectContaining({ spaceAvailable: false, spaceSource: null }));
  });

  it('attaches a delay to a sailing that still carries live space', async () => {
    const leg: RecordedLeg = { scheduledDeparture: '2026-09-01T17:00:00.000Z', actualDeparture: '2026-09-01T17:06:00.000Z', departureDelayMinutes: 6 };
    const sailing = (await schedule(stubHistory([], [leg]))).find((entry) => entry.departingTime === leg.scheduledDeparture);

    expect(sailing).toEqual(expect.objectContaining({
      spaceSource: 'live',
      actualDeparture: '2026-09-01T17:06:00.000Z',
      departureDelayMinutes: 6,
    }));
  });

  it('leaves the delay empty for a sailing with no recorded leg', async () => {
    const sailing = (await schedule(stubHistory([recorded]))).find((entry) => entry.departingTime === DEPARTURE);

    expect(sailing).toEqual(expect.objectContaining({ actualDeparture: null, departureDelayMinutes: null }));
  });
});

describe('history endpoints', () => {
  const app = () => createApp(testConfig(), () => fixtureNow, undefined, new DatabaseSailingHistory(db));

  it('serves the recorded days for a route', async () => {
    snapshot([{ departingTime: DEPARTURE }]);

    const response = await request(app()).get('/api/history/dates?departingTerminalId=7&arrivingTerminalId=3').expect(200);

    expect(response.body.data).toEqual(['2026-09-01']);
  });

  it('serves a recorded day of sailings', async () => {
    snapshot([{ departingTime: DEPARTURE }]);
    observe([{ capturedAt: '2026-09-01T17:50:00.000Z', driveUp: 12 }]);

    const response = await request(app()).get('/api/history/sailings?departingTerminalId=7&arrivingTerminalId=3&serviceDate=2026-09-01').expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toEqual(expect.objectContaining({ driveUpSpaceCount: 12, spaceSource: 'recorded' }));
  });

  it('rejects a malformed service date', async () => {
    await request(app()).get('/api/history/sailings?departingTerminalId=7&arrivingTerminalId=3&serviceDate=yesterday').expect(400);
  });

  it('returns 404 when capture is off', async () => {
    await request(createApp(testConfig(), () => fixtureNow)).get('/api/history/dates?departingTerminalId=7&arrivingTerminalId=3').expect(404);
    await request(createApp(testConfig(), () => fixtureNow)).get('/api/crossings').expect(404);
  });

  it('serves the measured crossings', async () => {
    logLeg([
      { departedAt: '2026-09-01T18:00:00.000Z', dockArrivalAt: '2026-09-01T18:34:00.000Z' },
      { departedAt: '2026-09-01T19:00:00.000Z', dockArrivalAt: '2026-09-01T19:35:00.000Z' },
      { departedAt: '2026-09-01T20:00:00.000Z', dockArrivalAt: '2026-09-01T20:36:00.000Z' },
    ]);
    db.prepare(`UPDATE sailing_leg
      SET crossing_minutes = (julianday(dock_arrival_at) - julianday(departed_at)) * 1440`).run();

    const crossingsApp = createApp(testConfig(), () => fixtureNow, undefined,
      new DatabaseSailingHistory(db, () => Date.parse('2026-09-02T00:00:00.000Z')));
    const response = await request(crossingsApp).get('/api/crossings').expect(200);

    expect(response.body.data).toContainEqual({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
      medianMinutes: 35,
      fastMinutes: 34,
      samples: 3,
      borrowed: false,
    });
  });
});
