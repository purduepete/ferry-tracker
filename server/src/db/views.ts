import type Database from 'better-sqlite3';

// Views are derived, so they are dropped and recreated on every open rather than
// versioned. Every one is a plain GROUP BY over columns bucketed in TypeScript.
export const views: Array<{ name: string; sql: string }> = [
    {
        name: 'v_departure_delay',
        sql: `CREATE VIEW v_departure_delay AS
      SELECT
        vessel_id, vessel_name, departing_terminal_id, arriving_terminal_id,
        service_date, weekday, hour_local,
        scheduled_departure, scheduled_departure_source, departed_at,
        departure_delay_minutes, confidence, exclusion_reason
      FROM sailing_leg
      WHERE departure_delay_minutes IS NOT NULL`,
    },
    {
        name: 'v_crossing_duration',
        sql: `CREATE VIEW v_crossing_duration AS
      SELECT
        vessel_id, vessel_name, departing_terminal_id, arriving_terminal_id,
        service_date, weekday, hour_local,
        departed_at, dock_arrival_at, crossing_minutes, confidence, exclusion_reason
      FROM sailing_leg
      WHERE complete = 1 AND crossing_minutes IS NOT NULL`,
    },
    {
        name: 'v_load_duration',
        sql: `CREATE VIEW v_load_duration AS
      SELECT
        vessel_id, vessel_name, departing_terminal_id, arriving_terminal_id,
        service_date, weekday, hour_local,
        previous_arrival_at, departed_at, scheduled_departure,
        load_minutes, confidence, load_exclusion_reason
      FROM sailing_leg
      WHERE load_minutes IS NOT NULL`,
    },
    {
        name: 'v_sailing_fill',
        sql: `CREATE VIEW v_sailing_fill AS
      SELECT
        d.departing_terminal_id,
        d.arriving_terminal_id,
        d.departure,
        d.vessel_id,
        d.service_date,
        d.weekday,
        d.hour_local,
        d.first_seen_at,
        d.last_seen_at,
        d.last_seen_before_departure,
        d.finalized,
        COUNT(o.id) AS observation_count,
        MAX(o.is_cancelled) AS is_cancelled,
        MAX(o.max_space_count) AS max_space_count,
        MIN(o.drive_up_space_count) AS min_drive_up_space,
        MIN(o.reservable_space_count) AS min_reservable_space,
        MIN(CASE
          WHEN o.drive_up_space_count IS NULL AND o.reservable_space_count IS NULL THEN NULL
          ELSE COALESCE(o.drive_up_space_count, 0) + COALESCE(o.reservable_space_count, 0)
        END) AS min_total_open_space,
        CASE WHEN MAX(o.max_space_count) > 0
          THEN 100.0 * (MAX(o.max_space_count) - MIN(o.drive_up_space_count)) / MAX(o.max_space_count)
        END AS drive_up_pct_full,
        CASE WHEN MAX(o.max_space_count) > 0
          THEN 100.0 * (MAX(o.max_space_count) - MIN(CASE
            WHEN o.drive_up_space_count IS NULL AND o.reservable_space_count IS NULL THEN NULL
            ELSE COALESCE(o.drive_up_space_count, 0) + COALESCE(o.reservable_space_count, 0)
          END)) / MAX(o.max_space_count)
        END AS total_pct_full
      FROM sailing_space_departure d
      JOIN sailing_space_observation o
        ON o.departing_terminal_id = d.departing_terminal_id
       AND o.arriving_terminal_id = d.arriving_terminal_id
       AND o.departure = d.departure
      GROUP BY
        d.departing_terminal_id, d.arriving_terminal_id, d.departure, d.vessel_id,
        d.service_date, d.weekday, d.hour_local,
        d.first_seen_at, d.last_seen_at, d.last_seen_before_departure, d.finalized`,
    },
    {
        name: 'v_update_cadence',
        sql: `CREATE VIEW v_update_cadence AS
      SELECT service_date, task, outcome, COUNT(*) AS runs,
             MIN(started_at) AS first_run, MAX(started_at) AS last_run
      FROM capture_run
      WHERE service_date IS NOT NULL
      GROUP BY service_date, task, outcome`,
    },
    {
        name: 'v_vessel_update_ratio',
        sql: `CREATE VIEW v_vessel_update_ratio AS
      SELECT vessel_id, vessel_name,
             COUNT(*) AS observations,
             COUNT(DISTINCT source_timestamp) AS distinct_source_timestamps,
             MIN(captured_at) AS first_captured_at,
             MAX(captured_at) AS last_captured_at
      FROM vessel_observation
      GROUP BY vessel_id, vessel_name`,
    },
];

export function applyViews(db: Database.Database): void {
    for (const view of views) {
        db.exec(`DROP VIEW IF EXISTS ${view.name}`);
        db.exec(view.sql);
    }
}

export const viewNames = views.map((view) => view.name);
