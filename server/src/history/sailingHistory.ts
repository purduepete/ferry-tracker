import type { SailingView } from '@ferry-tracker/shared';
import { pacificParts, spaceCount } from '@ferry-tracker/shared';
import type { Db } from '../db/database.js';

export const MAX_HISTORY_DAYS = 14;

export interface RecordedSpace {
  departure: string;
  vesselId: number | null;
  vesselName: string | null;
  isCancelled: boolean;
  driveUpSpaceCount: number | null;
  reservableSpaceCount: number | null;
  maxSpaceCount: number | null;
  observedAt: string;
  leadSeconds: number;
}

export interface RecordedLeg {
  scheduledDeparture: string;
  actualDeparture: string;
  actualArrival: string | null;
  departureDelayMinutes: number | null;
}

export interface SailingHistory {
  recordedSpaces(departingId: number, arrivingId: number, fromIso: string, toIso: string): Map<string, RecordedSpace>;
  recordedLegs(departingId: number, arrivingId: number, fromIso: string, toIso: string): Map<string, RecordedLeg>;
  serviceDates(departingId: number, arrivingId: number): string[];
  daySailings(departingId: number, arrivingId: number, serviceDate: string): SailingView[];
}

interface ObservationRow {
  departure: string;
  arriving_terminal_id: number;
  vessel_id: number | null;
  vessel_name: string | null;
  is_cancelled: number;
  drive_up_space_count: number | null;
  reservable_space_count: number | null;
  max_space_count: number | null;
  captured_at: string;
}

interface LegRow {
  scheduled_departure: string | null;
  departed_at: string;
  dock_arrival_at: string | null;
  departure_delay_minutes: number | null;
}

interface SnapshotRow {
  departing_time: string;
  arriving_time: string | null;
  vessel_id: number | null;
  vessel_name: string | null;
}

// The timetable is published a day ahead, so a future date would offer a day with no
// recorded space or legs behind it.
const SERVICE_DATE_SQL = `
  SELECT DISTINCT service_date
  FROM schedule_snapshot
  WHERE departing_terminal_id = ? AND arriving_terminal_id = ?
    AND service_date <= ?
  ORDER BY service_date DESC
  LIMIT ?`;

const DAY_SCHEDULE_SQL = `
  SELECT departing_time, arriving_time, vessel_id, vessel_name
  FROM schedule_snapshot
  WHERE service_date = ? AND departing_terminal_id = ? AND arriving_terminal_id = ?
  ORDER BY departing_time`;

// Widened past the first and last sailing so a boat that loaded before midnight still matches.
const DAY_MARGIN_MS = 2 * 60 * 60 * 1000;

// The last reading before a boat sails is the closest thing to what it actually left with,
// so the join pins each departure to its own MAX(captured_at) rather than aggregating.
const LAST_OBSERVATION_SQL = `
  SELECT o.departure, o.arriving_terminal_id, o.vessel_id, o.vessel_name, o.is_cancelled,
         o.drive_up_space_count, o.reservable_space_count, o.max_space_count, o.captured_at
  FROM sailing_space_observation o
  JOIN (
    SELECT departing_terminal_id, arriving_terminal_id, departure, MAX(captured_at) AS captured_at
    FROM sailing_space_observation
    WHERE departing_terminal_id = ?
      AND arriving_terminal_id IN (?, ?)
      AND departure >= ? AND departure <= ?
      AND captured_at <= departure
    GROUP BY departing_terminal_id, arriving_terminal_id, departure
  ) last
    ON last.departing_terminal_id = o.departing_terminal_id
   AND last.arriving_terminal_id = o.arriving_terminal_id
   AND last.departure = o.departure
   AND last.captured_at = o.captured_at
  WHERE o.departing_terminal_id = ?
    AND o.arriving_terminal_id IN (?, ?)
    AND o.departure >= ? AND o.departure <= ?
    AND o.captured_at <= o.departure
  ORDER BY o.departure`;

// A leg the rollup could not vouch for would misreport lateness, so graded-down legs never
// surface. A negative delay is one of those: a ferry never leaves early, so the leg was
// paired with the wrong slot and the true one is unknowable after the fact.
const LEG_SQL = `
  SELECT scheduled_departure, departed_at, dock_arrival_at, departure_delay_minutes
  FROM sailing_leg
  WHERE departing_terminal_id = ?
    AND arriving_terminal_id = ?
    AND scheduled_departure IS NOT NULL
    AND scheduled_departure >= ? AND scheduled_departure <= ?
    AND confidence <> 'low'
    AND exclusion_reason IS NULL
    AND (departure_delay_minutes IS NULL OR departure_delay_minutes >= 0)
  ORDER BY scheduled_departure, departed_at`;

