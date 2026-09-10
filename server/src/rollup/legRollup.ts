import { pacificParts } from '@ferry-tracker/shared';
import type { Db } from '../db/database.js';

export interface RollupOptions {
  dwellCeilingMinutes: number;
  dockDebounceSeconds: number;
  now?: number;
}

export interface RollupResult {
  vessels: number;
  legsWritten: number;
  legsRemoved: number;
  watermark: string | null;
}

type Confidence = 'high' | 'medium' | 'low';

interface Observation {
  id: number;
  vessel_name: string;
  ts: string;
  at_dock: number | null;
  in_service: number | null;
  departing_terminal_id: number | null;
  arriving_terminal_id: number | null;
  left_dock: string | null;
  scheduled_departure: string | null;
  op_route_abbrev: string | null;
}

interface Arrival {
  terminalId: number | null;
  at: string;
  // A vessel already sitting at a dock when the window opens has an unknown true
  // arrival time, so its dwell would read short.
  origin: 'observed' | 'first_sighting' | 'after_service_gap';
}

interface Leg {
  vesselId: number;
  vesselName: string;
  departingTerminalId: number | null;
  arrivingTerminalId: number | null;
  opRouteAbbrev: string | null;
  scheduledDeparture: string | null;
  scheduledDepartureSource: string | null;
  leftDock: string | null;
  departedAt: string;
  dockArrivalAt: string | null;
  previousArrivalAt: string | null;
  loadMinutes: number | null;
  complete: number;
  confidence: Confidence;
  exclusionReason: string | null;
  loadExclusionReason: string | null;
}

const SLOT_LOOKBACK_MINUTES = 15;

// The shortest WSF crossing runs about 15 minutes, so nothing under this can be a boat that
// crossed, docked and left again between two polls.
const MIN_TURNAROUND_MS = 5 * 60_000;

interface DockRun {
  state: number;
  segment: number;
  startMs: number;
  indexes: number[];
}

// WSDOT flips AtDock on and off for a minute or two either side of a real departure, and
// every blip would otherwise open a leg and close it again on the next poll. A state has to
// hold for the window before the machine believes it.
function debounceDockState(observations: Observation[], windowSeconds: number): Observation[] {
  if (windowSeconds <= 0 || observations.length === 0) return observations;
  const windowMs = windowSeconds * 1000;
  const runs = dockRuns(observations);
  const settled = observations.map((observation) => observation.at_dock);

  // The last run of a segment has no successor, so how long it held is not known yet. Neither
  // is a run whose only successor sits on the far side of a long poll gap.
  const brief = (index: number): boolean =>
    index < runs.length - 1 &&
    runs[index + 1].segment === runs[index].segment &&
    runs[index + 1].startMs - runs[index].startMs < windowMs;

  for (let i = 1; i < runs.length; i += 1) {
    if (runs[i - 1].segment !== runs[i].segment || !brief(i)) continue;

    // Once the feed starts flapping, nothing it says until it settles again is worth
    // anything, so the whole stretch reads as the last state that held.
    const { state, segment } = runs[i - 1];
    let end = i;
    while (end < runs.length && runs[end].segment === segment && brief(end)) {
      for (const index of runs[end].indexes) settled[index] = state;
      end += 1;
    }
    i = end - 1;
  }

  return observations.map((observation, index) =>
    settled[index] === observation.at_dock ? observation : { ...observation, at_dock: settled[index] },
  );
}

// The final run has no successor, so the debounce had nothing to judge it against and its
// state is still a guess. Writing it would close a leg on a blip, and a complete leg becomes
// the anchor that the next pass never reaches back past. So the tail waits instead: it is
// re-read next pass, and once the run is older than the window nothing can collapse it.
function trimUnsettledTail(observations: Observation[], windowSeconds: number, nowMs: number): Observation[] {
  if (windowSeconds <= 0 || observations.length === 0) return observations;
  const runs = dockRuns(observations);
  const last = runs[runs.length - 1];
  if (!last || nowMs - last.startMs >= windowSeconds * 1000) return observations;
  return observations.slice(0, last.indexes[0]);
}

function dockRuns(observations: Observation[]): DockRun[] {
  const runs: DockRun[] = [];
  let open: DockRun | null = null;
  let segment = 0;

  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    // A service gap breaks continuity, so no run may span one.
    if (observation.in_service === 0) {
      segment += 1;
      open = null;
      continue;
    }
    const state = observation.at_dock;
    if (state === null) continue;
    const startMs = Date.parse(observation.ts);
    if (Number.isNaN(startMs)) continue;

    if (open && open.state === state) {
      open.indexes.push(index);
      continue;
    }
    open = { state, segment, startMs, indexes: [index] };
    runs.push(open);
  }
  return runs;
}

