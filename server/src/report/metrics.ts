import type { Db } from '../db/database.js';

export interface CadenceRow {
  task: string;
  changed: number;
  unchanged: number;
  errors: number;
  skipRatio: number | null;
  medianChangeGapSeconds: number | null;
  intervalSeconds: number | null;
}

export interface VesselRatioRow {
  vesselName: string;
  observations: number;
  distinctTimestamps: number;
  staleRatio: number | null;
}

export interface FillCell {
  weekday: number;
  hour: number;
  sailings: number;
  avgPctFull: number | null;
  maxPctFull: number | null;
}

export interface RouteFillRow {
  route: string;
  sailings: number;
  avgPctFull: number | null;
  busiestHour: number | null;
}

export interface DelayRow {
  hour: number;
  legs: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  onTimePct: number | null;
}

export interface DurationRow {
  route: string;
  legs: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  minMinutes: number | null;
  maxMinutes: number | null;
}

export interface QualityRow {
  label: string;
  legs: number;
}

export interface ReportData {
  generatedAt: Date;
  dbPath: string;
  window: { first: string | null; last: string | null };
  counts: Array<{ table: string; rows: number }>;
  cadence: CadenceRow[];
  vesselRatio: VesselRatioRow[];
  fillGrid: FillCell[];
  fillByRoute: RouteFillRow[];
  delays: DelayRow[];
  delayExcluded: number;
  crossings: DurationRow[];
  loads: DurationRow[];
  confidence: QualityRow[];
  exclusions: QualityRow[];
  loadExclusions: QualityRow[];
}

const ON_TIME_MINUTES = 5;

const TABLES = [
  'vessel_observation',
  'sailing_space_observation',
  'sailing_space_departure',
  'sailing_leg',
  'schedule_snapshot',
  'capture_run',
  'archive_file',
];

export function collectReport(db: Db, dbPath: string, intervals: Record<string, number> = {}): ReportData {
  const window = db.prepare('SELECT MIN(started_at) AS first, MAX(started_at) AS last FROM capture_run').get() as {
    first: string | null;
    last: string | null;
  };

  return {
    generatedAt: new Date(),
    dbPath,
    window,
    counts: TABLES.map((table) => ({
      table,
      rows: (db.prepare(`SELECT COUNT(*) AS rows FROM ${table}`).get() as { rows: number }).rows,
    })),
    cadence: cadence(db, intervals),
    vesselRatio: vesselRatio(db),
    fillGrid: fillGrid(db),
    fillByRoute: fillByRoute(db),
    delays: delays(db),
    delayExcluded: (db.prepare(
      "SELECT COUNT(*) AS n FROM v_departure_delay WHERE confidence = 'low' OR exclusion_reason IS NOT NULL",
    ).get() as { n: number }).n,
    crossings: durations(db, 'v_crossing_duration', 'crossing_minutes'),
    loads: durations(db, 'v_load_duration', 'load_minutes'),
    confidence: quality(db, 'confidence'),
    exclusions: quality(db, 'exclusion_reason'),
    loadExclusions: quality(db, 'load_exclusion_reason'),
  };
}

function cadence(db: Db, intervals: Record<string, number>): CadenceRow[] {
  const totals = db
    .prepare('SELECT task, outcome, SUM(runs) AS runs FROM v_update_cadence GROUP BY task, outcome')
    .all() as Array<{ task: string; outcome: string; runs: number }>;

  const tasks = [...new Set(totals.map((row) => row.task))].sort();
  return tasks.map((task) => {
    const of = (outcome: string) => totals.find((row) => row.task === task && row.outcome === outcome)?.runs ?? 0;
    const changed = of('success');
    const unchanged = of('skipped_unchanged') + of('skipped_overlap') + of('skipped_disk_space');
    const polls = changed + unchanged;

    const stamps = (db
      .prepare("SELECT started_at FROM capture_run WHERE task = ? AND outcome = 'success' ORDER BY started_at")
      .all(task) as Array<{ started_at: string }>).map((row) => Date.parse(row.started_at));
    const gaps = stamps.slice(1).map((value, index) => (value - stamps[index]) / 1000);

    return {
      task,
      changed,
      unchanged,
      errors: of('error'),
      skipRatio: polls > 0 ? unchanged / polls : null,
      medianChangeGapSeconds: percentile(gaps, 0.5),
      intervalSeconds: intervals[task] ? intervals[task] / 1000 : null,
    };
  });
}

function vesselRatio(db: Db): VesselRatioRow[] {
  return (db.prepare('SELECT * FROM v_vessel_update_ratio ORDER BY vessel_name').all() as Array<{
    vessel_name: string;
    observations: number;
    distinct_source_timestamps: number;
  }>).map((row) => ({
    vesselName: row.vessel_name,
    observations: row.observations,
    distinctTimestamps: row.distinct_source_timestamps,
    staleRatio: row.observations > 0 ? 1 - row.distinct_source_timestamps / row.observations : null,
  }));
}

