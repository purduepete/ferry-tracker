import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database';
import { renderReport } from '../src/report/html';
import { collectReport, percentile } from '../src/report/metrics';

let db: Db;

beforeEach(async () => {
    db = openDatabase(':memory:');
    await db
        .prepare(
            "INSERT INTO terminal_reference (terminal_id, terminal_name, updated_at) VALUES (7, 'Seattle', '2026-09-01T00:00:00.000Z')"
        )
        .run();
    await db
        .prepare(
            "INSERT INTO terminal_reference (terminal_id, terminal_name, updated_at) VALUES (3, 'Bainbridge Island', '2026-09-01T00:00:00.000Z')"
        )
        .run();
});
afterEach(() => db.close());

async function run(outcome: string, minute: number): Promise<void> {
    await db
        .prepare(
            `INSERT INTO capture_run (task, started_at, outcome, service_date)
    VALUES ('vessel_locations', ?, ?, '2026-09-01')`
        )
        .run(new Date(Date.parse('2026-09-01T15:00:00.000Z') + minute * 60_000).toISOString(), outcome);
}

async function leg(overrides: Record<string, unknown> = {}): Promise<void> {
    const row = {
        departed_at: '2026-09-01T16:00:00.000Z',
        departure_delay_minutes: 4,
        crossing_minutes: 35,
        load_minutes: 12,
        confidence: 'high',
        exclusion_reason: null,
        load_exclusion_reason: null,
        complete: 1,
        ...overrides,
    };

    await db
        .prepare(
            `INSERT INTO sailing_leg (
    vessel_id, vessel_name, departing_terminal_id, arriving_terminal_id, departed_at,
    dock_arrival_at, departure_delay_minutes, crossing_minutes, load_minutes,
    complete, confidence, exclusion_reason, load_exclusion_reason, service_date, weekday, hour_local
  ) VALUES (1, 'Tacoma', 7, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-01', 2, 9)`
        )
        .run(
            row.departed_at,
            '2026-09-01T16:35:00.000Z',
            row.departure_delay_minutes,
            row.crossing_minutes,
            row.load_minutes,
            row.complete,
            row.confidence,
            row.exclusion_reason,
            row.load_exclusion_reason
        );
}

describe('percentile', () => {
    it('reports nothing for an empty set', () => {
        expect(percentile([], 0.5)).toBeNull();
    });

    it('uses nearest rank without mutating the input', () => {
        const values = [30, 10, 20, 40];
        expect(percentile(values, 0.5)).toBe(20);
        expect(percentile(values, 0.9)).toBe(40);
        expect(values).toEqual([30, 10, 20, 40]);
    });
});

describe('capture report metrics', () => {
    it('measures the skip rate and the gap between real changes', async () => {
        await run('success', 0);
        await run('skipped_unchanged', 1);
        await run('skipped_unchanged', 2);
        await run('success', 3);

        const [task] = (await collectReport(db, ':memory:', { vessel_locations: 60_000 })).cadence;

        expect(task.changed).toBe(2);
        expect(task.unchanged).toBe(2);
        expect(task.skipRatio).toBe(0.5);
        expect(task.medianChangeGapSeconds).toBe(180);
        expect(task.intervalSeconds).toBe(60);
    });

    it('names routes from the terminal reference table', async () => {
        await leg();
        const data = await collectReport(db, ':memory:');

        expect(data.crossings[0].route).toBe('Seattle to Bainbridge Island');
        expect(data.crossings[0].medianMinutes).toBe(35);
        expect(data.loads[0].medianMinutes).toBe(12);
    });

    it('leaves low confidence legs out of the delay summary but still counts them', async () => {
        await leg({ departure_delay_minutes: 4 });
        await leg({
            departed_at: '2026-09-01T17:00:00.000Z',
            departure_delay_minutes: 90,
            confidence: 'low',
            exclusion_reason: 'missing_departure',
        });

        const data = await collectReport(db, ':memory:');

        expect(data.delayExcluded).toBe(1);
        expect(data.delays).toHaveLength(1);
        expect(data.delays[0].medianMinutes).toBe(4);
        expect(data.delays[0].onTimePct).toBe(100);
    });

    it('summarizes leg trust by confidence and reason', async () => {
        await leg();
        await leg({ departed_at: '2026-09-01T17:00:00.000Z', confidence: 'low', load_exclusion_reason: 'service_gap' });

        const data = await collectReport(db, ':memory:');

        expect(data.confidence).toEqual(
            expect.arrayContaining([
                { label: 'high', legs: 1 },
                { label: 'low', legs: 1 },
            ])
        );
        expect(data.loadExclusions).toEqual(
            expect.arrayContaining([
                { label: 'none', legs: 1 },
                { label: 'service_gap', legs: 1 },
            ])
        );
    });
});

describe('capture report html', () => {
    it('renders an empty database without throwing', async () => {
        const html = renderReport(await collectReport(db, 'C:\\data\\ferry.db'));

        expect(html).toContain('Ferry capture report');
        expect(html).toContain('No rows yet.');
        expect(html).toContain('Not enough polls yet to judge the interval.');
    });

    it('ships both themes and honours the system preference', async () => {
        const html = renderReport(await collectReport(db, ':memory:'));

        expect(html).toContain('html[data-theme=dark]');
        expect(html).toContain('html[data-theme=light]');
        expect(html).toContain('prefers-color-scheme: light');
        expect(html).toContain("localStorage.getItem('ferry-report-theme')");
    });

    it('calls out a poll interval that is too frequent', async () => {
        await run('success', 0);
        for (let minute = 1; minute <= 9; minute += 1) await run('skipped_unchanged', minute);

        const html = renderReport(await collectReport(db, ':memory:', { vessel_locations: 30_000 }));

        expect(html).toContain('Vessel polling is too frequent');
        expect(html).toContain('90% of polls');
    });

    it('escapes text that came from the database', async () => {
        await db
            .prepare(
                "INSERT INTO terminal_reference (terminal_id, terminal_name, updated_at) VALUES (9, '<script>x</script>', '2026-09-01T00:00:00.000Z')"
            )
            .run();
        await leg({ departed_at: '2026-09-01T18:00:00.000Z' });
        await db
            .prepare(
                `INSERT INTO sailing_leg (
      vessel_id, vessel_name, departing_terminal_id, arriving_terminal_id, departed_at,
      dock_arrival_at, crossing_minutes, complete, confidence, service_date, weekday, hour_local
    ) VALUES (2, 'X', 9, 7, '2026-09-01T19:00:00.000Z', '2026-09-01T19:30:00.000Z', 30, 1, 'high', '2026-09-01', 2, 12)`
            )
            .run();

        const html = renderReport(await collectReport(db, ':memory:'));

        expect(html).not.toContain('<script>x</script>');
        expect(html).toContain('&#60;script&#62;');
    });
});