export function runLegRollup(db: Db, options: RollupOptions): RollupResult {
  const vessels = db
    .prepare('SELECT DISTINCT vessel_id FROM vessel_observation ORDER BY vessel_id')
    .all() as Array<{ vessel_id: number }>;

  const result: RollupResult = { vessels: vessels.length, legsWritten: 0, legsRemoved: 0, watermark: null };
  const watermarks: string[] = [];
  const nowMs = options.now ?? Date.now();

  const run = db.transaction(() => {
    for (const { vessel_id: vesselId } of vessels) {
      const anchor = lastCompleteLeg(db, vesselId);
      result.legsRemoved += clearFrom(db, vesselId, anchor?.departed_at ?? null);

      const observations = trimUnsettledTail(
        debounceDockState(readObservations(db, vesselId, anchor?.dock_arrival_at ?? null), options.dockDebounceSeconds),
        options.dockDebounceSeconds,
        nowMs,
      );
      if (observations.length === 0) continue;

      const seed: Arrival | null = anchor?.dock_arrival_at
        ? { terminalId: anchor.arriving_terminal_id, at: anchor.dock_arrival_at, origin: 'observed' }
        : null;

      for (const leg of buildLegs(db, vesselId, observations, seed, options)) {
        insertLeg(db, leg);
        result.legsWritten += 1;
      }
      watermarks.push(anchor?.dock_arrival_at ?? observations[0].ts);
    }

    result.watermark = watermarks.length === vessels.length && watermarks.length > 0
      ? watermarks.reduce((lowest, value) => (value < lowest ? value : lowest))
      : null;
    saveWatermark(db, result.watermark);
  });

  run();
  return result;
}

function buildLegs(
  db: Db,
  vesselId: number,
  observations: Observation[],
  seed: Arrival | null,
  options: RollupOptions,
): Leg[] {
  const legs: Leg[] = [];
  let open: Leg | null = null;
  let lastArrival = seed;
  let previous: Observation | null = null;
  let gapPending = false;

  for (const observation of observations) {
    if (observation.in_service === 0) {
      if (open) {
        legs.push(truncate(open, 'out_of_service'));
        open = null;
      }
      // A service gap breaks continuity, so the next departure gets no dwell.
      lastArrival = null;
      previous = null;
      gapPending = true;
      continue;
    }

    if (observation.at_dock === null) {
      previous = observation;
      continue;
    }

    if (observation.at_dock === 1) {
      if (open) {
        const terminalId = open.arrivingTerminalId ?? observation.departing_terminal_id;
        legs.push(finish(open, observation.ts, terminalId));
        lastArrival = { terminalId, at: observation.ts, origin: 'observed' };
        open = null;
      } else if (
        lastArrival === null ||
        // A recorded arrival outranks the feed's departing terminal, which can still name the
        // crossing that just ended for a poll or two after docking. Discarding it here made the
        // same observations produce a different dwell depending on where the batch started,
        // because a whole pass closes the open leg on this observation instead.
        (lastArrival.origin !== 'observed' && lastArrival.terminalId !== observation.departing_terminal_id)
      ) {
        lastArrival = {
          terminalId: observation.departing_terminal_id,
          at: observation.ts,
          origin: gapPending ? 'after_service_gap' : 'first_sighting',
        };
      }
      gapPending = false;
      previous = observation;
      continue;
    }

    if (open) {
      const current: Leg = open;
      const pairChanged =
        current.departingTerminalId !== observation.departing_terminal_id ||
        current.arrivingTerminalId !== observation.arriving_terminal_id;
      const movedLeftDock =
        observation.left_dock !== null && current.leftDock !== null && observation.left_dock !== current.leftDock
          ? observation.left_dock
          : null;
      const shift = movedLeftDock === null ? 0 : Date.parse(movedLeftDock) - Date.parse(current.departedAt);

      // A dock visit shorter than the poll interval leaves at_dock = 0 across both polls. WSDOT
      // also settles LeftDock a poll or two after a real departure, and that revision moves the
      // stamp by seconds, so only a jump a turnaround ahead is a second departure.
      if (pairChanged || shift >= MIN_TURNAROUND_MS) {
        const departedAt = observation.left_dock ?? observation.ts;
        legs.push({ ...finish(current, departedAt, current.arrivingTerminalId), confidence: 'low', exclusionReason: 'short_dock' });
        lastArrival = { terminalId: current.arrivingTerminalId, at: departedAt, origin: 'observed' };
        open = start(db, vesselId, observation, previous, lastArrival, options, 'short_dock');
      } else if (movedLeftDock !== null && shift >= 0) {
        // A stamp that moves backward is never a correction worth taking: it would shift the leg
        // onto an earlier slot and read as leaving early.
        open = { ...current, leftDock: movedLeftDock, departedAt: movedLeftDock };
      }
      previous = observation;
      continue;
    }

    open = start(db, vesselId, observation, previous, lastArrival, options, null);
    previous = observation;
  }

  if (open) legs.push(open);
  return legs;
}

