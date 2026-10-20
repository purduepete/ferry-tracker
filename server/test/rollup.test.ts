import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database';
import { runLegRollup } from '../src/rollup/legRollup';

const options = { dwellCeilingMinutes: 120, dockDebounceSeconds: 120 };

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

async function observe(inputs: ObservationInput[]): Promise<void> {
    const insert = db.prepare(`INSERT INTO vessel_observation (
    vessel_id, vessel_name, source_timestamp, captured_at, content_hash,
    departing_terminal_id, arriving_terminal_id, in_service, at_dock, left_dock,
    scheduled_departure, op_route_abbrev
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const input of inputs) {
        clock += 1;
        await insert.run(
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
            input.route ?? '["sea-bi"]'
        );
    }
}

async function legs(): Promise<Array<Record<string, string | number | null>>> {
    return (await db.prepare('SELECT * FROM sailing_leg ORDER BY departed_at').all()) as Array<
        Record<string, string | number | null>
    >;
}

describe('leg state machine', () => {
    it('builds one complete leg from a dock, transit, dock sequence', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(8) },
            { minute: 20, atDock: 0, leftDock: at(8) },
            { minute: 40, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(await legs()).toHaveLength(1);
        expect(leg.departed_at).toBe(at(8));
        expect(leg.dock_arrival_at).toBe(at(40));
        expect(leg.crossing_minutes).toBe(32);
        expect(leg.complete).toBe(1);
        expect(leg.confidence).toBe('high');
        expect(leg.exclusion_reason).toBeNull();
    });

    it('records the dwell as load time when the previous arrival is at the same terminal', async () => {
        await observe([
            { minute: 0, atDock: 1, departing: 7, arriving: 3 },
            { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10) },
            { minute: 40, atDock: 1, departing: 3, arriving: 7 },
            { minute: 55, atDock: 0, departing: 3, arriving: 7, leftDock: at(55) },
            { minute: 90, atDock: 1, departing: 7, arriving: 3 },
        ]);

        await runLegRollup(db, options);
        const [, second] = await legs();

        expect(second.previous_arrival_at).toBe(at(40));
        expect(second.load_minutes).toBe(15);
        expect(second.load_exclusion_reason).toBeNull();
    });

    it('opens a low confidence leg when the vessel is first seen mid crossing', async () => {
        await observe([
            { minute: 0, atDock: 0 },
            { minute: 10, atDock: 0 },
            { minute: 25, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(leg.confidence).toBe('low');
        expect(leg.exclusion_reason).toBe('missing_departure');
        expect(leg.load_minutes).toBeNull();
        expect(leg.load_exclusion_reason).toBe('missing_previous_arrival');
        expect(leg.complete).toBe(1);
    });

    it('splits a dock visit shorter than the poll interval into two legs', async () => {
        await observe([
            { minute: 0, atDock: 1, departing: 7, arriving: 3 },
            { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10) },
            { minute: 40, atDock: 0, departing: 3, arriving: 7, leftDock: at(38) },
            { minute: 70, atDock: 1, departing: 7, arriving: 3 },
        ]);

        await runLegRollup(db, options);
        const rows = await legs();

        expect(rows).toHaveLength(2);
        expect(rows[0].exclusion_reason).toBe('short_dock');
        expect(rows[0].dock_arrival_at).toBe(at(38));
        expect(rows[1].departed_at).toBe(at(38));
        expect(rows[1].load_exclusion_reason).toBe('short_dock');
    });

    it('adopts a settled left dock stamp instead of splitting the crossing', async () => {
        await observe([
            { minute: 0, atDock: 1, scheduledDeparture: at(5) },
            { minute: 10, atDock: 0, leftDock: at(10), scheduledDeparture: at(5) },
            { minute: 10.5, atDock: 0, leftDock: at(10.5), scheduledDeparture: at(5) },
            { minute: 20, atDock: 0, leftDock: at(10.5), scheduledDeparture: at(5) },
            { minute: 40, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const rows = await legs();

        expect(rows).toHaveLength(1);
        expect(rows[0].departed_at).toBe(at(10.5));
        expect(rows[0].dock_arrival_at).toBe(at(40));
        expect(rows[0].confidence).toBe('high');
        expect(rows[0].exclusion_reason).toBeNull();
    });

    it('still splits when the left dock stamp jumps a turnaround ahead on the same route', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 40, atDock: 0, leftDock: at(38) },
            { minute: 70, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const rows = await legs();

        expect(rows).toHaveLength(2);
        expect(rows[0].exclusion_reason).toBe('short_dock');
        expect(rows[0].dock_arrival_at).toBe(at(38));
        expect(rows[1].departed_at).toBe(at(38));
    });

    it('keeps the original departure when the left dock stamp moves backward', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 20, atDock: 0, leftDock: at(2) },
            { minute: 30, atDock: 0, leftDock: at(2) },
            { minute: 40, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const rows = await legs();

        expect(rows).toHaveLength(1);
        expect(rows[0].departed_at).toBe(at(10));
        expect(rows[0].exclusion_reason).toBeNull();
    });

    it('takes a forward correction that follows a backward one', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 20, atDock: 0, leftDock: at(2) },
            { minute: 30, atDock: 0, leftDock: at(12) },
            { minute: 40, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const rows = await legs();

        expect(rows).toHaveLength(1);
        expect(rows[0].departed_at).toBe(at(12));
        expect(rows[0].exclusion_reason).toBeNull();
    });

    it('breaks continuity across an out of service gap', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 20, atDock: 0, inService: 0 },
            { minute: 30, atDock: 1 },
            { minute: 45, atDock: 0, leftDock: at(45) },
            { minute: 80, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const rows = await legs();

        expect(rows[0].exclusion_reason).toBe('out_of_service');
        expect(rows[0].complete).toBe(0);
        expect(rows[1].load_minutes).toBeNull();
        expect(rows[1].load_exclusion_reason).toBe('service_gap');
    });

    it('does not trust the dwell of a vessel already docked when the window opens', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 40, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(leg.load_minutes).toBeNull();
        expect(leg.load_exclusion_reason).toBe('unobserved_arrival');
    });

    it('does not claim load time across an overnight tie up', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 40, atDock: 1, departing: 3, arriving: 7 },
            { minute: 600, atDock: 0, departing: 3, arriving: 7, leftDock: at(600) },
            { minute: 640, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const [, second] = await legs();

        expect(second.load_minutes).toBeNull();
        expect(second.load_exclusion_reason).toBe('dwell_exceeds_ceiling');
    });

    it('drops load time when the vessel departs from a terminal it never arrived at', async () => {
        await observe([
            { minute: 0, atDock: 1, departing: 7, arriving: 3 },
            { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10) },
            { minute: 40, atDock: 1, departing: 3, arriving: 7 },
            { minute: 55, atDock: 0, departing: 9, arriving: 7, leftDock: at(55) },
            { minute: 90, atDock: 1, departing: 7, arriving: 9 },
        ]);

        await runLegRollup(db, options);
        const [, second] = await legs();

        expect(second.load_exclusion_reason).toBe('terminal_discontinuity');
    });

    // Replayed from the Tacoma 15:00 Bainbridge to Seattle sailing on 2026-09-12. The feed never
    // reported the Seattle dock, so the leg stayed open through the stop and the crossing back and
    // recorded a 93 minute arrival at Seattle that was really the boat docking at Bainbridge.
    it('excludes a leg that docks somewhere other than its own destination', async () => {
        await observe([
            { minute: 0, atDock: 1, departing: 3, arriving: 7 },
            { minute: 18, atDock: 0, departing: 3, arriving: 7, leftDock: at(18) },
            { minute: 50, atDock: 0, departing: 3, arriving: 7 },
            { minute: 80, atDock: 0, departing: 3, arriving: 7 },
            { minute: 93, atDock: 1, departing: 3, arriving: 7 },
            { minute: 100, atDock: 1, departing: 3, arriving: 7 },
            { minute: 110, atDock: 1, departing: 3, arriving: 7 },
        ]);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(await legs()).toHaveLength(1);
        expect(leg.dock_arrival_at).toBe(at(93));
        expect(leg.arriving_terminal_id).toBe(3);
        expect(leg.confidence).toBe('low');
        expect(leg.exclusion_reason).toBe('terminal_discontinuity');
    });

    it('keeps a leg that docks at its own destination once the feed has settled', async () => {
        await observe([
            { minute: 0, atDock: 1, departing: 7, arriving: 3 },
            { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10) },
            { minute: 40, atDock: 1, departing: 3, arriving: 7 },
            { minute: 50, atDock: 1, departing: 3, arriving: 7 },
            { minute: 60, atDock: 1, departing: 3, arriving: 7 },
        ]);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(leg.arriving_terminal_id).toBe(3);
        expect(leg.confidence).toBe('high');
        expect(leg.exclusion_reason).toBeNull();
    });

    it('uses the feed scheduled departure to measure lateness', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(12), scheduledDeparture: at(5) },
            { minute: 40, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(leg.scheduled_departure_source).toBe('feed');
        expect(leg.departure_delay_minutes).toBe(7);
    });

    it('drops a feed slot later than the departure it would grade', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(3), scheduledDeparture: at(12) },
            { minute: 40, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(leg.scheduled_departure).toBeNull();
        expect(leg.departure_delay_minutes).toBeNull();
    });

    it('falls back to an earlier timetable slot when the feed slot is in the future', async () => {
        await db
            .prepare(
                `INSERT INTO schedule_snapshot (
      captured_at, service_date, departing_terminal_id, arriving_terminal_id, departing_time, arriving_time
    ) VALUES (?, '2026-09-01', 7, 3, ?, ?)`
            )
            .run(at(0), at(60), at(95));

        await observe([
            { minute: 5, atDock: 1, departing: 7, arriving: 3 },
            { minute: 65, atDock: 0, departing: 7, arriving: 3, leftDock: at(65), scheduledDeparture: at(120) },
            { minute: 100, atDock: 1, departing: 3, arriving: 7 },
        ]);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(leg.scheduled_departure_source).toBe('schedule_snapshot');
        expect(leg.departure_delay_minutes).toBe(5);
    });

    it('matches the timetable slot nearest the dock arrival, not the late departure', async () => {
        await db
            .prepare(
                `INSERT INTO schedule_snapshot (
      captured_at, service_date, departing_terminal_id, arriving_terminal_id, departing_time, arriving_time
    ) VALUES (?, '2026-09-01', 7, 3, ?, ?)`
            )
            .run(at(0), at(20), at(55));
        await db
            .prepare(
                `INSERT INTO schedule_snapshot (
      captured_at, service_date, departing_terminal_id, arriving_terminal_id, departing_time, arriving_time
    ) VALUES (?, '2026-09-01', 7, 3, ?, ?)`
            )
            .run(at(0), at(80), at(115));

        await observe([
            { minute: 5, atDock: 1, departing: 7, arriving: 3 },
            { minute: 65, atDock: 0, departing: 7, arriving: 3, leftDock: at(65) },
            { minute: 100, atDock: 1, departing: 3, arriving: 7 },
        ]);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(leg.scheduled_departure_source).toBe('schedule_snapshot');
        expect(leg.scheduled_departure).toBe(at(20));
        expect(leg.departure_delay_minutes).toBe(45);
    });

    it('still pairs a leg to a slot that was withdrawn from the timetable', async () => {
        // The withdraw marker is why the reconcile keeps the row instead of deleting it: a boat can
        // run a sailing WSDOT already pulled from the published schedule.
        await db
            .prepare(
                `INSERT INTO schedule_snapshot (
      captured_at, service_date, departing_terminal_id, arriving_terminal_id, departing_time, arriving_time, withdrawn_at
    ) VALUES (?, '2026-09-01', 7, 3, ?, ?, ?)`
            )
            .run(at(0), at(60), at(95), at(30));

        await observe([
            { minute: 5, atDock: 1, departing: 7, arriving: 3 },
            { minute: 65, atDock: 0, departing: 7, arriving: 3, leftDock: at(65) },
            { minute: 100, atDock: 1, departing: 3, arriving: 7 },
        ]);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(leg.scheduled_departure_source).toBe('schedule_snapshot');
        expect(leg.scheduled_departure).toBe(at(60));
    });

    it('buckets a spring forward departure on the correct Pacific hour', async () => {
        const insert = db.prepare(`INSERT INTO vessel_observation (
      vessel_id, vessel_name, source_timestamp, captured_at, content_hash,
      departing_terminal_id, arriving_terminal_id, in_service, at_dock, left_dock
    ) VALUES (?, 'Tacoma', ?, ?, ?, 7, 3, 1, ?, ?)`);
        await insert.run(1, '2026-03-08T09:50:00.000Z', '2026-03-08T09:50:00.000Z', 'a', 1, null);
        await insert.run(1, '2026-03-08T10:10:00.000Z', '2026-03-08T10:10:00.000Z', 'b', 0, '2026-03-08T10:05:00.000Z');
        await insert.run(1, '2026-03-08T10:45:00.000Z', '2026-03-08T10:45:00.000Z', 'c', 1, null);

        await runLegRollup(db, options);
        const [leg] = await legs();

        expect(leg.service_date).toBe('2026-03-08');
        expect(leg.hour_local).toBe(3);
        expect(leg.weekday).toBe(0);
    });

    it('finishes an incomplete leg on the next pass without duplicating it', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
        ]);
        await runLegRollup(db, options);
        expect((await legs())[0].complete).toBe(0);

        await observe([{ minute: 40, atDock: 1 }]);
        await runLegRollup(db, options);

        const rows = await legs();
        expect(rows).toHaveLength(1);
        expect(rows[0].complete).toBe(1);
        expect(rows[0].crossing_minutes).toBe(30);
    });

    it('produces the same legs after sailing_leg is dropped and recomputed', async () => {
        await observe([
            { minute: 0, atDock: 1, departing: 7, arriving: 3 },
            { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10) },
            { minute: 40, atDock: 1, departing: 3, arriving: 7 },
            { minute: 55, atDock: 0, departing: 3, arriving: 7, leftDock: at(55) },
            { minute: 90, atDock: 1, departing: 7, arriving: 3 },
        ]);

        await runLegRollup(db, options);
        const first = (await legs()).map((row) => ({ ...row, id: null }));

        await db.prepare('DELETE FROM sailing_leg').run();
        await runLegRollup(db, options);
        const second = (await legs()).map((row) => ({ ...row, id: null }));

        expect(second).toEqual(first);
    });

    it('keeps a watermark no later than the earliest safe replay point', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 40, atDock: 1 },
            { minute: 50, atDock: 0, leftDock: at(50), vesselId: 2 },
            { minute: 80, atDock: 1, vesselId: 2 },
        ]);

        const result = await runLegRollup(db, options);
        const stored = db.prepare("SELECT watermark FROM rollup_state WHERE name = 'sailing_leg'").get() as {
            watermark: string | null;
        };

        expect(result.vessels).toBe(2);
        expect(stored.watermark).toBe(result.watermark);
        expect(result.watermark).not.toBeNull();
    });
});

describe('dock state debounce', () => {
    // Replayed from the Tacoma 07:05 Seattle to Bainbridge sailing on 2026-09-03, where
    // AtDock flipped three times over three minutes before the boat actually left.
    it('ignores AtDock blips and takes the departure from the settled reading', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 9.5, atDock: 1 },
            { minute: 10, atDock: 0 },
            { minute: 10.5, atDock: 1 },
            { minute: 15.6, atDock: 0, leftDock: at(15.6) },
            { minute: 16.1, atDock: 0, leftDock: at(16) },
            { minute: 16.8, atDock: 1 },
            { minute: 17.3, atDock: 1 },
            { minute: 17.5, atDock: 0, leftDock: at(17.5) },
            { minute: 18.2, atDock: 1 },
            { minute: 18.8, atDock: 0, leftDock: at(18.4) },
            { minute: 25, atDock: 0, leftDock: at(18.4) },
            { minute: 50, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const rows = await legs();

        expect(rows).toHaveLength(1);
        expect(rows[0].departed_at).toBe(at(18.4));
        expect(rows[0].dock_arrival_at).toBe(at(50));
        expect(rows[0].crossing_minutes).toBe(31.6);
        expect(rows[0].confidence).toBe('high');
    });

    it('keeps a genuine crossing that lasts longer than the window', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 13, atDock: 1 },
            { minute: 40, atDock: 0, leftDock: at(40) },
            { minute: 70, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const rows = await legs();

        expect(rows).toHaveLength(2);
        expect(rows[0].departed_at).toBe(at(10));
        expect(rows[0].dock_arrival_at).toBe(at(13));
        expect(rows[1].departed_at).toBe(at(40));
    });

    it('leaves a lone reading before a long poll gap alone', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 40, atDock: 1 },
            { minute: 62, atDock: 0, leftDock: at(62) },
            { minute: 95, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const rows = await legs();

        expect(rows).toHaveLength(2);
        expect(rows[0].dock_arrival_at).toBe(at(40));
        expect(rows[1].departed_at).toBe(at(62));
    });

    it('never absorbs a blip across an out of service gap', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 40, atDock: 1 },
            { minute: 40.5, atDock: 0, inService: 0 },
            { minute: 41, atDock: 1 },
            { minute: 60, atDock: 0, leftDock: at(60) },
            { minute: 95, atDock: 1 },
        ]);

        await runLegRollup(db, options);
        const rows = await legs();

        expect(rows[0].dock_arrival_at).toBe(at(40));
        expect(rows[1].load_exclusion_reason).toBe('service_gap');
    });

    it('records no leg at all when the vessel only ever flickered', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 10.5, atDock: 1 },
            { minute: 20, atDock: 0, leftDock: at(20) },
            { minute: 20.6, atDock: 1 },
            { minute: 40, atDock: 1 },
        ]);

        await runLegRollup(db, options);

        expect(await legs()).toHaveLength(0);
    });

    // A run at the end of the batch has no successor yet, so the debounce cannot know whether
    // it held. The next pass sees the successor and may collapse it, so the incremental result
    // has to converge on what a single pass over everything would have produced.
    it('settles a trailing blip once the next pass sees what followed it', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
        ]);
        await runLegRollup(db, options);
        // Nothing has closed, so the blip is still standing as an open leg.
        expect(await legs()).toHaveLength(1);
        expect((await legs())[0].complete).toBe(0);

        await observe([
            { minute: 10.5, atDock: 1 },
            { minute: 30, atDock: 0, leftDock: at(30) },
            { minute: 62, atDock: 1 },
        ]);
        await runLegRollup(db, options);

        const rows = await legs();
        expect(rows).toHaveLength(1);
        expect(rows[0].departed_at).toBe(at(30));
        expect(rows[0].dock_arrival_at).toBe(at(62));
        expect(rows[0].complete).toBe(1);
    });

    // An arrival the debounce has not judged yet cannot be written, because a complete leg
    // becomes the anchor that the next pass never reaches back past.
    it('holds a fresh arrival back until it has outlived the debounce window', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 20, atDock: 0, leftDock: at(10) },
            { minute: 21, atDock: 1 },
        ]);

        await runLegRollup(db, { ...options, now: BASE + 21.5 * 60_000 });

        const [leg] = await legs();
        expect(leg.departed_at).toBe(at(10));
        expect(leg.dock_arrival_at).toBeNull();
        expect(leg.complete).toBe(0);
    });

    it('writes the arrival on the pass that finds it settled', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 20, atDock: 0, leftDock: at(10) },
            { minute: 21, atDock: 1 },
        ]);
        await runLegRollup(db, { ...options, now: BASE + 21.5 * 60_000 });

        await runLegRollup(db, { ...options, now: BASE + 24 * 60_000 });

        const rows = await legs();
        expect(rows).toHaveLength(1);
        expect(rows[0].dock_arrival_at).toBe(at(21));
        expect(rows[0].complete).toBe(1);
    });

    it('never records a blip arrival that a later poll contradicts', async () => {
        await observe([
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 20, atDock: 0, leftDock: at(10) },
            { minute: 21, atDock: 1 },
        ]);
        await runLegRollup(db, { ...options, now: BASE + 21.5 * 60_000 });

        await observe([
            { minute: 22, atDock: 0, leftDock: at(10) },
            { minute: 40, atDock: 0, leftDock: at(10) },
            { minute: 50, atDock: 1 },
        ]);
        await runLegRollup(db, { ...options, now: BASE + 53 * 60_000 });

        const rows = await legs();
        expect(rows).toHaveLength(1);
        expect(rows[0].departed_at).toBe(at(10));
        expect(rows[0].dock_arrival_at).toBe(at(50));
        expect(rows[0].complete).toBe(1);
    });

    it('reaches the same legs whether replayed in one pass or many', async () => {
        const trace: Array<{ minute: number; atDock: number; leftDock?: string }> = [
            { minute: 0, atDock: 1 },
            { minute: 10, atDock: 0, leftDock: at(10) },
            { minute: 10.5, atDock: 1 },
            { minute: 15.6, atDock: 0, leftDock: at(15.6) },
            { minute: 16.8, atDock: 1 },
            { minute: 18.8, atDock: 0, leftDock: at(18.4) },
            { minute: 25, atDock: 0, leftDock: at(18.4) },
            { minute: 50, atDock: 1 },
            { minute: 62, atDock: 0, leftDock: at(62) },
            { minute: 95, atDock: 1 },
        ];
        const shape = (rows: Array<Record<string, string | number | null>>) =>
            rows.map((row) => ({
                departed_at: row.departed_at,
                dock_arrival_at: row.dock_arrival_at,
                crossing_minutes: row.crossing_minutes,
                complete: row.complete,
                confidence: row.confidence,
                exclusion_reason: row.exclusion_reason,
                load_minutes: row.load_minutes,
                load_exclusion_reason: row.load_exclusion_reason,
                previous_arrival_at: row.previous_arrival_at,
                scheduled_departure: row.scheduled_departure,
                scheduled_departure_source: row.scheduled_departure_source,
            }));

        await observe(trace);
        await runLegRollup(db, options);
        const wholeBatch = shape(await legs());

        await db.prepare('DELETE FROM sailing_leg').run();
        await db.prepare('DELETE FROM vessel_observation').run();
        for (const input of trace) {
            await observe([input]);
            await runLegRollup(db, options);
        }

        expect(shape(await legs())).toEqual(wholeBatch);
        expect(wholeBatch).toHaveLength(2);
    });

    it('keeps the dock turnaround when a later pass resumes from a stored leg', async () => {
        // The poll that reports the arrival still names the crossing that just ended, so the
        // departing terminal disagrees with where the boat was seen to dock.
        await observe([
            { minute: 0, atDock: 1, departing: 7, arriving: 3 },
            { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10) },
            { minute: 40, atDock: 1, departing: 7, arriving: 3 },
        ]);
        await runLegRollup(db, options);

        await observe([
            { minute: 50, atDock: 1, departing: 3, arriving: 7 },
            { minute: 60, atDock: 0, departing: 3, arriving: 7, leftDock: at(60) },
            { minute: 90, atDock: 1, departing: 3, arriving: 7 },
        ]);
        await runLegRollup(db, options);

        const [, second] = await legs();

        expect(second.previous_arrival_at).toBe(at(40));
        expect(second.load_minutes).toBe(20);
        expect(second.load_exclusion_reason).toBeNull();
    });
});

describe('analytical views', () => {
    it('reports both drive up and total fill with observation window columns', async () => {
        const departure = at(60);
        await db
            .prepare(
                `INSERT INTO sailing_space_departure (
      departing_terminal_id, arriving_terminal_id, departure, vessel_id,
      first_seen_at, last_seen_at, last_seen_before_departure, finalized, service_date, weekday, hour_local
    ) VALUES (7, 3, ?, 1, ?, ?, 1, 1, '2026-09-01', 2, 9)`
            )
            .run(departure, at(0), at(55));

        const insert = db.prepare(`INSERT INTO sailing_space_observation (
      captured_at, departing_terminal_id, departing_terminal_name, arriving_terminal_id, arriving_terminal_name,
      departure, vessel_id, vessel_name, is_cancelled, drive_up_space_count, reservable_space_count,
      max_space_count, observation_kind, service_date, weekday, hour_local
    ) VALUES (?, 7, 'Seattle', 3, 'Bainbridge Island', ?, 1, 'Tacoma', 0, ?, ?, 200, ?, '2026-09-01', 2, 9)`);
        await insert.run(at(0), departure, 120, 40, 'baseline');
        await insert.run(at(30), departure, 60, 20, 'change');
        await insert.run(at(55), departure, 30, 10, 'change');

        const [row] = (await db.prepare('SELECT * FROM v_sailing_fill').all()) as Array<Record<string, number>>;

        expect(row.observation_count).toBe(3);
        expect(row.min_drive_up_space).toBe(30);
        expect(row.min_total_open_space).toBe(40);
        expect(row.drive_up_pct_full).toBe(85);
        expect(row.total_pct_full).toBe(80);
        expect(row.last_seen_before_departure).toBe(1);
    });

    it('splits legs across the delay, crossing and load views', async () => {
        await observe([
            { minute: 0, atDock: 1, departing: 7, arriving: 3 },
            { minute: 10, atDock: 0, departing: 7, arriving: 3, leftDock: at(10), scheduledDeparture: at(8) },
            { minute: 40, atDock: 1, departing: 3, arriving: 7 },
            { minute: 55, atDock: 0, departing: 3, arriving: 7, leftDock: at(55), scheduledDeparture: at(50) },
            { minute: 90, atDock: 1, departing: 7, arriving: 3 },
        ]);
        await runLegRollup(db, options);

        const delays = (await db.prepare('SELECT * FROM v_departure_delay').all()) as Array<Record<string, number>>;
        const crossings = (await db.prepare('SELECT * FROM v_crossing_duration').all()) as Array<
            Record<string, number>
        >;
        const loads = (await db.prepare('SELECT * FROM v_load_duration').all()) as Array<Record<string, number>>;

        expect(delays.map((row) => row.departure_delay_minutes)).toEqual([2, 5]);
        expect(crossings.map((row) => row.crossing_minutes)).toEqual([30, 35]);
        expect(loads.map((row) => row.load_minutes)).toEqual([15]);
    });

    it('reports capture cadence by service date and outcome', async () => {
        const insert = db.prepare(`INSERT INTO capture_run (task, started_at, outcome, service_date)
      VALUES ('vessel_locations', ?, ?, '2026-09-01')`);
        await insert.run(at(0), 'success');
        await insert.run(at(1), 'skipped_unchanged');
        await insert.run(at(2), 'skipped_unchanged');

        const rows = (await db
            .prepare("SELECT outcome, runs FROM v_update_cadence WHERE service_date = '2026-09-01' ORDER BY outcome")
            .all()) as Array<{ outcome: string; runs: number }>;

        expect(rows).toEqual([
            { outcome: 'skipped_unchanged', runs: 2 },
            { outcome: 'success', runs: 1 },
        ]);
    });
});
