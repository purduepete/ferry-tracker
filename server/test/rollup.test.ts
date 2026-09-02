import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database';
import { runLegRollup } from '../src/rollup/legRollup';

const options = { dwellCeilingMinutes: 120 };

let db: Db;
let clock = 0;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = 0;
});
afterEach(() => db.close());

interface ObservationInput {
  minute: number;
  atDock: number | null;
  inService?: number;
  departing?: number | null;
  arriving?: number | null;
  leftDock?: string | null;
  scheduledDeparture?: string | null;
  route?: string | null;
  vesselId?: number;
}

const BASE = Date.parse('2026-09-01T15:00:00.000Z');

function at(minute: number): string {
  return new Date(BASE + minute * 60_000).toISOString();
}

function observe(inputs: ObservationInput[]): void {
  const insert = db.prepare(`INSERT INTO vessel_observation (
    vessel_id, vessel_name, source_timestamp, captured_at, content_hash,
    departing_terminal_id, arriving_terminal_id, in_service, at_dock, left_dock,
    scheduled_departure, op_route_abbrev
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const input of inputs) {
    clock += 1;
    insert.run(
      input.vesselId ?? 1,
      'Tacoma',
      at(input.minute),
      at(input.minute),
      `hash-${clock}`,
      input.departing === undefined ? 7 : input.departing,
      input.arriving === undefined ? 3 : input.arriving,
      input.inService ?? 1,
      input.atDock,
      input.leftDock ?? null,
      input.scheduledDeparture ?? null,
      input.route ?? '["sea-bi"]',
    );
  }
}

function legs(): Array<Record<string, string | number | null>> {
  return db.prepare('SELECT * FROM sailing_leg ORDER BY departed_at').all() as Array<Record<string, string | number | null>>;
}

describe('leg state machine', () => {
  it('builds one complete leg from a dock, transit, dock sequence', () => {
    observe([
      { minute: 0, atDock: 1 },
      { minute: 10, atDock: 0, leftDock: at(8) },
      { minute: 20, atDock: 0, leftDock: at(8) },
      { minute: 40, atDock: 1 },
    ]);

    runLegRollup(db, options);
    const [leg] = legs();

    expect(legs()).toHaveLength(1);
    expect(leg.departed_at).toBe(at(8));
    expect(leg.dock_arrival_at).toBe(at(40));
    expect(leg.crossing_minutes).toBe(32);
    expect(leg.complete).toBe(1);
    expect(leg.confidence).toBe('high');
    expect(leg.exclusion_reason).toBeNull();
  });

  it('records the dwell as load time when the previous arrival is at the same terminal', () => {
    observe([
      { minute: 0, atDock: 1, departing: 7, arriving: 3 },
      { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10) },
      { minute: 40, atDock: 1, departing: 3, arriving: 7 },
      { minute: 55, atDock: 0, departing: 3, arriving: 7, leftDock: at(55) },
      { minute: 90, atDock: 1, departing: 7, arriving: 3 },
    ]);

    runLegRollup(db, options);
    const [, second] = legs();

    expect(second.previous_arrival_at).toBe(at(40));
    expect(second.load_minutes).toBe(15);
    expect(second.load_exclusion_reason).toBeNull();
  });

  it('opens a low confidence leg when the vessel is first seen mid crossing', () => {
    observe([
      { minute: 0, atDock: 0 },
      { minute: 10, atDock: 0 },
      { minute: 25, atDock: 1 },
    ]);

    runLegRollup(db, options);
    const [leg] = legs();

    expect(leg.confidence).toBe('low');
    expect(leg.exclusion_reason).toBe('missing_departure');
    expect(leg.load_minutes).toBeNull();
    expect(leg.load_exclusion_reason).toBe('missing_previous_arrival');
    expect(leg.complete).toBe(1);
  });

  it('splits a dock visit shorter than the poll interval into two legs', () => {
    observe([
      { minute: 0, atDock: 1, departing: 7, arriving: 3 },
      { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10) },
      { minute: 40, atDock: 0, departing: 3, arriving: 7, leftDock: at(38) },
      { minute: 70, atDock: 1, departing: 7, arriving: 3 },
    ]);

    runLegRollup(db, options);
    const rows = legs();

    expect(rows).toHaveLength(2);
    expect(rows[0].exclusion_reason).toBe('short_dock');
    expect(rows[0].dock_arrival_at).toBe(at(38));
    expect(rows[1].departed_at).toBe(at(38));
    expect(rows[1].load_exclusion_reason).toBe('short_dock');
  });

  it('breaks continuity across an out of service gap', () => {
    observe([
      { minute: 0, atDock: 1 },
      { minute: 10, atDock: 0, leftDock: at(10) },
      { minute: 20, atDock: 0, inService: 0 },
      { minute: 30, atDock: 1 },
      { minute: 45, atDock: 0, leftDock: at(45) },
      { minute: 80, atDock: 1 },
    ]);

    runLegRollup(db, options);
    const rows = legs();

    expect(rows[0].exclusion_reason).toBe('out_of_service');
    expect(rows[0].complete).toBe(0);
    expect(rows[1].load_minutes).toBeNull();
    expect(rows[1].load_exclusion_reason).toBe('service_gap');
  });

  it('does not trust the dwell of a vessel already docked when the window opens', () => {
    observe([
      { minute: 0, atDock: 1 },
      { minute: 10, atDock: 0, leftDock: at(10) },
      { minute: 40, atDock: 1 },
    ]);

    runLegRollup(db, options);
    const [leg] = legs();

    expect(leg.load_minutes).toBeNull();
    expect(leg.load_exclusion_reason).toBe('unobserved_arrival');
  });

  it('does not claim load time across an overnight tie up', () => {
    observe([
      { minute: 0, atDock: 1 },
      { minute: 10, atDock: 0, leftDock: at(10) },
      { minute: 40, atDock: 1, departing: 3, arriving: 7 },
      { minute: 600, atDock: 0, departing: 3, arriving: 7, leftDock: at(600) },
      { minute: 640, atDock: 1 },
    ]);

    runLegRollup(db, options);
    const [, second] = legs();

    expect(second.load_minutes).toBeNull();
    expect(second.load_exclusion_reason).toBe('dwell_exceeds_ceiling');
  });

  it('drops load time when the vessel departs from a terminal it never arrived at', () => {
    observe([
      { minute: 0, atDock: 1, departing: 7, arriving: 3 },
      { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10) },
      { minute: 40, atDock: 1, departing: 3, arriving: 7 },
      { minute: 55, atDock: 0, departing: 9, arriving: 7, leftDock: at(55) },
      { minute: 90, atDock: 1, departing: 7, arriving: 9 },
    ]);

    runLegRollup(db, options);
    const [, second] = legs();

    expect(second.load_exclusion_reason).toBe('terminal_discontinuity');
  });

  it('uses the feed scheduled departure to measure lateness', () => {
    observe([
      { minute: 0, atDock: 1 },
      { minute: 10, atDock: 0, leftDock: at(12), scheduledDeparture: at(5) },
      { minute: 40, atDock: 1 },
    ]);

    runLegRollup(db, options);
    const [leg] = legs();

    expect(leg.scheduled_departure_source).toBe('feed');
    expect(leg.departure_delay_minutes).toBe(7);
  });

  it('matches the timetable slot nearest the dock arrival, not the late departure', () => {
    db.prepare(`INSERT INTO schedule_snapshot (
      captured_at, service_date, departing_terminal_id, arriving_terminal_id, departing_time, arriving_time
    ) VALUES (?, '2026-09-01', 7, 3, ?, ?)`).run(at(0), at(20), at(55));
    db.prepare(`INSERT INTO schedule_snapshot (
      captured_at, service_date, departing_terminal_id, arriving_terminal_id, departing_time, arriving_time
    ) VALUES (?, '2026-09-01', 7, 3, ?, ?)`).run(at(0), at(80), at(115));

    observe([
      { minute: 5, atDock: 1, departing: 7, arriving: 3 },
      { minute: 65, atDock: 0, departing: 7, arriving: 3, leftDock: at(65) },
      { minute: 100, atDock: 1, departing: 3, arriving: 7 },
    ]);

    runLegRollup(db, options);
    const [leg] = legs();

    expect(leg.scheduled_departure_source).toBe('schedule_snapshot');
    expect(leg.scheduled_departure).toBe(at(20));
    expect(leg.departure_delay_minutes).toBe(45);
  });

  it('buckets a spring forward departure on the correct Pacific hour', () => {
    const insert = db.prepare(`INSERT INTO vessel_observation (
      vessel_id, vessel_name, source_timestamp, captured_at, content_hash,
      departing_terminal_id, arriving_terminal_id, in_service, at_dock, left_dock
    ) VALUES (?, 'Tacoma', ?, ?, ?, 7, 3, 1, ?, ?)`);
    insert.run(1, '2026-03-08T09:50:00.000Z', '2026-03-08T09:50:00.000Z', 'a', 1, null);
    insert.run(1, '2026-03-08T10:10:00.000Z', '2026-03-08T10:10:00.000Z', 'b', 0, '2026-03-08T10:05:00.000Z');
    insert.run(1, '2026-03-08T10:45:00.000Z', '2026-03-08T10:45:00.000Z', 'c', 1, null);

    runLegRollup(db, options);
    const [leg] = legs();

    expect(leg.service_date).toBe('2026-03-08');
    expect(leg.hour_local).toBe(3);
    expect(leg.weekday).toBe(0);
  });

  it('finishes an incomplete leg on the next pass without duplicating it', () => {
    observe([
      { minute: 0, atDock: 1 },
      { minute: 10, atDock: 0, leftDock: at(10) },
    ]);
    runLegRollup(db, options);
    expect(legs()[0].complete).toBe(0);

    observe([{ minute: 40, atDock: 1 }]);
    runLegRollup(db, options);

    const rows = legs();
    expect(rows).toHaveLength(1);
    expect(rows[0].complete).toBe(1);
    expect(rows[0].crossing_minutes).toBe(30);
  });

  it('produces the same legs after sailing_leg is dropped and recomputed', () => {
    observe([
      { minute: 0, atDock: 1, departing: 7, arriving: 3 },
      { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10) },
      { minute: 40, atDock: 1, departing: 3, arriving: 7 },
      { minute: 55, atDock: 0, departing: 3, arriving: 7, leftDock: at(55) },
      { minute: 90, atDock: 1, departing: 7, arriving: 3 },
    ]);

    runLegRollup(db, options);
    const first = legs().map((row) => ({ ...row, id: null }));

    db.prepare('DELETE FROM sailing_leg').run();
    runLegRollup(db, options);
    const second = legs().map((row) => ({ ...row, id: null }));

    expect(second).toEqual(first);
  });

  it('keeps a watermark no later than the earliest safe replay point', () => {
    observe([
      { minute: 0, atDock: 1 },
      { minute: 10, atDock: 0, leftDock: at(10) },
      { minute: 40, atDock: 1 },
      { minute: 50, atDock: 0, leftDock: at(50), vesselId: 2 },
      { minute: 80, atDock: 1, vesselId: 2 },
    ]);

    const result = runLegRollup(db, options);
    const stored = db.prepare("SELECT watermark FROM rollup_state WHERE name = 'sailing_leg'").get() as {
      watermark: string | null;
    };

    expect(result.vessels).toBe(2);
    expect(stored.watermark).toBe(result.watermark);
    expect(result.watermark).not.toBeNull();
  });
});

describe('analytical views', () => {
  it('reports both drive up and total fill with observation window columns', () => {
    const departure = at(60);
    db.prepare(`INSERT INTO sailing_space_departure (
      departing_terminal_id, arriving_terminal_id, departure, vessel_id,
      first_seen_at, last_seen_at, last_seen_before_departure, finalized, service_date, weekday, hour_local
    ) VALUES (7, 3, ?, 1, ?, ?, 1, 1, '2026-09-01', 2, 9)`).run(departure, at(0), at(55));

    const insert = db.prepare(`INSERT INTO sailing_space_observation (
      captured_at, departing_terminal_id, departing_terminal_name, arriving_terminal_id, arriving_terminal_name,
      departure, vessel_id, vessel_name, is_cancelled, drive_up_space_count, reservable_space_count,
      max_space_count, observation_kind, service_date, weekday, hour_local
    ) VALUES (?, 7, 'Seattle', 3, 'Bainbridge Island', ?, 1, 'Tacoma', 0, ?, ?, 200, ?, '2026-09-01', 2, 9)`);
    insert.run(at(0), departure, 120, 40, 'baseline');
    insert.run(at(30), departure, 60, 20, 'change');
    insert.run(at(55), departure, 30, 10, 'change');

    const [row] = db.prepare('SELECT * FROM v_sailing_fill').all() as Array<Record<string, number>>;

    expect(row.observation_count).toBe(3);
    expect(row.min_drive_up_space).toBe(30);
    expect(row.min_total_open_space).toBe(40);
    expect(row.drive_up_pct_full).toBe(85);
    expect(row.total_pct_full).toBe(80);
    expect(row.last_seen_before_departure).toBe(1);
  });

  it('splits legs across the delay, crossing and load views', () => {
    observe([
      { minute: 0, atDock: 1, departing: 7, arriving: 3 },
      { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10), scheduledDeparture: at(8) },
      { minute: 40, atDock: 1, departing: 3, arriving: 7 },
      { minute: 55, atDock: 0, departing: 3, arriving: 7, leftDock: at(55), scheduledDeparture: at(50) },
      { minute: 90, atDock: 1, departing: 7, arriving: 3 },
    ]);
    runLegRollup(db, options);

    const delays = db.prepare('SELECT * FROM v_departure_delay').all() as Array<Record<string, number>>;
    const crossings = db.prepare('SELECT * FROM v_crossing_duration').all() as Array<Record<string, number>>;
    const loads = db.prepare('SELECT * FROM v_load_duration').all() as Array<Record<string, number>>;

    expect(delays.map((row) => row.departure_delay_minutes)).toEqual([2, 5]);
    expect(crossings.map((row) => row.crossing_minutes)).toEqual([30, 35]);
    expect(loads.map((row) => row.load_minutes)).toEqual([15]);
  });

  it('reports capture cadence by service date and outcome', () => {
    const insert = db.prepare(`INSERT INTO capture_run (task, started_at, outcome, service_date)
      VALUES ('vessel_locations', ?, ?, '2026-09-01')`);
    insert.run(at(0), 'success');
    insert.run(at(1), 'skipped_unchanged');
    insert.run(at(2), 'skipped_unchanged');

    const rows = db
      .prepare("SELECT outcome, runs FROM v_update_cadence WHERE service_date = '2026-09-01' ORDER BY outcome")
      .all() as Array<{ outcome: string; runs: number }>;

    expect(rows).toEqual([
      { outcome: 'skipped_unchanged', runs: 2 },
      { outcome: 'success', runs: 1 },
    ]);
  });
});
