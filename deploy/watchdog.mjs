// Local health check for the public deployment. Runs on a schedule and pages via Pushover.
// It cannot report that the machine itself died, so it also pings an external dead-man's switch.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { getConfig } from '../server/dist/config.js';
import { checkFreeSpace } from '../server/dist/capture/diskSpace.js';

const MINUTE = 60_000;
if (process.env.STORAGE_BACKEND === 'postgresql')
    throw new Error(
        'Legacy SQLite watchdog is disabled for PostgreSQL. Use framework readiness and PostgreSQL monitoring.'
    );
const MIN_FREE_DISK_MB = Number(process.env.WATCHDOG_MIN_FREE_DISK_MB ?? 20_480);
const HEARTBEAT_MAX_AGE_MS = Number(process.env.WATCHDOG_HEARTBEAT_MAX_AGE_MS ?? 45 * MINUTE);
const SERVICE_NAME = process.env.WATCHDOG_TUNNEL_SERVICE ?? 'cloudflared';
const PUSHOVER = process.env.WATCHDOG_PUSHOVER_SCRIPT ?? 'C:\\Files\\Dev\\main\\copilot\\tools\\Send-Pushover.ps1';
const RENOTIFY_MS = Number(process.env.WATCHDOG_RENOTIFY_MS ?? 60 * MINUTE);

// A capture run writes a capture_run row whatever happens, including the error path, so liveness
// and health are separate questions. These bound the age of the last NON-error run per task.
const TASK_MAX_AGE_MS = {
    vessel_locations: 5 * MINUTE,
    terminal_sailing_space: 10 * MINUTE,
    rollup: 10 * MINUTE,
    reference: 12 * 60 * MINUTE,
    schedule: 12 * 60 * MINUTE,
};

const config = getConfig();
const dataDir = process.env.CAPTURE_DATA_DIR ?? path.dirname(config.capture.dbPath);
const statePath = path.join(dataDir, 'watchdog-state.json');

const failures = [];
const fail = (message) => failures.push(message);
const ageMs = (isoText, now) => now - Date.parse(isoText);

function minutes(ms) {
    return `${Math.round(ms / MINUTE)} min`;
}

function serviceRunning(name) {
    try {
        return /STATE\s+:\s+\d+\s+RUNNING/.test(execFileSync('sc.exe', ['query', name], { encoding: 'utf8' }));
    } catch {
        return false;
    }
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 5000) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host });
        const settle = (value) => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => settle(true));
        socket.once('timeout', () => settle(false));
        socket.once('error', () => settle(false));
    });
}

function checkCapture(now) {
    let db;
    try {
        db = new Database(config.capture.dbPath, { readonly: true, fileMustExist: true });
    } catch (error) {
        fail(`Cannot open the capture database: ${error.message}`);
        return;
    }
    try {
        const heartbeat = db.prepare('SELECT MAX(started_at) AS last_run FROM capture_run').get();
        if (!heartbeat?.last_run) {
            fail('capture_run is empty, so the capture service has never recorded a run.');
            return;
        }
        const heartbeatAge = ageMs(heartbeat.last_run, now);
        if (heartbeatAge > HEARTBEAT_MAX_AGE_MS) {
            fail(`Capture scheduler looks stopped: last run of any task was ${minutes(heartbeatAge)} ago.`);
        }

        const rows = db
            .prepare(
                `
      SELECT task,
             MAX(CASE WHEN outcome != 'error' THEN started_at END) AS last_success
      FROM capture_run GROUP BY task`
            )
            .all();
        const seen = new Map(rows.map((row) => [row.task, row.last_success]));

        for (const [task, maxAge] of Object.entries(TASK_MAX_AGE_MS)) {
            if (!seen.has(task)) continue;
            const lastSuccess = seen.get(task);
            if (!lastSuccess) {
                fail(`Task ${task} has no successful run on record; every attempt is erroring.`);
                continue;
            }
            const age = ageMs(lastSuccess, now);
            if (age > maxAge) {
                fail(`Task ${task} last succeeded ${minutes(age)} ago, over its ${minutes(maxAge)} limit.`);
            }
        }
    } finally {
        db.close();
    }
}

async function ping(url) {
    if (!url) return;
    try {
        await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    } catch (error) {
        console.warn(`heartbeat ping failed: ${error.message}`);
    }
}

function readState() {
    try {
        return JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
        return {};
    }
}

function notify(signature, body, now) {
    const state = readState();
    const repeat =
        state.signature === signature && state.notifiedAt && now - Date.parse(state.notifiedAt) < RENOTIFY_MS;
    if (repeat) return false;

    try {
        execFileSync(
            'pwsh',
            [
                '-NoProfile',
                '-File',
                PUSHOVER,
                '-Title',
                'ferry_tracker: health check failed',
                '-Message',
                body,
                '-Force',
            ],
            { encoding: 'utf8' }
        );
    } catch (error) {
        console.error(`Pushover send failed: ${error.message}`);
    }
    // Losing the throttle record must never cost us the alert or the heartbeat ping.
    try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(statePath, JSON.stringify({ signature, notifiedAt: new Date(now).toISOString() }, null, 2));
    } catch (error) {
        console.warn(`Could not record watchdog state: ${error.message}`);
    }
    return true;
}

const now = Date.now();

if (!serviceRunning(SERVICE_NAME)) fail(`The ${SERVICE_NAME} service is not running, so the public hostname is down.`);
if (!(await portOpen(config.port))) fail(`Nothing is listening on port ${config.port}.`);

const disk = await checkFreeSpace(dataDir, MIN_FREE_DISK_MB);
if (!disk.ok)
    fail(
        `Free disk is ${Math.round(disk.freeMb / 1024)} GB, under the ${Math.round(MIN_FREE_DISK_MB / 1024)} GB floor.`
    );

checkCapture(now);

const healthchecksUrl = process.env.HEALTHCHECKS_URL;
if (failures.length === 0) {
    await ping(healthchecksUrl);
    console.log(`${new Date(now).toISOString()} watchdog ok`);
    process.exit(0);
}

const body = failures.join(' ');
const signature = failures.join('|');
const sent = notify(signature, body, now);
await ping(healthchecksUrl ? `${healthchecksUrl}/fail` : undefined);
console.error(`${new Date(now).toISOString()} watchdog FAILED (${failures.length}, notified=${sent}): ${body}`);
process.exit(1);
