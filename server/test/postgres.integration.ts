import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { openPostgres } from '../src/db/postgres.js';
import { transaction } from '../src/db/database.js';
import { writeVesselObservations, writeSailingSpaceObservations } from '../src/capture/writers.js';
import { writeReferenceData, writeScheduleSnapshots } from '../src/capture/referenceWriters.js';
import { DatabaseSailingHistory } from '../src/history/sailingHistory.js';
import { collectReport } from '../src/report/metrics.js';
import { runLegRollup } from '../src/rollup/legRollup.js';
import type { WsdotClient } from '../src/wsdotClient.js';

const connectionString = process.env.SOLUTIONDEPLOY_PG_TEST_URL;
if (!connectionString) throw new Error('SOLUTIONDEPLOY_PG_TEST_URL is required; DATABASE_URL is never used by this suite.');
const target = new URL(connectionString);
if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.search !== '' ||
    decodeURIComponent(target.pathname) !== '/sd_test_ferry') {
  throw new Error('Integration tests require the loopback-only sd_test_ferry disposable database.');
}

it('applies reviewed schema only to an empty disposable DB and preserves transactional capture/history/report behavior', async () => {
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, options: '-c search_path=pg_catalog,public' });
  try {
    const identity = await pool.query('SELECT current_database() AS name');
    expect(identity.rows[0].name).toBe('sd_test_ferry');
    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    expect(tables.rows).toEqual([]);
    await pool.query(await readFile(new URL('../../deploy/postgresql/001_initial.sql', import.meta.url), 'utf8'));
    const db = await openPostgres(connectionString, pool);
    const capturedAt = '2026-09-01T18:30:00.000Z';
    const vessel = {
      VesselID: 1, VesselName: 'Tacoma', DepartingTerminalID: 7, DepartingTerminalName: 'Seattle',
      ArrivingTerminalID: 3, ArrivingTerminalName: 'Bainbridge Island',
      Latitude: 47.6, Longitude: -122.4, Speed: 14, Heading: 270, InService: true,
      AtDock: false, TimeStamp: '/Date(1788287400000)/', LeftDock: '/Date(1788285600000)/',
      ScheduledDeparture: '/Date(1788285600000)/',
    };
    expect((await writeVesselObservations(db, [vessel], capturedAt)).written).toBe(1);
    expect((await writeVesselObservations(db, [vessel], capturedAt)).skipped).toBe(1);
    expect((await writeVesselObservations(db, [{ ...vessel, Speed: 15 }], capturedAt)).written).toBe(1);
    const references = await writeReferenceData(db, [{ VesselID: 1, VesselName: 'Tacoma' }], [
      { TerminalID: 7, TerminalName: 'Seattle' }, { TerminalID: 3, TerminalName: 'Bainbridge Island' },
    ], capturedAt);
    expect(references.invalid).toBe(0);

    const client = {
      getSchedule: async () => ({
        TerminalCombos: [{
          DepartingTerminalID: 7, ArrivingTerminalID: 3,
          Times: [{ DepartingTime: '2026-09-01T18:00:00Z', ArrivingTime: '2026-09-01T18:35:00Z', VesselID: 1, VesselName: 'Tacoma' }],
        }],
      }),
    } as unknown as WsdotClient;
    await writeScheduleSnapshots(db, client, [{
      DepartingTerminalID: 7, DepartingDescription: 'Seattle', ArrivingTerminalID: 3, ArrivingDescription: 'Bainbridge Island',
    }], capturedAt, undefined, () => Date.parse(capturedAt));
    const space = {
      TerminalID: 7, TerminalName: 'Seattle', DepartingSpaces: [{
        Departure: '2026-09-01T18:00:00Z', VesselID: 1, VesselName: 'Tacoma', IsCancelled: false,
        MaxSpaceCount: 100, SpaceForArrivalTerminals: [{
          TerminalID: 3, TerminalName: 'Bainbridge Island', ArrivalTerminalIDs: [3],
          VesselID: 1, VesselName: 'Tacoma',
          DisplayDriveUpSpace: true, DriveUpSpaceCount: 20,
          DisplayReservableSpace: true, ReservableSpaceCount: 10, MaxSpaceCount: 100,
        }],
      }],
    };
    const spaces = await writeSailingSpaceObservations(db, [space], capturedAt);
    expect(spaces.invalid).toBe(0);
    expect(spaces.written).toBeGreaterThan(0);
    const rolled = await runLegRollup(db, { dwellCeilingMinutes: 120, dockDebounceSeconds: 120, now: Date.parse(capturedAt) });
    expect(rolled.vessels).toBe(1);

    await expect(transaction(db, async () => {
      await db.prepare("INSERT INTO capture_run(task,started_at,outcome) VALUES(?,?,?)").run('rollback-probe', capturedAt, 'success');
      throw new Error('rollback probe');
    })()).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM capture_run WHERE task=?").get('rollback-probe')).toEqual({ n: 0 });
    const history = new DatabaseSailingHistory(db);
    const sailings = await history.daySailings(7, 3, '2026-09-01');
    expect(sailings).toHaveLength(1);
    expect(sailings[0].vesselId).toBe(1);
    await expect(history.crossings()).resolves.toEqual([]);
    const report = await collectReport(db, 'PostgreSQL test');
    expect(report.counts.find(row => row.table === 'vessel_observation')?.rows).toBe(2);
    const views = await pool.query("SELECT viewname FROM pg_views WHERE schemaname='public'");
    expect(views.rows).toHaveLength(6);
  } finally { await pool.end(); }
});
