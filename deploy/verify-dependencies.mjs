import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');
const { transformSync } = require('esbuild');
const { Client } = require('pg');

const database = new Database(':memory:');
try {
    assert.deepEqual(database.prepare('SELECT 42 AS answer').get(), { answer: 42 });
} finally {
    database.close();
}
assert.match(transformSync('const answer: number = 42;', { loader: 'ts' }).code, /42/);
assert.equal(typeof Client, 'function');
console.log(`Dependency checks passed on ${process.version}: SQLite, esbuild, PostgreSQL driver.`);