function fillGrid(db: Db): FillCell[] {
  const rows = db
    .prepare('SELECT weekday, hour_local, total_pct_full FROM v_sailing_fill WHERE total_pct_full IS NOT NULL')
    .all() as Array<{ weekday: number; hour_local: number; total_pct_full: number }>;

  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.weekday}|${row.hour_local}`;
    const list = buckets.get(key) ?? [];
    list.push(row.total_pct_full);
    buckets.set(key, list);
  }

  return [...buckets.entries()].map(([key, values]) => {
    const [weekday, hour] = key.split('|').map(Number);
    return {
      weekday,
      hour,
      sailings: values.length,
      avgPctFull: round(values.reduce((sum, value) => sum + value, 0) / values.length),
      maxPctFull: round(Math.max(...values)),
    };
  });
}

function fillByRoute(db: Db): RouteFillRow[] {
  const names = terminalNames(db);
  const rows = db
    .prepare(`SELECT departing_terminal_id AS dep, arriving_terminal_id AS arr, hour_local, total_pct_full
      FROM v_sailing_fill WHERE total_pct_full IS NOT NULL`)
    .all() as Array<{ dep: number; arr: number; hour_local: number; total_pct_full: number }>;

  const buckets = new Map<string, Array<{ hour: number; pct: number }>>();
  for (const row of rows) {
    const key = `${names(row.dep)} to ${names(row.arr)}`;
    const list = buckets.get(key) ?? [];
    list.push({ hour: row.hour_local, pct: row.total_pct_full });
    buckets.set(key, list);
  }

  return [...buckets.entries()]
    .map(([route, values]) => {
      const byHour = new Map<number, number[]>();
      for (const value of values) byHour.set(value.hour, [...(byHour.get(value.hour) ?? []), value.pct]);
      const busiest = [...byHour.entries()].sort(
        (a, b) => average(b[1]) - average(a[1]),
      )[0];

      return {
        route,
        sailings: values.length,
        avgPctFull: round(average(values.map((value) => value.pct))),
        busiestHour: busiest ? busiest[0] : null,
      };
    })
    .sort((a, b) => (b.avgPctFull ?? 0) - (a.avgPctFull ?? 0));
}

function delays(db: Db): DelayRow[] {
  const rows = db
    .prepare(`SELECT hour_local, departure_delay_minutes AS minutes FROM v_departure_delay
      WHERE confidence <> 'low' AND exclusion_reason IS NULL`)
    .all() as Array<{ hour_local: number; minutes: number }>;

  const buckets = new Map<number, number[]>();
  for (const row of rows) buckets.set(row.hour_local, [...(buckets.get(row.hour_local) ?? []), row.minutes]);

  return [...buckets.entries()]
    .map(([hour, values]) => ({
      hour,
      legs: values.length,
      medianMinutes: percentile(values, 0.5),
      p90Minutes: percentile(values, 0.9),
      onTimePct: round((values.filter((value) => value <= ON_TIME_MINUTES).length / values.length) * 100),
    }))
    .sort((a, b) => a.hour - b.hour);
}

function durations(db: Db, view: string, column: string): DurationRow[] {
  const names = terminalNames(db);
  const rows = db
    .prepare(`SELECT departing_terminal_id AS dep, arriving_terminal_id AS arr, ${column} AS minutes
      FROM ${view} WHERE confidence <> 'low'`)
    .all() as Array<{ dep: number; arr: number; minutes: number }>;

  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${names(row.dep)} to ${names(row.arr)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), row.minutes]);
  }

  return [...buckets.entries()]
    .map(([route, values]) => ({
      route,
      legs: values.length,
      medianMinutes: percentile(values, 0.5),
      p90Minutes: percentile(values, 0.9),
      minMinutes: round(Math.min(...values)),
      maxMinutes: round(Math.max(...values)),
    }))
    .sort((a, b) => b.legs - a.legs);
}

function quality(db: Db, column: string): QualityRow[] {
  return (db
    .prepare(`SELECT COALESCE(${column}, 'none') AS label, COUNT(*) AS legs
      FROM sailing_leg GROUP BY COALESCE(${column}, 'none') ORDER BY legs DESC`)
    .all() as QualityRow[]);
}

function terminalNames(db: Db): (id: number | null) => string {
  const rows = db.prepare('SELECT terminal_id, terminal_name FROM terminal_reference').all() as Array<{
    terminal_id: number;
    terminal_name: string | null;
  }>;
  const map = new Map(rows.map((row) => [row.terminal_id, row.terminal_name ?? String(row.terminal_id)]));
  return (id) => (id === null ? 'unknown' : map.get(id) ?? `terminal ${id}`);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Nearest-rank on a copy, so an empty set reports nothing rather than zero. */
export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return round(sorted[index]);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
