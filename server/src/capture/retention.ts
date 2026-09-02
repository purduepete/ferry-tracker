import { unlink } from 'node:fs/promises';
import type { Db } from '../db/database.js';

export interface RetentionOptions {
  retentionDays: number | null;
  now?: () => number;
}

export interface RetentionResult {
  cutoff: string | null;
  skipped: 'disabled' | 'no_watermark' | null;
  vesselObservations: number;
  sailingSpaceObservations: number;
  sailingSpaceDepartures: number;
  captureRuns: number;
  archiveFiles: number;
}

const empty = (cutoff: string | null, skipped: RetentionResult['skipped']): RetentionResult => ({
  cutoff,
  skipped,
  vesselObservations: 0,
  sailingSpaceObservations: 0,
  sailingSpaceDepartures: 0,
  captureRuns: 0,
  archiveFiles: 0,
});

/** Disabled unless retentionDays is set, and never deletes past the rollup watermark. */
export async function pruneOldData(db: Db, options: RetentionOptions): Promise<RetentionResult> {
  if (options.retentionDays === null) return empty(null, 'disabled');

  const now = options.now?.() ?? Date.now();
  const requested = new Date(now - options.retentionDays * 24 * 60 * 60_000).toISOString();
  const watermark = (db.prepare("SELECT watermark FROM rollup_state WHERE name = 'sailing_leg'").get() as
    | { watermark: string | null }
    | undefined)?.watermark ?? null;

  // No watermark means the rollup has not run, so every observation is still unprocessed.
  if (watermark === null) return empty(null, 'no_watermark');

  const cutoff = watermark < requested ? watermark : requested;
  const result = empty(cutoff, null);

  const files = db
    .prepare('SELECT id, path FROM archive_file WHERE service_date < ?')
    .all(cutoff.slice(0, 10)) as Array<{ id: number; path: string }>;
  for (const file of files) {
    await unlink(file.path).catch(() => undefined);
  }

  const run = db.transaction(() => {
    result.vesselObservations = db
      .prepare('DELETE FROM vessel_observation WHERE COALESCE(source_timestamp, captured_at) < ?')
      .run(cutoff).changes;
    result.sailingSpaceObservations = db
      .prepare('DELETE FROM sailing_space_observation WHERE captured_at < ?')
      .run(cutoff).changes;
    result.sailingSpaceDepartures = db
      .prepare('DELETE FROM sailing_space_departure WHERE finalized = 1 AND last_seen_at < ?')
      .run(cutoff).changes;
    result.captureRuns = db.prepare('DELETE FROM capture_run WHERE started_at < ?').run(cutoff).changes;
    for (const file of files) {
      result.archiveFiles += db.prepare('DELETE FROM archive_file WHERE id = ?').run(file.id).changes;
    }
  });

  run();
  return result;
}
