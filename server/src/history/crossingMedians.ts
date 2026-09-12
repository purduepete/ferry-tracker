import type { CrossingView } from '@ferry-tracker/shared';
import type { Db } from '../db/database.js';
import { percentile } from '../report/metrics.js';

// Seven rather than six so the nearest-rank percentile has a true middle to land on.
export const CROSSING_WINDOW = 7;
export const MIN_CROSSING_SAMPLES = 3;
export const MAX_CROSSING_AGE_DAYS = 14;
export const CROSSING_CACHE_MS = 2 * 60 * 1000;
// A leg recorded at a fraction of its own pair's median never happened. On the multi-stop San
// Juan runs the rollup can close a 50 minute crossing in 2 minutes when an intermediate call
// goes unobserved, which drags the low quantile to nothing. Judged against the pair's own
// scale so a 10 minute hop and a 70 minute run are both handled without a fixed floor.
const OUTLIER_FLOOR_FRACTION = 0.5;

// WHERE runs before the window function, so the graded-down and excluded legs never take up
// a rank slot. Filtering them after the ranking would silently shrink the sample instead.
const CROSSING_SQL = `
  WITH eligible AS (
    SELECT departing_terminal_id AS dep,
           arriving_terminal_id AS arr,
           crossing_minutes AS minutes,
           ROW_NUMBER() OVER (
             PARTITION BY departing_terminal_id, arriving_terminal_id
             ORDER BY departed_at DESC
           ) AS rn
    FROM v_crossing_duration
    WHERE confidence <> 'low'
      AND exclusion_reason IS NULL
      AND crossing_minutes > 0
      AND departing_terminal_id IS NOT NULL
      AND arriving_terminal_id IS NOT NULL
      AND departing_terminal_id <> arriving_terminal_id
      AND departed_at >= ?
  )
  SELECT dep, arr, minutes FROM eligible WHERE rn <= ?`;

interface CrossingRow {
  dep: number;
  arr: number;
  minutes: number;
}

const key = (departingId: number, arrivingId: number) => `${departingId}-${arrivingId}`;

const round = (value: number) => Math.round(value * 10) / 10;

export function computeCrossings(db: Db, nowMs: number): CrossingView[] {
  const since = new Date(nowMs - MAX_CROSSING_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(CROSSING_SQL).all(since, CROSSING_WINDOW) as CrossingRow[];

  const buckets = new Map<string, { dep: number; arr: number; minutes: number[] }>();
  for (const row of rows) {
    const bucketKey = key(row.dep, row.arr);
    const bucket = buckets.get(bucketKey) ?? { dep: row.dep, arr: row.arr, minutes: [] };
    bucket.minutes.push(row.minutes);
    buckets.set(bucketKey, bucket);
  }

  const direct = new Map<string, CrossingView>();
  for (const [bucketKey, bucket] of buckets) {
    if (bucket.minutes.length < MIN_CROSSING_SAMPLES) continue;
    // Twice, because a pair carrying several artefacts has a median low enough that the
    // first floor cannot clear them all.
    let minutes = bucket.minutes;
    for (let pass = 0; pass < 2; pass++) {
      const floor = (percentile(minutes, 0.5) ?? 0) * OUTLIER_FLOOR_FRACTION;
      minutes = minutes.filter((value) => value >= floor);
    }
    if (minutes.length < MIN_CROSSING_SAMPLES) continue;
    direct.set(bucketKey, {
      departingTerminalId: bucket.dep,
      arrivingTerminalId: bucket.arr,
      medianMinutes: round(percentile(minutes, 0.5) ?? 0),
      fastMinutes: round(percentile(minutes, 0.1) ?? 0),
      samples: minutes.length,
      borrowed: false,
    });
  }

  // A crossing runs close to the same length either way, so a thin pair takes the reverse
  // direction rather than falling all the way back to WSDOT's estimate. Flagged, because the
  // two are not identical: currents and slip alignment move it by a couple of minutes.
  const results = [...direct.values()];
  for (const view of direct.values()) {
    const reverseKey = key(view.arrivingTerminalId, view.departingTerminalId);
    if (direct.has(reverseKey)) continue;
    results.push({
      departingTerminalId: view.arrivingTerminalId,
      arrivingTerminalId: view.departingTerminalId,
      medianMinutes: view.medianMinutes,
      fastMinutes: view.fastMinutes,
      samples: view.samples,
      borrowed: true,
    });
  }

  return results.sort((a, b) => a.departingTerminalId - b.departingTerminalId
    || a.arrivingTerminalId - b.arrivingTerminalId);
}

export class CrossingCache {
  private cached: CrossingView[] | null = null;
  private expiresAt = 0;

  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  // The read is synchronous, so nothing else can run between the miss and the store and a
  // burst of polls cannot stampede the query. The window only moves when a crossing closes.
  read(): CrossingView[] {
    const nowMs = this.now();
    if (this.cached && nowMs < this.expiresAt) return this.cached;
    this.cached = computeCrossings(this.db, nowMs);
    this.expiresAt = nowMs + CROSSING_CACHE_MS;
    return this.cached;
  }
}
