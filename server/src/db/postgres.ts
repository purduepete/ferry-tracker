import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { postgresConnection } from './connection.js';

export interface Statement {
    all(...values: unknown[]): Promise<unknown[]>;
    get(...values: unknown[]): Promise<unknown>;
    run(...values: unknown[]): Promise<{ changes: number }>;
}

export function parameters(sql: string): string {
    let position = 0;
    let quoted = false;
    return sql.replace(/'|\?/g, (token) => {
        if (token === "'") quoted = !quoted;
        return token === '?' && !quoted ? `$${++position}` : token;
    });
}

function normalize(row: QueryResultRow, fields: Array<{ name: string; dataTypeID: number }>): QueryResultRow {
    for (const field of fields) {
        if ([20, 1700].includes(field.dataTypeID) && typeof row[field.name] === 'string') {
            const number = Number(row[field.name]);
            if (!Number.isFinite(number) || (field.dataTypeID === 20 && !Number.isSafeInteger(number))) {
                throw new Error(`PostgreSQL value exceeds safe numeric range: ${field.name}`);
            }
            row[field.name] = number;
        }
    }
    return row;
}

export class PostgresDatabase {
    readonly backend = 'postgresql';
    private readonly transactionClient = new AsyncLocalStorage<PoolClient>();
    private queue: Promise<unknown> = Promise.resolve();
    constructor(readonly pool: Pool) {}

    prepare(sql: string): Statement {
        const text = parameters(sql);
        const query = async (values: unknown[]) => {
            const connection = this.transactionClient.getStore() ?? this.pool;
            return connection.query(text, values);
        };
        return {
            all: async (...values) => {
                const result = await query(values);
                return result.rows.map((row) => normalize(row, result.fields));
            },
            get: async (...values) => {
                const result = await query(values);
                return result.rows[0] ? normalize(result.rows[0], result.fields) : undefined;
            },
            run: async (...values) => ({ changes: (await query(values)).rowCount ?? 0 }),
        };
    }

    transaction<T>(work: () => T | Promise<T>): () => Promise<T> {
        return async () => {
            if (this.transactionClient.getStore()) return work();
            const run = this.queue.then(async () => {
                const client = await this.pool.connect();
                try {
                    await client.query('BEGIN');
                    const value = await this.transactionClient.run(client, work);
                    await client.query('COMMIT');
                    return value;
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }
            });
            this.queue = run.catch(() => undefined);
            return run;
        };
    }

    async close(): Promise<void> {
        await this.queue;
        await this.pool.end();
    }
}

export async function openPostgres(connectionString: string | undefined, pool?: Pool): Promise<PostgresDatabase> {
    if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL storage.');
    const database = new PostgresDatabase(
        pool ??
            new Pool({
                ...postgresConnection(connectionString),
                max: 5,
                connectionTimeoutMillis: 5000,
                options: '-c search_path=pg_catalog,public',
            })
    );
    try {
        const ledger = await database.pool.query('SELECT version FROM public.solutiondeploy_schema WHERE app_id=$1', [
            'ferry-tracker',
        ]);
        if (ledger.rows.length !== 1 || ledger.rows[0].version !== 1) {
            throw new Error('Ferry PostgreSQL schema version mismatch. Apply the reviewed migration explicitly.');
        }
        return database;
    } catch (error) {
        await database.close();
        throw error;
    }
}