function start(
  db: Db,
  vesselId: number,
  observation: Observation,
  previous: Observation | null,
  lastArrival: Arrival | null,
  options: RollupOptions,
  problem: string | null,
): Leg {
  const cleanDeparture = previous !== null && previous.at_dock === 1;
  const departedAt = observation.left_dock ?? observation.ts;
  const scheduled = resolveScheduledDeparture(db, observation, lastArrival, departedAt, options);
  const dwell = resolveDwell(observation, lastArrival, departedAt, options);

  return {
    vesselId,
    vesselName: observation.vessel_name,
    departingTerminalId: observation.departing_terminal_id,
    arrivingTerminalId: observation.arriving_terminal_id,
    opRouteAbbrev: observation.op_route_abbrev,
    scheduledDeparture: scheduled.value,
    scheduledDepartureSource: scheduled.source,
    leftDock: observation.left_dock,
    departedAt,
    dockArrivalAt: null,
    previousArrivalAt: lastArrival?.at ?? null,
    loadMinutes: problem ? null : dwell.minutes,
    complete: 0,
    confidence: problem ? 'low' : cleanDeparture ? (observation.left_dock ? 'high' : 'medium') : 'low',
    exclusionReason: problem ?? (cleanDeparture ? null : 'missing_departure'),
    loadExclusionReason: problem ?? dwell.reason,
  };
}

function finish(leg: Leg, dockArrivalAt: string, arrivingTerminalId: number | null): Leg {
  return {
    ...leg,
    dockArrivalAt,
    arrivingTerminalId: leg.arrivingTerminalId ?? arrivingTerminalId,
    complete: 1,
  };
}

function truncate(leg: Leg, reason: string): Leg {
  return { ...leg, complete: 0, confidence: 'low', exclusionReason: reason };
}

function resolveDwell(
  observation: Observation,
  lastArrival: Arrival | null,
  departedAt: string,
  options: RollupOptions,
): { minutes: number | null; reason: string | null } {
  if (!lastArrival) return { minutes: null, reason: 'missing_previous_arrival' };
  if (lastArrival.origin !== 'observed') {
    return { minutes: null, reason: lastArrival.origin === 'after_service_gap' ? 'service_gap' : 'unobserved_arrival' };
  }
  if (lastArrival.terminalId !== observation.departing_terminal_id) {
    return { minutes: null, reason: 'terminal_discontinuity' };
  }
  const minutes = minutesBetween(lastArrival.at, departedAt);
  if (minutes === null || minutes < 0) return { minutes: null, reason: 'negative_dwell' };
  if (minutes > options.dwellCeilingMinutes) return { minutes: null, reason: 'dwell_exceeds_ceiling' };
  return { minutes, reason: null };
}

function resolveScheduledDeparture(
  db: Db,
  observation: Observation,
  lastArrival: Arrival | null,
  departedAt: string,
  options: RollupOptions,
): { value: string | null; source: string | null } {
  // A ferry never leaves before its slot, so a later slot means the feed rolled forward
  // while left_dock still held the previous crossing. Fall through to the schedule instead.
  const departedMs = Date.parse(departedAt);
  const sane = (value: string) => Number.isNaN(departedMs) || Date.parse(value) <= departedMs;

  if (observation.scheduled_departure && sane(observation.scheduled_departure)) {
    return { value: observation.scheduled_departure, source: 'feed' };
  }
  if (!lastArrival || observation.departing_terminal_id === null || observation.arriving_terminal_id === null) {
    return { value: null, source: null };
  }

  // Matched against the DOCK ARRIVAL. Matching the actual departure would let a
  // 45 minute late sailing claim the next slot.
  const arrivalMs = Date.parse(lastArrival.at);
  if (Number.isNaN(arrivalMs)) return { value: null, source: null };
  const windowStart = new Date(arrivalMs - SLOT_LOOKBACK_MINUTES * 60_000).toISOString();
  const windowEnd = new Date(arrivalMs + options.dwellCeilingMinutes * 60_000).toISOString();

  const slots = (db
    .prepare(`SELECT departing_time FROM schedule_snapshot
      WHERE departing_terminal_id = ? AND arriving_terminal_id = ?
        AND departing_time >= ? AND departing_time <= ?`)
    .all(observation.departing_terminal_id, observation.arriving_terminal_id, windowStart, windowEnd) as Array<{
      departing_time: string;
    }>).filter((slot) => sane(slot.departing_time));
  if (slots.length === 0) return { value: null, source: null };

  const nearest = slots.reduce((best, slot) =>
    Math.abs(Date.parse(slot.departing_time) - arrivalMs) < Math.abs(Date.parse(best.departing_time) - arrivalMs)
      ? slot
      : best,
  );
  return { value: nearest.departing_time, source: 'schedule_snapshot' };
}

