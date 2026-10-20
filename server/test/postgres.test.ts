import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { openPostgres, parameters, PostgresDatabase } from '../src/db/postgres.js';
import { openConfiguredDatabase } from '../src/db/database.js';
import { writeVesselObservations } from '../src/capture/writers.js';

afterEach(() => vi.unstubAllEnvs());

function fakePool() {
    const client = {
        query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], fields: [], rowCount: 0 })),
        release: vi.fn(),
    };
    const pool = {
        query: vi.fn(async (_sql: string, _values?: unknown[]) => ({
            rows: [{ version: 1 }],
            fields: [],
            rowCount: 1,
        })),
        connect: vi.fn(async () => client),
        end: vi.fn(async () => undefined),
    };
    return { pool, client, db: new PostgresDatabase(pool as unknown as Pool) };
}

describe('PostgreSQL runtime without database access', () => {
    it('keeps sailing-fill arithmetic in double precision before division, matching SQLite REAL', () => {
        const schema = readFileSync(new URL('../../deploy/postgresql/001_initial.sql', import.meta.url), 'utf8');
        expect(schema.match(/100\.0::double precision \*/g)).toHaveLength(2);
        expect(schema).not.toMatch(/\b100\.0 \*/);
        expect((100 * (197 - 191)) / 197).toBe(3.045685279187817);
        expect(Number('3.0456852791878173')).not.toBe((100 * (197 - 191)) / 197);
        expect((100 * (139 - 137)) / 139).toBe(1.4388489208633093);
        expect(Number('1.4388489208633094')).not.toBe((100 * (139 - 137)) / 139);
    });

    it('preserves double-precision percentage results without another numeric conversion', async () => {
        const query = vi.fn(async () => ({
            rows: [{ drive_up_pct_full: 3.045685279187817, total_pct_full: null }],
            fields: [
                { name: 'drive_up_pct_full', dataTypeID: 701 },
                { name: 'total_pct_full', dataTypeID: 701 },
            ],
        }));
        const db = new PostgresDatabase({ query } as unknown as Pool);
        await expect(db.prepare('SELECT * FROM v_sailing_fill').get()).resolves.toEqual({
            drive_up_pct_full: 3.045685279187817,
            total_pct_full: null,
        });
    });

    it('translates positional parameters without changing question marks in SQL strings', () => {
        expect(parameters("SELECT '?' AS label, ? AS a, 'it''s ?' AS quoted, ? AS b")).toBe(
            "SELECT '?' AS label, $1 AS a, 'it''s ?' AS quoted, $2 AS b"
        );
    });

    it('requires DATABASE_URL and never silently opens SQLite', async () => {
        vi.stubEnv('STORAGE_BACKEND', 'postgresql');
        vi.stubEnv('DATABASE_URL', '');
        await expect(openConfiguredDatabase('must-not-exist.db')).rejects.toThrow('DATABASE_URL');
    });

    it('only reads the shared schema ledger at startup', async () => {
        const { pool } = fakePool();
        const database = await openPostgres('postgresql://not-used', pool as unknown as Pool);
        expect(pool.query).toHaveBeenCalledExactlyOnceWith(
            'SELECT version FROM public.solutiondeploy_schema WHERE app_id=$1',
            ['ferry-tracker']
        );
        await database.close();
        expect(pool.end).toHaveBeenCalledOnce();
    });

    it('fails closed and closes its pool on a schema mismatch', async () => {
        const { pool } = fakePool();
        pool.query.mockResolvedValue({ rows: [{ version: 2 }], fields: [], rowCount: 1 });
        await expect(openPostgres('postgresql://not-used', pool as unknown as Pool)).rejects.toThrow('schema version');
        expect(pool.end).toHaveBeenCalledOnce();
    });

    it('pins transaction statements to one client and awaits writes before commit', async () => {
        const { db, pool, client } = fakePool();
        let finish!: () => void;
        const pending = db.transaction(async () => {
            await db.prepare('INSERT INTO capture_run(task) VALUES (?)').run('test');
            await new Promise<void>((resolve) => {
                finish = resolve;
            });
        })();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        expect(client.query.mock.calls.map((call) => call[0])).toEqual([
            'BEGIN',
            'INSERT INTO capture_run(task) VALUES ($1)',
        ]);
        finish();
        await pending;
        expect(client.query.mock.calls.map((call) => call[0])).toEqual([
            'BEGIN',
            'INSERT INTO capture_run(task) VALUES ($1)',
            'COMMIT',
        ]);
        expect(pool.query).not.toHaveBeenCalled();
        expect(client.release).toHaveBeenCalledOnce();
    });

    it('rolls back failed work and releases the client', async () => {
        const { db, client } = fakePool();
        await expect(
            db.transaction(async () => {
                throw new Error('write rejected');
            })()
        ).rejects.toThrow('write rejected');
        expect(client.query.mock.calls.map((call) => call[0])).toEqual(['BEGIN', 'ROLLBACK']);
        expect(client.release).toHaveBeenCalledOnce();
    });

    it('serializes concurrent transactions so capture and rollup cannot share ownership', async () => {
        const { db, pool, client } = fakePool();
        let finish!: () => void;
        const first = db.transaction(async () => {
            await new Promise<void>((resolve) => {
                finish = resolve;
            });
        })();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        const second = db.transaction(async () => {
            await db.prepare('UPDATE rollup_state SET watermark=? WHERE name=?').run('stamp', 'sailing_leg');
        })();
        await Promise.resolve();
        expect(pool.connect).toHaveBeenCalledTimes(1);
        finish();
        await Promise.all([first, second]);
        expect(client.query.mock.calls.map((call) => call[0])).toEqual([
            'BEGIN',
            'COMMIT',
            'BEGIN',
            'UPDATE rollup_state SET watermark=$1 WHERE name=$2',
            'COMMIT',
        ]);
    });

    it('keeps integer counts numeric and rejects unsafe bigint identifiers', async () => {
        const query = vi.fn(async () => ({
            rows: [{ count: '42', id: '9' }],
            fields: [
                { name: 'count', dataTypeID: 20 },
                { name: 'id', dataTypeID: 20 },
            ],
        }));
        const db = new PostgresDatabase({ query } as unknown as Pool);
        await expect(db.prepare('SELECT COUNT(*) AS count, ? AS id').get(9)).resolves.toEqual({ count: 42, id: 9 });
        query.mockResolvedValueOnce({
            rows: [{ count: '1', id: '9007199254740993' }],
            fields: [
                { name: 'count', dataTypeID: 20 },
                { name: 'id', dataTypeID: 20 },
            ],
        });
        await expect(db.prepare('SELECT id FROM vessel_observation').all()).rejects.toThrow('safe numeric range');
    });

    it('serializes writer transactions and exercises the async vessel writer with a fake pool', async () => {
        const { db, client } = fakePool();
        await expect(writeVesselObservations(db, [], '2026-10-17T00:00:00.000Z')).resolves.toEqual({
            written: 0,
            skipped: 0,
            invalid: 0,
        });
        expect(client.query.mock.calls.map((call) => call[0])).toEqual(['BEGIN', 'COMMIT']);
    });
});
