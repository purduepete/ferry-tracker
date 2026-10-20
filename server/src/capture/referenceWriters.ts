import {
    pacificParts,
    parseWsdotDate,
    scheduleResponseSchema,
    terminalLocationSchema,
    terminalMateSchema,
    vesselBasicSchema,
} from '@ferry-tracker/shared';
import { transaction, type Db } from '../db/database.js';
import type { WsdotClient } from '../wsdotClient.js';
import type { WriteResult } from './writers.js';

export async function writeReferenceData(
    db: Db,
    vessels: unknown,
    terminals: unknown,
    updatedAt: string
): Promise<WriteResult> {
    const result: WriteResult = { written: 0, skipped: 0, invalid: 0 };

    const upsertVessel = upsert(
        db,
        'SELECT vessel_id FROM vessel_reference WHERE vessel_id = ?',
        `INSERT INTO vessel_reference (vessel_id, vessel_name, class_name, max_passengers, max_vehicles, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
        `UPDATE vessel_reference SET vessel_name = ?, class_name = ?, max_passengers = ?, max_vehicles = ?, status = ?, updated_at = ?
      WHERE vessel_id = ?`
    );
    const upsertTerminal = upsert(
        db,
        'SELECT terminal_id FROM terminal_reference WHERE terminal_id = ?',
        'INSERT INTO terminal_reference (terminal_id, terminal_name, latitude, longitude, city, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        'UPDATE terminal_reference SET terminal_name = ?, latitude = ?, longitude = ?, city = ?, updated_at = ? WHERE terminal_id = ?'
    );

    const run = transaction(db, async () => {
        for (const entry of Array.isArray(vessels) ? vessels : []) {
            const parsed = vesselBasicSchema.safeParse(entry);
            if (!parsed.success) {
                result.invalid += 1;
                continue;
            }
            const vessel = parsed.data;
            await upsertVessel(vessel.VesselID, [
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
            await upsertTerminal(terminal.TerminalID, [
                terminal.TerminalName ?? String(terminal.TerminalID),
                terminal.Latitude ?? null,
                terminal.Longitude ?? null,
                terminal.City ?? null,
                updatedAt,
            ]);
            result.written += 1;
        }
    });

    await run();
    return result;
}

export async function writeScheduleSnapshots(
    db: Db,
    client: WsdotClient,
    mates: unknown,
    capturedAt: string,
    onPayload?: (payload: unknown, pair: string) => Promise<void>,
    now: () => number = Date.now
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

    // A pair WSDOT drops from terminalmates for a day would otherwise never be visited again, leaving
    // its rows stale forever, so today's stored pairs are reconciled whether or not mates still lists them.
    const today = pacificParts(now())?.serviceDate ?? null;
    if (today !== null) {
        const stored = (await db
            .prepare(
                `SELECT DISTINCT departing_terminal_id AS "departingId", arriving_terminal_id AS "arrivingId"
      FROM schedule_snapshot WHERE service_date = ?`
            )
            .all(today)) as Array<{ departingId: number; arrivingId: number }>;
        for (const pair of stored) pairs.set(`${pair.departingId}|${pair.arrivingId}`, pair);
    }

    for (const [key, pair] of pairs) {
        const payload = await client.getSchedule(pair.departingId, pair.arrivingId, false, true);
        // Pairs are fetched one at a time, so the task start time can be far enough in the past that a
        // departure it calls "future" has already sailed. Stamp the moment this pair actually landed.
        const fetchedAt = now();
        await onPayload?.(payload, key);
        const parsed = scheduleResponseSchema.safeParse(payload);
        if (!parsed.success) {
            result.invalid += 1;
            continue;
        }
        // One transaction per terminal pair keeps each write bounded.
        await storeCombos(db, parsed.data.TerminalCombos, new Date(fetchedAt).toISOString(), result);
    }

    return result;
}

interface SnapshotRow {
    serviceDate: string;
    departingId: number;
    arrivingId: number;
    departingTime: string;
    values: Array<string | number | null>;
}

async function storeCombos(
    db: Db,
    combos: Array<{ DepartingTerminalID: number; ArrivingTerminalID: number; Times: Array<Record<string, unknown>> }>,
    capturedAt: string,
    result: WriteResult
): Promise<void> {
    const find = db.prepare(`SELECT id FROM schedule_snapshot
    WHERE service_date = ? AND departing_terminal_id = ? AND arriving_terminal_id = ? AND departing_time = ?`);
    const insert = db.prepare(`INSERT INTO schedule_snapshot (
    captured_at, service_date, departing_terminal_id, arriving_terminal_id,
    departing_time, arriving_time, vessel_id, vessel_name, loading_rule
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // A re-published slot clears withdrawn_at, so one truncated payload can never strand a row.
    const update = db.prepare(`UPDATE schedule_snapshot
    SET captured_at = ?, arriving_time = ?, vessel_id = ?, vessel_name = ?, loading_rule = ?, withdrawn_at = NULL
    WHERE id = ?`);

    const rows: SnapshotRow[] = [];
    for (const combo of combos) {
        for (const time of combo.Times) {
            const departingTime = parseWsdotDate(time.DepartingTime);
            const parts = departingTime ? pacificParts(departingTime) : null;
            if (!departingTime || !parts) {
                result.invalid += 1;
                continue;
            }
            rows.push({
                serviceDate: parts.serviceDate,
                departingId: combo.DepartingTerminalID,
                arrivingId: combo.ArrivingTerminalID,
                departingTime,
                values: [
                    parseWsdotDate(time.ArrivingTime),
                    typeof time.VesselID === 'number' ? time.VesselID : null,
                    typeof time.VesselName === 'string' ? time.VesselName : null,
                    typeof time.LoadingRule === 'number' ? time.LoadingRule : null,
                ],
            });
        }
    }

    const today = pacificParts(capturedAt)?.serviceDate ?? null;

    const run = transaction(db, async () => {
        for (const row of rows) {
            const existing = (await find.get(row.serviceDate, row.departingId, row.arrivingId, row.departingTime)) as
                { id: number } | undefined;
            // Select then write, because ON CONFLICT has no Azure SQL equivalent.
            if (existing) {
                await update.run(capturedAt, ...row.values, existing.id);
                result.skipped += 1;
            } else {
                await insert.run(
                    capturedAt,
                    row.serviceDate,
                    row.departingId,
                    row.arrivingId,
                    row.departingTime,
                    ...row.values
                );
                result.written += 1;
            }
        }
        if (today !== null) await withdrawMissing(db, rows, today, capturedAt);
    });

    await run();
}

/**
 * Marks the future slots WSDOT no longer publishes for a pair, which is what lets the Historical
 * view stop showing sailings the live schedule dropped. Nothing is deleted: the rollup still needs
 * a withdrawn slot to pair a leg that ran anyway.
 *
 * Scoped to today alone. scheduletoday can carry a post-midnight sailing whose Pacific service date
 * is tomorrow, and treating that lone row as tomorrow's whole schedule would withdraw the next day.
 */
async function withdrawMissing(db: Db, rows: SnapshotRow[], today: string, capturedAt: string): Promise<void> {
    const byPair = new Map<string, { departingId: number; arrivingId: number; times: string[] }>();
    for (const row of rows) {
        if (row.serviceDate !== today) continue;
        const key = `${row.departingId}|${row.arrivingId}`;
        const group = byPair.get(key) ?? { departingId: row.departingId, arrivingId: row.arrivingId, times: [] };
        group.times.push(row.departingTime);
        byPair.set(key, group);
    }

    for (const group of byPair.values()) {
        // An empty group is skipped rather than withdrawing everything, and NOT IN () is a syntax error.
        if (group.times.length === 0) continue;
        const placeholders = group.times.map(() => '?').join(', ');
        await db
            .prepare(
                `UPDATE schedule_snapshot SET withdrawn_at = ?
      WHERE service_date = ? AND departing_terminal_id = ? AND arriving_terminal_id = ?
        AND withdrawn_at IS NULL AND departing_time > ?
        AND departing_time NOT IN (${placeholders})`
            )
            .run(capturedAt, today, group.departingId, group.arrivingId, capturedAt, ...group.times);
    }
}

function upsert(db: Db, findSql: string, insertSql: string, updateSql: string) {
    const find = db.prepare(findSql);
    const insert = db.prepare(insertSql);
    const update = db.prepare(updateSql);
    // Select then write, because ON CONFLICT has no Azure SQL equivalent.
    return async (id: number, values: Array<string | number | null>): Promise<void> => {
        if (await find.get(id)) await update.run(...values, id);
        else await insert.run(id, ...values);
    };
}
