// Portability: every column type and index form here has a direct Azure SQL equivalent.
// ISO 8601 UTC text -> datetime2, 0/1 INTEGER -> BIT, REAL -> FLOAT, TEXT -> NVARCHAR.
// Date arithmetic stays in TypeScript so no view ever calls a dialect-specific function.

export interface Migration {
    version: number;
    statements: string[];
}

export const migrations: Migration[] = [
    {
        version: 1,
        statements: [
            `CREATE TABLE capture_run (
        id INTEGER PRIMARY KEY,
        task TEXT NOT NULL,
        endpoint_id TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        response_hash TEXT,
        changed INTEGER,
        rows_written INTEGER NOT NULL DEFAULT 0,
        rows_skipped INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL,
        error_category TEXT,
        error_detail TEXT
      )`,
            `CREATE INDEX ix_capture_run_task ON capture_run (task, started_at)`,

            `CREATE TABLE vessel_observation (
        id INTEGER PRIMARY KEY,
        vessel_id INTEGER NOT NULL,
        vessel_name TEXT NOT NULL,
        source_timestamp TEXT,
        captured_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        departing_terminal_id INTEGER,
        departing_terminal_name TEXT,
        arriving_terminal_id INTEGER,
        arriving_terminal_name TEXT,
        latitude REAL,
        longitude REAL,
        speed REAL,
        heading REAL,
        in_service INTEGER,
        at_dock INTEGER,
        left_dock TEXT,
        eta TEXT,
        eta_basis TEXT,
        scheduled_departure TEXT,
        op_route_abbrev TEXT
      )`,
            // Filtered so a null source timestamp falls through to the writer's last-row
            // content check, which still allows a genuine A -> B -> A sequence.
            `CREATE UNIQUE INDEX ux_vessel_observation_source
        ON vessel_observation (vessel_id, source_timestamp, content_hash)
        WHERE source_timestamp IS NOT NULL`,
            `CREATE INDEX ix_vessel_observation_vessel ON vessel_observation (vessel_id, source_timestamp)`,
            `CREATE INDEX ix_vessel_observation_captured ON vessel_observation (captured_at)`,

            `CREATE TABLE sailing_space_observation (
        id INTEGER PRIMARY KEY,
        captured_at TEXT NOT NULL,
        departing_terminal_id INTEGER NOT NULL,
        departing_terminal_name TEXT NOT NULL,
        arriving_terminal_id INTEGER NOT NULL,
        arriving_terminal_name TEXT NOT NULL,
        departure TEXT NOT NULL,
        vessel_id INTEGER,
        vessel_name TEXT,
        is_cancelled INTEGER NOT NULL,
        drive_up_space_count INTEGER,
        reservable_space_count INTEGER,
        max_space_count INTEGER,
        observation_kind TEXT NOT NULL,
        service_date TEXT NOT NULL,
        weekday INTEGER NOT NULL,
        hour_local INTEGER NOT NULL
      )`,
            `CREATE INDEX ix_sailing_space_observation_departure
        ON sailing_space_observation (departing_terminal_id, arriving_terminal_id, departure)`,

            `CREATE TABLE sailing_space_departure (
        id INTEGER PRIMARY KEY,
        departing_terminal_id INTEGER NOT NULL,
        arriving_terminal_id INTEGER NOT NULL,
        departure TEXT NOT NULL,
        vessel_id INTEGER,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_seen_before_departure INTEGER NOT NULL,
        finalized INTEGER NOT NULL DEFAULT 0,
        service_date TEXT NOT NULL,
        weekday INTEGER NOT NULL,
        hour_local INTEGER NOT NULL
      )`,
            `CREATE UNIQUE INDEX ux_sailing_space_departure
        ON sailing_space_departure (departing_terminal_id, arriving_terminal_id, departure)`,

            `CREATE TABLE sailing_leg (
        id INTEGER PRIMARY KEY,
        vessel_id INTEGER NOT NULL,
        vessel_name TEXT NOT NULL,
        departing_terminal_id INTEGER,
        arriving_terminal_id INTEGER,
        op_route_abbrev TEXT,
        scheduled_departure TEXT,
        scheduled_departure_source TEXT,
        left_dock TEXT,
        departed_at TEXT NOT NULL,
        dock_arrival_at TEXT,
        previous_arrival_at TEXT,
        departure_delay_minutes REAL,
        load_minutes REAL,
        crossing_minutes REAL,
        complete INTEGER NOT NULL DEFAULT 0,
        confidence TEXT NOT NULL,
        exclusion_reason TEXT,
        service_date TEXT NOT NULL,
        weekday INTEGER NOT NULL,
        hour_local INTEGER NOT NULL
      )`,
            `CREATE UNIQUE INDEX ux_sailing_leg ON sailing_leg (vessel_id, departed_at)`,

            `CREATE TABLE schedule_snapshot (
        id INTEGER PRIMARY KEY,
        captured_at TEXT NOT NULL,
        service_date TEXT NOT NULL,
        departing_terminal_id INTEGER NOT NULL,
        arriving_terminal_id INTEGER NOT NULL,
        departing_time TEXT NOT NULL,
        arriving_time TEXT,
        vessel_id INTEGER,
        vessel_name TEXT,
        loading_rule INTEGER
      )`,
            `CREATE UNIQUE INDEX ux_schedule_snapshot
        ON schedule_snapshot (service_date, departing_terminal_id, arriving_terminal_id, departing_time)`,

            `CREATE TABLE vessel_reference (
        vessel_id INTEGER PRIMARY KEY,
        vessel_name TEXT NOT NULL,
        class_name TEXT,
        max_passengers INTEGER,
        max_vehicles INTEGER,
        status INTEGER,
        updated_at TEXT NOT NULL
      )`,

            `CREATE TABLE terminal_reference (
        terminal_id INTEGER PRIMARY KEY,
        terminal_name TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        city TEXT,
        updated_at TEXT NOT NULL
      )`,

            `CREATE TABLE archive_file (
        id INTEGER PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        service_date TEXT NOT NULL,
        path TEXT NOT NULL,
        member_count INTEGER NOT NULL DEFAULT 0,
        byte_size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
            `CREATE UNIQUE INDEX ux_archive_file ON archive_file (endpoint_id, service_date)`,

            `CREATE TABLE rollup_state (
        name TEXT PRIMARY KEY,
        watermark TEXT,
        updated_at TEXT NOT NULL
      )`,
        ],
    },
    {
        version: 2,
        statements: [
            // Separate from exclusion_reason so a leg with a trustworthy crossing but an
            // untrustworthy dwell is still usable for crossing analysis.
            `ALTER TABLE sailing_leg ADD COLUMN load_exclusion_reason TEXT`,
            `ALTER TABLE capture_run ADD COLUMN service_date TEXT`,
            `CREATE INDEX ix_capture_run_service_date ON capture_run (service_date, task)`,
        ],
    },
    {
        version: 3,
        statements: [
            // Set when WSDOT stops publishing a future slot. The row stays so the rollup can still pair a
            // completed leg to it, and clears again if the slot comes back.
            `ALTER TABLE schedule_snapshot ADD COLUMN withdrawn_at TEXT`,
        ],
    },
    {
        version: 4,
        statements: [
            `CREATE TABLE notification_subscriptions (
                scope TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                settings_json TEXT NOT NULL,
                state_json TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            )`,
            `CREATE TABLE notification_events (
                event_key TEXT PRIMARY KEY,
                scope TEXT NOT NULL REFERENCES notification_subscriptions(scope),
                status TEXT NOT NULL CHECK (status IN ('claimed', 'accepted', 'failed', 'uncertain')),
                claimed_at TEXT NOT NULL,
                finished_at TEXT,
                retry_at TEXT,
                attempts INTEGER NOT NULL DEFAULT 1,
                detail TEXT
            )`,
            `CREATE INDEX ix_notification_events_scope ON notification_events(scope, claimed_at)`,
        ],
    },
];

export const latestVersion = migrations.reduce((highest, migration) => Math.max(highest, migration.version), 0);
