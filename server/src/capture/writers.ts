import { pacificParts, parseWsdotDate, terminalSailingSpaceSchema, vesselLocationSchema } from '@ferry-tracker/shared';
import type { Db, Stmt } from '../db/database.js';
import { canonical, sha256 } from './hash.js';

export interface WriteResult {
  written: number;
  skipped: number;
  invalid: number;
}

const insertVessel = `INSERT INTO vessel_observation (
  vessel_id, vessel_name, source_timestamp, captured_at, content_hash,
  departing_terminal_id, departing_terminal_name, arriving_terminal_id, arriving_terminal_name,
  latitude, longitude, speed, heading, in_service, at_dock, left_dock, eta, eta_basis,
  scheduled_departure, op_route_abbrev
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE NOT EXISTS (
  SELECT 1 FROM vessel_observation
  WHERE vessel_id = ? AND source_timestamp = ? AND content_hash = ?
)`;

export function writeVesselObservations(db: Db, payload: unknown, capturedAt: string): WriteResult {
  const records = Array.isArray(payload) ? payload : [];
  const result: WriteResult = { written: 0, skipped: 0, invalid: 0 };
  const insert = db.prepare(insertVessel);
  const latest = db.prepare('SELECT content_hash FROM vessel_observation WHERE vessel_id = ? ORDER BY id DESC LIMIT 1');

  const run = db.transaction(() => {
    for (const record of records) {
      const parsed = vesselLocationSchema.safeParse(record);
      if (!parsed.success) {
        result.invalid += 1;
        continue;
      }
      const vessel = parsed.data;
      const content = {
        departingTerminalId: vessel.DepartingTerminalID ?? null,
        departingTerminalName: vessel.DepartingTerminalName ?? null,
        arrivingTerminalId: vessel.ArrivingTerminalID ?? null,
        arrivingTerminalName: vessel.ArrivingTerminalName ?? null,
        latitude: vessel.Latitude ?? null,
        longitude: vessel.Longitude ?? null,
        speed: vessel.Speed ?? null,
        heading: vessel.Heading ?? null,
        inService: bit(vessel.InService),
        atDock: bit(vessel.AtDock),
        leftDock: parseWsdotDate(vessel.LeftDock),
        eta: parseWsdotDate(vessel.Eta),
        etaBasis: vessel.EtaBasis ?? null,
        scheduledDeparture: parseWsdotDate(vessel.ScheduledDeparture),
        opRouteAbbrev: vessel.OpRouteAbbrev ?? null,
      };
      const contentHash = sha256(canonical(content));
      const sourceTimestamp = parseWsdotDate(vessel.TimeStamp);

      // Without a source timestamp the unique index cannot help, so compare against the
      // vessel's previous row. That still records a genuine A -> B -> A sequence.
      if (sourceTimestamp === null) {
        const previous = latest.get(vessel.VesselID) as { content_hash: string } | undefined;
        if (previous?.content_hash === contentHash) {
          result.skipped += 1;
          continue;
        }
      }

      const info = insert.run(
        vessel.VesselID,
        vessel.VesselName,
        sourceTimestamp,
        capturedAt,
        contentHash,
        content.departingTerminalId,
        content.departingTerminalName,
        content.arrivingTerminalId,
        content.arrivingTerminalName,
        content.latitude,
        content.longitude,
        content.speed,
        content.heading,
        content.inService,
        content.atDock,
        content.leftDock,
        content.eta,
        content.etaBasis,
        content.scheduledDeparture,
        content.opRouteAbbrev === null ? null : JSON.stringify(content.opRouteAbbrev),
        vessel.VesselID,
        sourceTimestamp,
        contentHash,
      );
      if (info.changes > 0) result.written += 1;
      else result.skipped += 1;
    }
  });

  run();
  return result;
}

