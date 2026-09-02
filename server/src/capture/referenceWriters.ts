import {
  pacificParts,
  parseWsdotDate,
  scheduleResponseSchema,
  terminalLocationSchema,
  terminalMateSchema,
  vesselBasicSchema,
} from '@ferry-tracker/shared';
import type { Db } from '../db/database.js';
import type { WsdotClient } from '../wsdotClient.js';
import type { WriteResult } from './writers.js';

export function writeReferenceData(db: Db, vessels: unknown, terminals: unknown, updatedAt: string): WriteResult {
  const result: WriteResult = { written: 0, skipped: 0, invalid: 0 };

  const upsertVessel = upsert(
    db,
    'SELECT vessel_id FROM vessel_reference WHERE vessel_id = ?',
    `INSERT INTO vessel_reference (vessel_id, vessel_name, class_name, max_passengers, max_vehicles, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `UPDATE vessel_reference SET vessel_name = ?, class_name = ?, max_passengers = ?, max_vehicles = ?, status = ?, updated_at = ?
      WHERE vessel_id = ?`,
  );
  const upsertTerminal = upsert(
    db,
    'SELECT terminal_id FROM terminal_reference WHERE terminal_id = ?',
    'INSERT INTO terminal_reference (terminal_id, terminal_name, latitude, longitude, city, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    'UPDATE terminal_reference SET terminal_name = ?, latitude = ?, longitude = ?, city = ?, updated_at = ? WHERE terminal_id = ?',
  );

  const run = db.transaction(() => {
    for (const entry of Array.isArray(vessels) ? vessels : []) {
      const parsed = vesselBasicSchema.safeParse(entry);
      if (!parsed.success) {
        result.invalid += 1;
        continue;
      }
      const vessel = parsed.data;
      upsertVessel(vessel.VesselID, [
        vessel.VesselName,
        vessel.Class?.ClassName ?? null,
        vessel.MaxPassengers ?? null,
        vessel.MaxVehicles ?? null,
        vessel.Status ?? null,
        updatedAt,
      ]);
      result.written += 1;
    }

    for (const entry of Array.isArray(terminals) ? terminals : []) {
      const parsed = terminalLocationSchema.safeParse(entry);
      if (!parsed.success) {
        result.invalid += 1;
        continue;
      }
      const terminal = parsed.data;
      upsertTerminal(terminal.TerminalID, [
        terminal.TerminalName ?? String(terminal.TerminalID),
        terminal.Latitude ?? null,
        terminal.Longitude ?? null,
        terminal.City ?? null,
        updatedAt,
      ]);
      result.written += 1;
    }
  });

  run();
  return result;
}

export async function writeScheduleSnapshots(
  db: Db,
  client: WsdotClient,
  mates: unknown,
  capturedAt: string,
  onPayload?: (payload: unknown, pair: string) => Promise<void>,
): Promise<WriteResult> {
  const result: WriteResult = { written: 0, skipped: 0, invalid: 0 };
  const pairs = new Map<string, { departingId: number; arrivingId: number }>();

  for (const entry of Array.isArray(mates) ? mates : []) {
    const parsed = terminalMateSchema.safeParse(entry);
    if (!parsed.success) {
      result.invalid += 1;
      continue;
    }
    const mate = parsed.data;
    pairs.set(`${mate.DepartingTerminalID}|${mate.ArrivingTerminalID}`, {
      departingId: mate.DepartingTerminalID,
      arrivingId: mate.ArrivingTerminalID,
    });
  }

  for (const [key, pair] of pairs) {
    const payload = await client.getSchedule(pair.departingId, pair.arrivingId, false);
    await onPayload?.(payload, key);
    const parsed = scheduleResponseSchema.safeParse(payload);
    if (!parsed.success) {
      result.invalid += 1;
      continue;
    }
    // One transaction per terminal pair keeps each write bounded.
    storeCombos(db, parsed.data.TerminalCombos, capturedAt, result);
  }

  return result;
}

function storeCombos(
  db: Db,
  combos: Array<{ DepartingTerminalID: number; ArrivingTerminalID: number; Times: Array<Record<string, unknown>> }>,
  capturedAt: string,
  result: WriteResult,
): void {
  const insert = db.prepare(`INSERT INTO schedule_snapshot (
    captured_at, service_date, departing_terminal_id, arriving_terminal_id,
    departing_time, arriving_time, vessel_id, vessel_name, loading_rule
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM schedule_snapshot
    WHERE service_date = ? AND departing_terminal_id = ? AND arriving_terminal_id = ? AND departing_time = ?
  )`);

  const run = db.transaction(() => {
    for (const combo of combos) {
      for (const time of combo.Times) {
        const departingTime = parseWsdotDate(time.DepartingTime);
        const parts = departingTime ? pacificParts(departingTime) : null;
        if (!departingTime || !parts) {
          result.invalid += 1;
          continue;
        }
        const info = insert.run(
          capturedAt,
          parts.serviceDate,
          combo.DepartingTerminalID,
          combo.ArrivingTerminalID,
          departingTime,
          parseWsdotDate(time.ArrivingTime),
          typeof time.VesselID === 'number' ? time.VesselID : null,
          typeof time.VesselName === 'string' ? time.VesselName : null,
          typeof time.LoadingRule === 'number' ? time.LoadingRule : null,
          parts.serviceDate,
          combo.DepartingTerminalID,
          combo.ArrivingTerminalID,
          departingTime,
        );
        if (info.changes > 0) result.written += 1;
        else result.skipped += 1;
      }
    }
  });

  run();
}

function upsert(db: Db, findSql: string, insertSql: string, updateSql: string) {
  const find = db.prepare(findSql);
  const insert = db.prepare(insertSql);
  const update = db.prepare(updateSql);
  // Select then write, because ON CONFLICT has no Azure SQL equivalent.
  return (id: number, values: Array<string | number | null>): void => {
    if (find.get(id)) update.run(...values, id);
    else insert.run(id, ...values);
  };
}