function insertLeg(db: Db, leg: Leg): void {
  const parts = pacificParts(leg.departedAt);
  if (!parts) return;

  db.prepare(`INSERT INTO sailing_leg (
    vessel_id, vessel_name, departing_terminal_id, arriving_terminal_id, op_route_abbrev,
    scheduled_departure, scheduled_departure_source, left_dock, departed_at, dock_arrival_at,
    previous_arrival_at, departure_delay_minutes, load_minutes, crossing_minutes,
    complete, confidence, exclusion_reason, load_exclusion_reason,
    service_date, weekday, hour_local
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM sailing_leg WHERE vessel_id = ? AND departed_at = ?)`)
    .run(
      leg.vesselId,
      leg.vesselName,
      leg.departingTerminalId,
      leg.arrivingTerminalId,
      leg.opRouteAbbrev,
      leg.scheduledDeparture,
      leg.scheduledDepartureSource,
      leg.leftDock,
      leg.departedAt,
      leg.dockArrivalAt,
      leg.previousArrivalAt,
      leg.scheduledDeparture ? minutesBetween(leg.scheduledDeparture, leg.departedAt) : null,
      leg.loadMinutes,
      leg.dockArrivalAt ? minutesBetween(leg.departedAt, leg.dockArrivalAt) : null,
      leg.complete,
      leg.confidence,
      leg.exclusionReason,
      leg.loadExclusionReason,
      parts.serviceDate,
      parts.weekday,
      parts.hourLocal,
      leg.vesselId,
      leg.departedAt,
    );
}

function lastCompleteLeg(db: Db, vesselId: number) {
  return db
    .prepare(`SELECT departed_at, dock_arrival_at, arriving_terminal_id FROM sailing_leg
      WHERE vessel_id = ? AND complete = 1 ORDER BY departed_at DESC LIMIT 1`)
    .get(vesselId) as { departed_at: string; dock_arrival_at: string | null; arriving_terminal_id: number | null } | undefined;
}

function clearFrom(db: Db, vesselId: number, departedAt: string | null): number {
  const info = departedAt === null
    ? db.prepare('DELETE FROM sailing_leg WHERE vessel_id = ?').run(vesselId)
    : db.prepare('DELETE FROM sailing_leg WHERE vessel_id = ? AND departed_at > ?').run(vesselId, departedAt);
  return info.changes;
}

function readObservations(db: Db, vesselId: number, from: string | null): Observation[] {
  const columns = `id, vessel_name, COALESCE(source_timestamp, captured_at) AS ts,
    at_dock, in_service, departing_terminal_id, arriving_terminal_id,
    left_dock, scheduled_departure, op_route_abbrev`;
  const order = 'ORDER BY COALESCE(source_timestamp, captured_at), id';

  return (from === null
    ? db.prepare(`SELECT ${columns} FROM vessel_observation WHERE vessel_id = ? ${order}`).all(vesselId)
    : db
        .prepare(`SELECT ${columns} FROM vessel_observation
          WHERE vessel_id = ? AND COALESCE(source_timestamp, captured_at) >= ? ${order}`)
        .all(vesselId, from)) as Observation[];
}

function saveWatermark(db: Db, watermark: string | null): void {
  const updatedAt = new Date().toISOString();
  const exists = db.prepare("SELECT name FROM rollup_state WHERE name = 'sailing_leg'").get();
  if (exists) {
    db.prepare("UPDATE rollup_state SET watermark = ?, updated_at = ? WHERE name = 'sailing_leg'").run(watermark, updatedAt);
    return;
  }
  db.prepare("INSERT INTO rollup_state (name, watermark, updated_at) VALUES ('sailing_leg', ?, ?)").run(watermark, updatedAt);
}

function minutesBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round(((end - start) / 60_000) * 100) / 100;
}