interface SpaceRow {
  departingTerminalId: number;
  departingTerminalName: string;
  arrivingTerminalId: number;
  arrivingTerminalName: string;
  departure: string;
  vesselId: number | null;
  vesselName: string | null;
  isCancelled: number;
  driveUpSpaceCount: number | null;
  reservableSpaceCount: number | null;
  maxSpaceCount: number | null;
}

const insertSpace = `INSERT INTO sailing_space_observation (
  captured_at, departing_terminal_id, departing_terminal_name, arriving_terminal_id, arriving_terminal_name,
  departure, vessel_id, vessel_name, is_cancelled, drive_up_space_count, reservable_space_count,
  max_space_count, observation_kind, service_date, weekday, hour_local
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function writeSailingSpaceObservations(db: Db, payload: unknown, capturedAt: string): WriteResult {
  const result: WriteResult = { written: 0, skipped: 0, invalid: 0 };
  const rows = flattenSpaces(payload, result);
  if (rows.length === 0) return result;

  const insertObservation = db.prepare(insertSpace);
  const findDeparture = db.prepare(
    'SELECT id, vessel_id FROM sailing_space_departure WHERE departing_terminal_id = ? AND arriving_terminal_id = ? AND departure = ?',
  );
  const insertDeparture = db.prepare(`INSERT INTO sailing_space_departure (
    departing_terminal_id, arriving_terminal_id, departure, vessel_id,
    first_seen_at, last_seen_at, last_seen_before_departure, finalized, service_date, weekday, hour_local
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);
  const touchDeparture = db.prepare(
    'UPDATE sailing_space_departure SET last_seen_at = ?, last_seen_before_departure = ?, vessel_id = ? WHERE id = ?',
  );
  const latestObservation = db.prepare(`SELECT vessel_id, is_cancelled, drive_up_space_count, reservable_space_count, max_space_count
    FROM sailing_space_observation
    WHERE departing_terminal_id = ? AND arriving_terminal_id = ? AND departure = ?
    ORDER BY id DESC LIMIT 1`);

  const seen = new Set<string>();

  const run = db.transaction(() => {
    for (const row of rows) {
      const parts = pacificParts(row.departure);
      if (!parts) {
        result.invalid += 1;
        continue;
      }
      seen.add(`${row.departingTerminalId}|${row.arrivingTerminalId}|${row.departure}`);
      const beforeDeparture = capturedAt < row.departure ? 1 : 0;
      const existing = findDeparture.get(row.departingTerminalId, row.arrivingTerminalId, row.departure) as
        | { id: number; vessel_id: number | null }
        | undefined;

      if (!existing) {
        insertDeparture.run(
          row.departingTerminalId,
          row.arrivingTerminalId,
          row.departure,
          row.vesselId,
          capturedAt,
          capturedAt,
          beforeDeparture,
          parts.serviceDate,
          parts.weekday,
          parts.hourLocal,
        );
        writeObservation(insertObservation, row, capturedAt, 'baseline', parts);
        result.written += 1;
        continue;
      }

      touchDeparture.run(capturedAt, beforeDeparture, row.vesselId, existing.id);
      const previous = latestObservation.get(row.departingTerminalId, row.arrivingTerminalId, row.departure) as
        | Record<string, unknown>
        | undefined;
      if (previous && !spaceChanged(previous, row)) {
        result.skipped += 1;
        continue;
      }
      writeObservation(insertObservation, row, capturedAt, 'change', parts);
      result.written += 1;
    }

    result.written += finalizeDepartures(db, insertObservation, seen, capturedAt);
  });

  run();
  return result;
}

