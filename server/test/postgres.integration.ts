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
import { NotificationStore } from '../src/notifications/store.js';

const connectionString = process.env.SOLUTIONDEPLOY_PG_TEST_URL;
if (!connectionString)
    throw new Error('SOLUTIONDEPLOY_PG_TEST_URL is required; DATABASE_URL is never used by this suite.');
const target = new URL(connectionString);
if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.search !== '' ||
    decodeURIComponent(target.pathname) !== '/sd_test_ferry'
) {
    throw new Error('Integration tests require the loopback-only sd_test_ferry disposable database.');
}

it('applies reviewed schema only to an empty disposable DB and preserves transactional capture/history/report behavior', async () => {
    const pool = new Pool({
        connectionString,
        max: 5,
        connectionTimeoutMillis: 5000,
        options: '-c search_path=pg_catalog,public',
    });
    try {
        const identity = await pool.query('SELECT current_database() AS name');
        expect(identity.rows[0].name).toBe('sd_test_ferry');
        const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
        expect(tables.rows).toEqual([]);
        await pool.query(await readFile(new URL('../../deploy/postgresql/001_initial.sql', import.meta.url), 'utf8'));
        await pool.query(
            await readFile(new URL('../../deploy/postgresql/002_notifications.sql', import.meta.url), 'utf8')
        );
        const db = await openPostgres(connectionString, pool);
        const notifications = new NotificationStore(db);
        const notificationNow = Date.parse('2026-09-01T18:00:00.000Z');
        const notificationSettings = { trafficMinutes: 15, queueMinutes: 15 };
        const subscription = await notifications.put('catch:3:7', true, notificationSettings, notificationNow);
        expect(await notifications.get('catch:3:7')).toEqual(subscription);
        const staleSubscription = structuredClone(subscription);
        subscription.state.status = 'armed';
        expect(await notifications.save(subscription, notificationNow + 1000)).toBe(true);
        expect(await notifications.save(staleSubscription, notificationNow + 1000)).toBe(false);
        const currentSubscription = (await notifications.get('catch:3:7'))!;
        expect(currentSubscription.revision).toBe(subscription.revision + 1);
        expect(currentSubscription.state.status).toBe('armed');
        expect(await notifications.claim(staleSubscription, 'stale-claim', notificationNow)).toBe(false);
        expect(await notifications.event('stale-claim')).toBeUndefined();

        const claims = await Promise.all([
            notifications.claim(currentSubscription, 'concurrent-claim', notificationNow),
            notifications.claim(currentSubscription, 'concurrent-claim', notificationNow),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(await notifications.event('concurrent-claim')).toMatchObject({
            status: 'claimed',
            attempts: 1,
            retry_at: null,
        });
        await notifications.finish('concurrent-claim', 'accepted', notificationNow + 1000, null, null);
        expect(await notifications.event('concurrent-claim')).toMatchObject({
            status: 'accepted',
            attempts: 1,
            retry_at: null,
            detail: null,
        });

        expect(await notifications.claim(currentSubscription, 'retry-claim', notificationNow)).toBe(true);
        const retryAt = notificationNow + 30_000;
        await notifications.finish('retry-claim', 'failed', notificationNow + 1000, retryAt, 'Confirmed rejection.');
        expect(await notifications.event('retry-claim')).toMatchObject({
            status: 'failed',
            attempts: 1,
            retry_at: new Date(retryAt).toISOString(),
            detail: 'Confirmed rejection.',
        });
        expect(await notifications.retry(currentSubscription, 'retry-claim', retryAt - 1)).toBe(false);
        const retries = await Promise.all([
            notifications.retry(currentSubscription, 'retry-claim', retryAt),
            notifications.retry(currentSubscription, 'retry-claim', retryAt),
        ]);
        expect(retries.filter(Boolean)).toHaveLength(1);
        expect(await notifications.event('retry-claim')).toMatchObject({
            status: 'claimed',
            attempts: 2,
            retry_at: null,
        });
        await notifications.finish('retry-claim', 'accepted', retryAt + 1000, null, null);
        expect(await notifications.event('retry-claim')).toMatchObject({
            status: 'accepted',
            attempts: 2,
            retry_at: null,
            detail: null,
        });
        expect(await notifications.retry(currentSubscription, 'retry-claim', retryAt + 2000)).toBe(false);
        await pool.query('CREATE ROLE sd_test_notify_runtime NOLOGIN');
        await pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
        await pool.query('GRANT USAGE ON SCHEMA public TO sd_test_notify_runtime');
        await pool.query(`GRANT SELECT, INSERT, UPDATE ON public.notification_subscriptions,
            public.notification_events TO sd_test_notify_runtime`);
        const grants = await pool.query(`SELECT table_name, privilege_type FROM information_schema.table_privileges
            WHERE grantee = 'sd_test_notify_runtime' ORDER BY table_name, privilege_type`);
        expect(grants.rows).toEqual(
            ['notification_events', 'notification_subscriptions'].flatMap((table_name) =>
                ['INSERT', 'SELECT', 'UPDATE'].map((privilege_type) => ({ table_name, privilege_type }))
            )
        );
        await transaction(db, async () => {
            await db.prepare('SET LOCAL ROLE sd_test_notify_runtime').run();
            const runtimeSubscription = await notifications.put(
                'catch:7:3',
                true,
                { trafficMinutes: 5, queueMinutes: 5 },
                notificationNow
            );
            expect(await notifications.get('catch:7:3')).toEqual(runtimeSubscription);
            expect(await notifications.save(runtimeSubscription, notificationNow)).toBe(true);
            const runtimeCurrent = (await notifications.get('catch:7:3'))!;
            expect(await notifications.claim(runtimeCurrent, 'runtime-claim', notificationNow)).toBe(true);
            await notifications.finish('runtime-claim', 'accepted', notificationNow, null, null);
            expect(await notifications.event('runtime-claim')).toMatchObject({ status: 'accepted' });
            for (const deniedSql of [
                "DELETE FROM public.notification_events WHERE event_key = 'runtime-claim'",
                'CREATE TABLE public.notification_forbidden(id INTEGER)',
                'ALTER TABLE public.notification_events ADD COLUMN forbidden INTEGER',
                'DROP TABLE public.notification_events',
            ]) {
                await db.prepare('SAVEPOINT notification_permission_probe').run();
                await expect(db.prepare(deniedSql).run()).rejects.toMatchObject({ code: '42501' });
                await db.prepare('ROLLBACK TO SAVEPOINT notification_permission_probe').run();
                await db.prepare('RELEASE SAVEPOINT notification_permission_probe').run();
            }
        })();
        const capturedAt = '2026-09-01T18:30:00.000Z';
        const vessel = {
            VesselID: 1,
            VesselName: 'Tacoma',
            DepartingTerminalID: 7,
            DepartingTerminalName: 'Seattle',
            ArrivingTerminalID: 3,
            ArrivingTerminalName: 'Bainbridge Island',
            Latitude: 47.6,
            Longitude: -122.4,
            Speed: 14,
            Heading: 270,
            InService: true,
            AtDock: false,
            TimeStamp: '/Date(1788287400000)/',
            LeftDock: '/Date(1788285600000)/',
            ScheduledDeparture: '/Date(1788285600000)/',
        };
        expect((await writeVesselObservations(db, [vessel], capturedAt)).written).toBe(1);
        expect((await writeVesselObservations(db, [vessel], capturedAt)).skipped).toBe(1);
        expect((await writeVesselObservations(db, [{ ...vessel, Speed: 15 }], capturedAt)).written).toBe(1);
        const references = await writeReferenceData(
            db,
            [{ VesselID: 1, VesselName: 'Tacoma' }],
            [
                { TerminalID: 7, TerminalName: 'Seattle' },
                { TerminalID: 3, TerminalName: 'Bainbridge Island' },
            ],
            capturedAt
        );
        expect(references.invalid).toBe(0);

        const client = {
            getSchedule: async () => ({
                TerminalCombos: [
                    {
                        DepartingTerminalID: 7,
                        ArrivingTerminalID: 3,
                        Times: [
                            {
                                DepartingTime: '2026-09-01T18:00:00Z',
                                ArrivingTime: '2026-09-01T18:35:00Z',
                                VesselID: 1,
                                VesselName: 'Tacoma',
                            },
                        ],
                    },
                ],
            }),
        } as unknown as WsdotClient;
        await writeScheduleSnapshots(
            db,
            client,
            [
                {
                    DepartingTerminalID: 7,
                    DepartingDescription: 'Seattle',
                    ArrivingTerminalID: 3,
                    ArrivingDescription: 'Bainbridge Island',
                },
            ],
            capturedAt,
            undefined,
            () => Date.parse(capturedAt)
        );
        const space = {
            TerminalID: 7,
            TerminalName: 'Seattle',
            DepartingSpaces: [
                {
                    Departure: '2026-09-01T18:00:00Z',
                    VesselID: 1,
                    VesselName: 'Tacoma',
                    IsCancelled: false,
                    MaxSpaceCount: 100,
                    SpaceForArrivalTerminals: [
                        {
                            TerminalID: 3,
                            TerminalName: 'Bainbridge Island',
                            ArrivalTerminalIDs: [3],
                            VesselID: 1,
                            VesselName: 'Tacoma',
                            DisplayDriveUpSpace: true,
                            DriveUpSpaceCount: 20,
                            DisplayReservableSpace: true,
                            ReservableSpaceCount: 10,
                            MaxSpaceCount: 100,
                        },
                    ],
                },
            ],
        };
        const spaces = await writeSailingSpaceObservations(db, [space], capturedAt);
        expect(spaces.invalid).toBe(0);
        expect(spaces.written).toBeGreaterThan(0);
        const rolled = await runLegRollup(db, {
            dwellCeilingMinutes: 120,
            dockDebounceSeconds: 120,
            now: Date.parse(capturedAt),
        });
        expect(rolled.vessels).toBe(1);

        await expect(
            transaction(db, async () => {
                await db
                    .prepare('INSERT INTO capture_run(task,started_at,outcome) VALUES(?,?,?)')
                    .run('rollback-probe', capturedAt, 'success');
                throw new Error('rollback probe');
            })()
        ).rejects.toThrow();
        expect(await db.prepare('SELECT COUNT(*) AS n FROM capture_run WHERE task=?').get('rollback-probe')).toEqual({
            n: 0,
        });
        const history = new DatabaseSailingHistory(db);
        const sailings = await history.daySailings(7, 3, '2026-09-01');
        expect(sailings).toHaveLength(1);
        expect(sailings[0].vesselId).toBe(1);
        await expect(history.crossings()).resolves.toEqual([]);
        const report = await collectReport(db, 'PostgreSQL test');
        expect(report.counts.find((row) => row.table === 'vessel_observation')?.rows).toBe(2);
        const views = await pool.query("SELECT viewname FROM pg_views WHERE schemaname='public'");
        expect(views.rows).toHaveLength(6);
    } finally {
        await pool.end();
    }
});
