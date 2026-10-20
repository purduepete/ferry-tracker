// One-off repair. Legs are derived data: the rollup only moves forward from a watermark, so
// a fix to the state machine never revisits legs it already wrote. Deleting them and replaying
// the retained observations is the only way to apply one retroactively.
//
// vessel_observation is never written here, so a bad run costs nothing that cannot be replayed.
import { mkdirSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { getConfig } from '../server/dist/config.js';
import { openDatabase, transaction } from '../server/dist/db/database.js';
import { runLegRollup } from '../server/dist/rollup/legRollup.js';

const KEEP_FRACTION = 0.8;
if (process.env.STORAGE_BACKEND === 'postgresql')
    throw new Error('Legacy SQLite rebuild is disabled for PostgreSQL. Use a separately reviewed PostgreSQL repair.');

const config = getConfig();
const { capture } = config;

if (!process.argv.includes('--confirm')) {
    console.error('This deletes every row in sailing_leg and rebuilds it. Rerun with --confirm.');
    console.error(`  database: ${capture.dbPath}`);
    process.exit(2);
}

// An old build would just rewrite the same phantom legs, so refuse rather than churn the table.
if (!capture.dockDebounceSeconds) {
    console.error('server/dist predates the AtDock debounce. Run npm run build first.');
    process.exit(2);
}

function portInUse(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const settle = (answer) => {
            socket.destroy();
            resolve(answer);
        };
        socket.setTimeout(1500);
        socket.once('connect', () => settle(true));
        socket.once('timeout', () => settle(false));
        socket.once('error', () => settle(false));
    });
}

// The server writes a capture row every 30 seconds against a 5 second busy timeout, so a rebuild
// holding the write lock would start failing its polls. Cheaper to make the operator stop it.
if (await portInUse(config.port)) {
    console.error(`Something is serving on port ${config.port}. Stop the server first:`);
    console.error('  Stop-ScheduledTask -TaskName FerryTracker');
    console.error('  node deploy/rebuild-legs.mjs --confirm');
    console.error('  Start-ScheduledTask -TaskName FerryTracker');
    process.exit(2);
}

const summarize = (db) => ({
    legs: db.prepare('SELECT COUNT(*) n FROM sailing_leg').get().n,
    shown: db
        .prepare(
            `SELECT COUNT(*) n FROM sailing_leg WHERE complete = 1 AND crossing_minutes IS NOT NULL
    AND confidence <> 'low' AND exclusion_reason IS NULL
    AND (departure_delay_minutes IS NULL OR departure_delay_minutes >= 0)`
        )
        .get().n,
    bad: db
        .prepare(
            `SELECT COUNT(*) n FROM sailing_leg WHERE complete = 1 AND crossing_minutes < 5
    AND confidence <> 'low' AND exclusion_reason IS NULL
    AND (departure_delay_minutes IS NULL OR departure_delay_minutes >= 0)`
        )
        .get().n,
    observations: db.prepare('SELECT COUNT(*) n FROM vessel_observation').get().n,
});

// Milliseconds, because VACUUM INTO refuses an existing file and a retry lands in the same
// second. The name deliberately avoids the 'ferry-capture-' prefix that backup-db.mjs prunes,
// so the weekly job cannot count this safety copy against its keep limit.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
const backupDir = process.env.BACKUP_DIR ?? path.join(path.dirname(capture.dbPath), 'backups');
mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `prerebuild-${stamp}.db`);

const source = new Database(capture.dbPath);
try {
    source.pragma('busy_timeout = 30000');
    source.prepare('VACUUM INTO ?').run(backup);
} finally {
    source.close();
}
console.log(`backed up to ${backup} (${Math.round(statSync(backup).size / 1024)} KB)`);

const db = openDatabase(capture.dbPath);
db.pragma('busy_timeout = 60000');
try {
    const before = summarize(db);
    console.log(`before: ${before.legs} legs, ${before.shown} shown, ${before.bad} under 5 minutes`);

    let after;
    // The sanity check runs inside the transaction, so a rebuild that loses most of the history
    // rolls back instead of committing and leaving someone to restore the backup by hand.
    const rebuild = transaction(db, async () => {
        db.prepare('DELETE FROM sailing_leg').run();
        db.prepare('DELETE FROM rollup_state').run();
        const result = await runLegRollup(db, {
            dwellCeilingMinutes: capture.dwellCeilingMinutes,
            dockDebounceSeconds: capture.dockDebounceSeconds,
        });
        after = summarize(db);
        if (before.shown > 0 && after.shown < before.shown * KEEP_FRACTION) {
            throw new Error(
                `kept only ${after.shown} of ${before.shown} visible legs, expected at least ` +
                    String(Math.ceil(before.shown * KEEP_FRACTION))
            );
        }
        if (after.legs === 0 && after.observations > 0) {
            throw new Error(`rebuilt no legs at all from ${after.observations} observations`);
        }
        return result;
    });

    let result;
    try {
        result = await rebuild();
    } catch (error) {
        console.error(`rebuild rolled back: ${error.message}`);
        console.error('sailing_leg is unchanged. Nothing to restore.');
        process.exit(1);
    }

    console.log(`after:  ${after.legs} legs, ${after.shown} shown, ${after.bad} under 5 minutes`);
    console.log(
        `replayed ${after.observations} observations across ${result.vessels} vessels, ` +
            `watermark ${result.watermark ?? 'none'}`
    );
} finally {
    db.close();
}