function finalizeDepartures(
  db: Db,
  insertObservation: Stmt,
  seen: Set<string>,
  capturedAt: string,
): number {
  const open = db
    .prepare('SELECT * FROM sailing_space_departure WHERE finalized = 0')
    .all() as Array<Record<string, unknown>>;
  const finalize = db.prepare('UPDATE sailing_space_departure SET finalized = 1 WHERE id = ?');
  const latestObservation = db.prepare(`SELECT * FROM sailing_space_observation
    WHERE departing_terminal_id = ? AND arriving_terminal_id = ? AND departure = ?
    ORDER BY id DESC LIMIT 1`);

  let written = 0;
  for (const departure of open) {
    const key = `${departure.departing_terminal_id}|${departure.arriving_terminal_id}|${departure.departure}`;
    if (seen.has(key)) continue;

    const last = latestObservation.get(
      departure.departing_terminal_id,
      departure.arriving_terminal_id,
      departure.departure,
    ) as Record<string, unknown> | undefined;
    if (last) {
      insertObservation.run(
        departure.last_seen_at ?? capturedAt,
        last.departing_terminal_id,
        last.departing_terminal_name,
        last.arriving_terminal_id,
        last.arriving_terminal_name,
        last.departure,
        last.vessel_id,
        last.vessel_name,
        last.is_cancelled,
        last.drive_up_space_count,
        last.reservable_space_count,
        last.max_space_count,
        'final',
        last.service_date,
        last.weekday,
        last.hour_local,
      );
      written += 1;
    }
    finalize.run(departure.id);
  }
  return written;
}

function writeObservation(
  statement: Stmt,
  row: SpaceRow,
  capturedAt: string,
  kind: 'baseline' | 'change' | 'final',
  parts: { serviceDate: string; weekday: number; hourLocal: number },
): void {
  statement.run(
    capturedAt,
    row.departingTerminalId,
    row.departingTerminalName,
    row.arrivingTerminalId,
    row.arrivingTerminalName,
    row.departure,
    row.vesselId,
    row.vesselName,
    row.isCancelled,
    row.driveUpSpaceCount,
    row.reservableSpaceCount,
    row.maxSpaceCount,
    kind,
    parts.serviceDate,
    parts.weekday,
    parts.hourLocal,
  );
}

function spaceChanged(previous: Record<string, unknown>, row: SpaceRow): boolean {
  return (
    previous.vessel_id !== row.vesselId ||
    previous.is_cancelled !== row.isCancelled ||
    previous.drive_up_space_count !== row.driveUpSpaceCount ||
    previous.reservable_space_count !== row.reservableSpaceCount ||
    previous.max_space_count !== row.maxSpaceCount
  );
}

function flattenSpaces(payload: unknown, result: WriteResult): SpaceRow[] {
  const terminals = Array.isArray(payload) ? payload : [];
  const rows: SpaceRow[] = [];

  for (const entry of terminals) {
    const parsed = terminalSailingSpaceSchema.safeParse(entry);
    if (!parsed.success) {
      result.invalid += 1;
      continue;
    }
    const terminal = parsed.data;
    for (const sailing of terminal.DepartingSpaces) {
      const departure = parseWsdotDate(sailing.Departure);
      if (!departure) {
        result.invalid += 1;
        continue;
      }
      for (const arrival of sailing.SpaceForArrivalTerminals) {
        rows.push({
          departingTerminalId: terminal.TerminalID,
          departingTerminalName: terminal.TerminalName,
          arrivingTerminalId: arrival.TerminalID,
          arrivingTerminalName: arrival.TerminalName,
          departure,
          vesselId: sailing.VesselID ?? null,
          vesselName: sailing.VesselName ?? null,
          isCancelled: sailing.IsCancelled ? 1 : 0,
          driveUpSpaceCount: arrival.DisplayDriveUpSpace ? arrival.DriveUpSpaceCount ?? null : null,
          reservableSpaceCount: arrival.DisplayReservableSpace ? arrival.ReservableSpaceCount ?? null : null,
          maxSpaceCount: arrival.MaxSpaceCount ?? sailing.MaxSpaceCount ?? null,
        });
      }
    }
  }
  return rows;
}

function bit(value: boolean | null | undefined): number | null {
  return value === null || value === undefined ? null : value ? 1 : 0;
}
