import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneOldData } from '../src/capture/retention';
import { openDatabase, type Db } from '../src/db/database';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const now = () => NOW;

function daysAgo(days: number): string {
  return new Date(NOW - days * 24 * 60 * 60_000).toISOString();
}

let db: Db;
let directory: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  directory = await mkdtemp(path.join(tmpdir(), 'ferry-retention-'));

  const vessel = db.prepare(`INSERT INTO vessel_observation (vessel_id, vessel_name, source_timestamp, captured_at, content_hash)
    VALUES (1, 'Tacoma', ?, ?, ?)`);
  (await vessel.run(daysAgo(60), daysAgo(60), 'old'));
  (await vessel.run(daysAgo(10), daysAgo(10), 'recent'));

  (await db.prepare(`INSERT INTO capture_run (task, started_at, outcome) VALUES ('vessel_locations', ?, 'success')`).run(daysAgo(60)));
  (await db.prepare(`INSERT INTO capture_run (task, started_at, outcome) VALUES ('vessel_locations', ?, 'success')`).run(daysAgo(10)));

  (await db.prepare("INSERT INTO rollup_state (name, watermark, updated_at) VALUES ('sailing_leg', ?, ?)")
    .run(daysAgo(1), daysAgo(0)));
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe('retention prune', () => {
  it('deletes nothing when retention is disabled', async () => {
    const result = await pruneOldData(db, { retentionDays: null, now });

    expect(result.skipped).toBe('disabled');
    expect(result.vesselObservations).toBe(0);
    expect(count('vessel_observation')).toBe(2);
  });

  it('deletes nothing until the rollup has established a watermark', async () => {
    (await db.prepare('DELETE FROM rollup_state').run());

    const result = await pruneOldData(db, { retentionDays: 30, now });

    expect(result.skipped).toBe('no_watermark');
    expect(count('vessel_observation')).toBe(2);
    expect(count('capture_run')).toBe(2);
  });

  it('deletes rows older than the retention window', async () => {
    const result = await pruneOldData(db, { retentionDays: 30, now });

    expect(result.skipped).toBeNull();
    expect(result.vesselObservations).toBe(1);
    expect(result.captureRuns).toBe(1);
    expect(count('vessel_observation')).toBe(1);
  });

  it('never deletes past the rollup watermark', async () => {
    (await db.prepare("UPDATE rollup_state SET watermark = ? WHERE name = 'sailing_leg'").run(daysAgo(90)));

    const result = await pruneOldData(db, { retentionDays: 30, now });

    expect(result.cutoff).toBe(daysAgo(90));
    expect(result.vesselObservations).toBe(0);
    expect(count('vessel_observation')).toBe(2);
  });

  it('removes archive day files and their index rows together', async () => {
    const oldFile = path.join(directory, 'vessel_locations-2026-06-01.ndjson.gz');
    const keptFile = path.join(directory, 'vessel_locations-2026-08-30.ndjson.gz');
    await writeFile(oldFile, 'x');
    await writeFile(keptFile, 'x');

    const insert = db.prepare(`INSERT INTO archive_file (endpoint_id, service_date, path, member_count, byte_size, created_at, updated_at)
      VALUES ('vessel_locations', ?, ?, 1, 1, ?, ?)`);
    (await insert.run('2026-06-01', oldFile, daysAgo(90), daysAgo(90)));
    (await insert.run('2026-08-30', keptFile, daysAgo(2), daysAgo(2)));

    const result = await pruneOldData(db, { retentionDays: 30, now });

    expect(result.archiveFiles).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(keptFile)).toBe(true);
    expect(count('archive_file')).toBe(1);
  });

  it('keeps a finalized departure that is still inside the window', async () => {
    const insert = db.prepare(`INSERT INTO sailing_space_departure (
      departing_terminal_id, arriving_terminal_id, departure, vessel_id,
      first_seen_at, last_seen_at, last_seen_before_departure, finalized, service_date, weekday, hour_local
    ) VALUES (7, 3, ?, 1, ?, ?, 1, 1, '2026-09-01', 2, 9)`);
    (await insert.run(daysAgo(60), daysAgo(60), daysAgo(60)));
    (await insert.run(daysAgo(5), daysAgo(5), daysAgo(5)));

    const result = await pruneOldData(db, { retentionDays: 30, now });

    expect(result.sailingSpaceDepartures).toBe(1);
    expect(count('sailing_space_departure')).toBe(1);
  });
});

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;
}