export class DatabaseSailingHistory implements SailingHistory {
  constructor(private readonly db: Db) {}

  serviceDates(departingId: number, arrivingId: number): string[] {
    const today = pacificParts(new Date())?.serviceDate;
    const rows = this.db.prepare(SERVICE_DATE_SQL).all(departingId, arrivingId, today, MAX_HISTORY_DAYS) as Array<{ service_date: string }>;
    return rows.map((row) => row.service_date);
  }

  daySailings(departingId: number, arrivingId: number, serviceDate: string): SailingView[] {
    const rows = this.db.prepare(DAY_SCHEDULE_SQL).all(serviceDate, departingId, arrivingId) as SnapshotRow[];
    if (rows.length === 0) return [];

    const first = Date.parse(rows[0].departing_time);
    const last = Date.parse(rows[rows.length - 1].departing_time);
    const fromIso = new Date(first - DAY_MARGIN_MS).toISOString();
    const toIso = new Date(last + DAY_MARGIN_MS).toISOString();
    const spaces = this.recordedSpaces(departingId, arrivingId, fromIso, toIso);
    const legs = this.recordedLegs(departingId, arrivingId, fromIso, toIso);

    return rows.map((row) => {
      const space = spaces.get(row.departing_time);
      const leg = legs.get(row.departing_time);
      return {
        vesselId: row.vessel_id,
        vesselName: row.vessel_name,
        departingTime: row.departing_time,
        arrivingTime: row.arriving_time,
        departingTerminalId: departingId,
        arrivingTerminalId: arrivingId,
        isCancelled: space?.isCancelled ?? null,
        driveUpSpaceCount: space?.driveUpSpaceCount ?? null,
        reservableSpaceCount: space?.reservableSpaceCount ?? null,
        maxSpaceCount: space?.maxSpaceCount ?? null,
        spaceAvailable: space !== undefined,
        spaceSource: space === undefined ? null : 'recorded',
        spaceObservedAt: space?.observedAt ?? null,
        spaceLeadSeconds: space?.leadSeconds ?? null,
        actualDeparture: leg?.actualDeparture ?? null,
        actualArrival: leg?.actualArrival ?? null,
        departureDelayMinutes: leg?.departureDelayMinutes ?? null,
        raw: { ...row },
      };
    });
  }

  recordedLegs(departingId: number, arrivingId: number, fromIso: string, toIso: string): Map<string, RecordedLeg> {
    const rows = this.db.prepare(LEG_SQL).all(departingId, arrivingId, fromIso, toIso) as LegRow[];
    const legs = new Map<string, RecordedLeg>();
    for (const row of rows) {
      if (row.scheduled_departure === null || legs.has(row.scheduled_departure)) continue;
      legs.set(row.scheduled_departure, {
        scheduledDeparture: row.scheduled_departure,
        actualDeparture: row.departed_at,
        actualArrival: row.dock_arrival_at,
        departureDelayMinutes: row.departure_delay_minutes,
      });
    }
    return legs;
  }

  recordedSpaces(departingId: number, arrivingId: number, fromIso: string, toIso: string): Map<string, RecordedSpace> {
    const rows = this.db
      .prepare(LAST_OBSERVATION_SQL)
      .all(departingId, arrivingId, departingId, fromIso, toIso, departingId, arrivingId, departingId, fromIso, toIso) as ObservationRow[];

    // A multi-destination sailing is stored against the departing terminal because WSDOT puts
    // the real destinations in ArrivalTerminalIDs, so it stands in only when nothing exact exists.
    const exact = new Map<string, RecordedSpace>();
    const placeholder = new Map<string, RecordedSpace>();
    for (const row of rows) {
      const target = row.arriving_terminal_id === arrivingId ? exact : placeholder;
      const existing = target.get(row.departure);
      if (!existing || existing.observedAt < row.captured_at) target.set(row.departure, toRecordedSpace(row));
    }
    for (const [departure, space] of exact) placeholder.set(departure, space);
    return placeholder;
  }
}

function toRecordedSpace(row: ObservationRow): RecordedSpace {
  const departedAt = Date.parse(row.departure);
  const observedAt = Date.parse(row.captured_at);
  return {
    departure: row.departure,
    vesselId: row.vessel_id,
    vesselName: row.vessel_name,
    isCancelled: row.is_cancelled === 1,
    driveUpSpaceCount: spaceCount(row.drive_up_space_count),
    reservableSpaceCount: spaceCount(row.reservable_space_count),
    maxSpaceCount: spaceCount(row.max_space_count),
    observedAt: row.captured_at,
    leadSeconds: Number.isNaN(departedAt) || Number.isNaN(observedAt) ? 0 : Math.round((departedAt - observedAt) / 1000),
  };
}
