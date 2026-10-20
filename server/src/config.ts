import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../.env.local', import.meta.url)) });
if (process.env.FERRY_ENV_FALLBACK_FILE) dotenv.config({ path: process.env.FERRY_ENV_FALLBACK_FILE });
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface CaptureConfig {
    enabled: boolean;
    allowFixtureSource: boolean;
    dbPath: string;
    rawArchiveDir: string;
    vesselIntervalMs: number;
    spaceIntervalMs: number;
    referenceIntervalMs: number;
    scheduleIntervalMs: number;
    rollupIntervalMs: number;
    retentionDays: number | null;
    dwellCeilingMinutes: number;
    dockDebounceSeconds: number;
    minFreeDiskMb: number;
    statusEnabled: boolean;
}

export interface AppConfig {
    host: string;
    port: number;
    dataSource: 'live' | 'fixture';
    apiAccessCode?: string;
    /** Shared secret for /api/catch. Unset leaves the route off entirely. */
    catchToken?: string;
    /** Every secret that must never reach a response, a log line or the raw archive. */
    secrets: string[];
    rawInspector: boolean;
    fixtureNow?: string;
    capture: CaptureConfig;
}

export function getConfig(): AppConfig {
    const dataSource = process.env.DATA_SOURCE === 'live' ? 'live' : 'fixture';
    const apiAccessCode = process.env.WSDOT_API_ACCESS_CODE;
    const catchToken = process.env.CATCH_TOKEN || undefined;
    return {
        host: process.env.HOST || '0.0.0.0',
        port: Number(process.env.PORT ?? 8787),
        dataSource,
        apiAccessCode,
        catchToken,
        secrets: [apiAccessCode, catchToken, process.env.DATABASE_URL].filter((secret): secret is string =>
            Boolean(secret)
        ),
        rawInspector: process.env.ENABLE_RAW_INSPECTOR !== 'false',
        fixtureNow: dataSource === 'fixture' ? process.env.FIXTURE_NOW : undefined,
        capture: getCaptureConfig(),
    };
}

function getCaptureConfig(): CaptureConfig {
    const dataDir = process.env.CAPTURE_DATA_DIR || path.join(repoRoot, 'data');
    return {
        enabled: process.env.CAPTURE_ENABLED === 'true',
        allowFixtureSource: process.env.CAPTURE_ALLOW_FIXTURE === 'true',
        dbPath: process.env.CAPTURE_DB_PATH || path.join(dataDir, 'ferry-capture.db'),
        rawArchiveDir: process.env.CAPTURE_ARCHIVE_DIR || path.join(dataDir, 'raw'),
        vesselIntervalMs: positive(process.env.CAPTURE_VESSEL_INTERVAL_MS, 30_000),
        spaceIntervalMs: positive(process.env.CAPTURE_SPACE_INTERVAL_MS, 60_000),
        referenceIntervalMs: positive(process.env.CAPTURE_REFERENCE_INTERVAL_MS, 21_600_000),
        // Hourly rather than every 6 hours, because a timetable revision is only reflected in the
        // Historical view once the next capture reconciles it.
        scheduleIntervalMs: positive(process.env.CAPTURE_SCHEDULE_INTERVAL_MS, 3_600_000),
        // A dock arrival only reaches the Sailings table once the rollup closes the leg, and the
        // rollup holds an arrival back until it has outlived the debounce window, so an arrival
        // shows up within dockDebounceSeconds plus one of these.
        rollupIntervalMs: positive(process.env.CAPTURE_ROLLUP_INTERVAL_MS, 60_000),
        retentionDays: retention(process.env.CAPTURE_RETENTION_DAYS),
        dwellCeilingMinutes: positive(process.env.CAPTURE_DWELL_CEILING_MINUTES, 120),
        // Twice the p99 poll gap of 60s, so a blip cannot outlive it. The ceiling is the
        // shortest genuine dock turnaround, not the shortest crossing: replaying the captured
        // observations at 300s drops 10 real legs by swallowing quick interisland turnarounds.
        dockDebounceSeconds: positive(process.env.CAPTURE_DOCK_DEBOUNCE_SECONDS, 120),
        minFreeDiskMb: positive(process.env.CAPTURE_MIN_FREE_DISK_MB, 512),
        statusEnabled: process.env.CAPTURE_STATUS_ENABLED !== 'false',
    };
}

function positive(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function retention(value: string | undefined): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
