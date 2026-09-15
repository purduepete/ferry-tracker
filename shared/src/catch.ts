import type { CrossingView, SailingView, VesselView } from './wsdot.js';

// Floored, not rounded: a boat 40 seconds late still shows the same clock minute as its
// slot, so rounding up would contradict the times either side of the pill.
export const LATE_MINUTES = 2;

// Offloaded traffic takes about this long to clear the dock and reach the road.
export const DISRUPTION_LEAD_MINUTES = 10;
// And about this long to drain off it again.
export const DISRUPTION_DURATION_MINUTES = 15;
// Drive to the terminal, then sit in the holding lane before they load.
export const CATCH_TRAFFIC_MINUTES = 15;
export const CATCH_QUEUE_MINUTES = 15;
export const CATCH_DEFAULT_PAD_MINUTES = CATCH_TRAFFIC_MINUTES + CATCH_QUEUE_MINUTES;
// Nothing is added for the dock turnaround, so a projected delay only ever says the boat cannot
// sail before it has arrived. Guessing high would push leave-by later and lose someone a ferry.
export const CATCH_TURNAROUND_MINUTES = 0;
// Past this an inbound boat is running a LATER slot, not a very late version of this one.
export const CATCH_STALE_DELAY_MINUTES = 20;
// How recently the feed must have refreshed a vessel before its at-dock reading is believed.
// Capture polls well inside a minute, so this only rejects a feed that has genuinely gone quiet.
export const CATCH_FEED_FRESH_MINUTES = 5;
// Above dockside GPS jitter, below the first real movement out of the slip.
export const UNDERWAY_KNOTS = 0.5;

export function vesselDelayMinutes(vessel: Pick<VesselView, 'leftDock' | 'scheduledDeparture'>) {
  if (!vessel.leftDock || !vessel.scheduledDeparture) return null;
  const left = Date.parse(vessel.leftDock);
  const scheduled = Date.parse(vessel.scheduledDeparture);
  if (Number.isNaN(left) || Number.isNaN(scheduled)) return null;
  return Math.floor((left - scheduled) / 60000);
}

// WSDOT's estimate is anchored to a stale position of some other vessel, so a boat that
// left late needs its own delay added back on.
export function vesselEta(vessel: Pick<VesselView, 'eta' | 'leftDock' | 'scheduledDeparture'>) {
  const delay = vesselDelayMinutes(vessel);
  if (!vessel.eta || delay === null || delay < LATE_MINUTES) return null;
  const at = Date.parse(vessel.eta);
  return Number.isNaN(at) ? null : new Date(at + delay * 60000).toISOString();
}

export type Crossings = Map<string, CrossingView>;

export function crossingKey(departingId: number | null | undefined, arrivingId: number | null | undefined) {
  return departingId == null || arrivingId == null ? null : `${departingId}-${arrivingId}`;
}

export function crossingFor(
  crossings: Crossings,
  departingId: number | null | undefined,
  arrivingId: number | null | undefined,
): CrossingView | null {
  const key = crossingKey(departingId, arrivingId);
  return (key === null ? undefined : crossings.get(key)) ?? null;
}

export function projectedArrival(departedAt: string | null | undefined, minutes: number | null) {
  if (!departedAt || minutes === null) return null;
  const left = Date.parse(departedAt);
  return Number.isNaN(left) ? null : new Date(left + minutes * 60000).toISOString();
}

export interface FerrySettings {
  catchTrafficMinutes: number;
  catchQueueMinutes: number;
  catchSoonMinutes: number;
  spaceSoonPercent: number;
  spaceImminentPercent: number;
  disruptionLeadMinutes: number;
  disruptionDurationMinutes: number;
  disruptionSoonMinutes: number;
  disruptionImminentMinutes: number;
}

export const DEFAULT_SETTINGS: FerrySettings = {
  catchTrafficMinutes: CATCH_TRAFFIC_MINUTES,
  catchQueueMinutes: CATCH_QUEUE_MINUTES,
  catchSoonMinutes: 10,
  spaceSoonPercent: 50,
  spaceImminentPercent: 25,
  disruptionLeadMinutes: DISRUPTION_LEAD_MINUTES,
  disruptionDurationMinutes: DISRUPTION_DURATION_MINUTES,
  disruptionSoonMinutes: 15,
  disruptionImminentMinutes: 5,
};

// Null means the route defers to the global setting for that half of the padding.
export interface CatchOverride {
  trafficMinutes: number | null;
  queueMinutes: number | null;
}

export function catchTiming(
  settings: Pick<FerrySettings, 'catchTrafficMinutes' | 'catchQueueMinutes'>,
  override?: CatchOverride,
) {
  const trafficMinutes = override?.trafficMinutes ?? settings.catchTrafficMinutes;
  const queueMinutes = override?.queueMinutes ?? settings.catchQueueMinutes;
  return {
    trafficMinutes,
    queueMinutes,
    padMinutes: trafficMinutes + queueMinutes,
    overridden: override !== undefined && (override.trafficMinutes !== null || override.queueMinutes !== null),
  };
}

// A countdown is read against a wall clock, so it measures from the minute on that clock, not
// from the current second. Without it, 10:42 to an 11:05 leave-by renders as 22 min.
export function minutesFromClock(target: number, now: number) {
  return Math.floor((target - Math.floor(now / 60000) * 60000) / 60000);
}

export function spaceCounts(space: Pick<SailingView, 'driveUpSpaceCount' | 'reservableSpaceCount'>, compact = false) {
  const values: string[] = [];
  if (space.driveUpSpaceCount !== null) values.push(`${space.driveUpSpaceCount} ${compact ? 'drv' : 'drive-up'}`);
  if (space.reservableSpaceCount !== null) values.push(`${space.reservableSpaceCount} ${compact ? 'res' : 'reservable'}`);
  return values.length ? values.join(', ') : 'Count hidden';
}

// The relationship card column is far narrower than the table cell, so the count sheds its wording there.
export function compactVehicleSpace(sailing: Pick<SailingView, 'spaceAvailable' | 'driveUpSpaceCount' | 'reservableSpaceCount' | 'maxSpaceCount'>) {
  if (!sailing.spaceAvailable) return '—';
  const counts = spaceCounts(sailing);
  return sailing.maxSpaceCount === null ? counts : `${counts} / ${sailing.maxSpaceCount}`;
}

export interface CatchWindow {
  departureAt: string;
  expectedDepartureAt: string | null;
  delayMinutes: number | null;
  delaySource: CatchDelaySource;
  leaveByAt: string;
  minutesAway: number;
  queueMinutesRemaining: number | null;
  estimatedLeaveByAt: string | null;
  estimatedMinutesAway: number | null;
  estimatedQueueMinutesRemaining: number | null;
  dimScheduled: boolean;
  vesselId: number | null;
  vesselName: string | null;
  spaceLabel: string | null;
  spacePercent: number | null;
  spaceTotal: number | null;
}

export function catchLevel(minutesAway: number, settings: FerrySettings = DEFAULT_SETTINGS, queueRemaining: number | null = null) {
  return queueRemaining !== null ? 'imminent'
    : minutesAway < settings.catchSoonMinutes ? 'soon'
    : 'clear';
}

export function catchSpaceLevel(percent: number | null, settings: FerrySettings = DEFAULT_SETTINGS) {
  if (percent === null) return 'clear';
  return percent < settings.spaceImminentPercent ? 'imminent'
    : percent < settings.spaceSoonPercent ? 'soon'
    : 'clear';
}

// A boat that is nearly full is as much of a problem as one you are nearly late for,
// so the leave-by colour takes whichever of the two reads worse.
export function catchWindowLevel(window: Pick<CatchWindow, 'minutesAway' | 'spacePercent'> & Partial<Pick<CatchWindow, 'estimatedMinutesAway' | 'queueMinutesRemaining' | 'estimatedQueueMinutesRemaining'>>, settings: FerrySettings = DEFAULT_SETTINGS) {
  const rank = { clear: 0, soon: 1, imminent: 2 };
  const queueRemaining = window.estimatedMinutesAway != null ? window.estimatedQueueMinutesRemaining : window.queueMinutesRemaining;
  const byTime = catchLevel(window.estimatedMinutesAway ?? window.minutesAway, settings, queueRemaining ?? null);
  const bySpace = catchSpaceLevel(window.spacePercent, settings);
  return rank[bySpace] > rank[byTime] ? bySpace : byTime;
}

export type CatchDelaySource = 'observed' | 'projected' | null;

export interface CatchDeparture {
  scheduledAt: number;
  departsAt: number;
  delayMinutes: number | null;
  delaySource: CatchDelaySource;
  departed: boolean;
}

export type CatchVessel = Pick<VesselView, 'id' | 'atDock' | 'speed' | 'leftDock' | 'eta' | 'scheduledDeparture' | 'arrivingTerminalId' | 'updatedAt'>
  & Partial<Pick<VesselView, 'departingTerminalId'>>;

// A missing timestamp is treated as fresh: the feed publishes one on every real record, so its
// absence means a fixture or a trimmed payload rather than a boat nobody has heard from.
function feedIsFresh(vessel: Pick<CatchVessel, 'updatedAt'>, now: number) {
  if (!vessel.updatedAt) return true;
  const updatedAt = Date.parse(vessel.updatedAt);
  if (Number.isNaN(updatedAt)) return true;
  return now - updatedAt <= CATCH_FEED_FRESH_MINUTES * 60000;
}

// The recorded actualDeparture only lands once a crossing finishes, so lateness for a sailing you
// could still make has to come from the live fleet. Two signals, both lower bounds: the assigned
// boat is still tied up past its own slot, or it is still crossing the other way and cannot sail
// out of a terminal it has not reached.
export function catchDeparture(
  sailing: Pick<SailingView, 'departingTime' | 'departingTerminalId' | 'vesselId'>,
  vessels: CatchVessel[],
  now: number,
  crossings: Crossings = new Map(),
): CatchDeparture | null {
  if (sailing.departingTime === null) return null;
  const scheduledAt = Date.parse(sailing.departingTime);
  if (Number.isNaN(scheduledAt)) return null;
  const onTime: CatchDeparture = { scheduledAt, departsAt: scheduledAt, delayMinutes: null, delaySource: null, departed: false };

  const vessel = sailing.vesselId === null ? undefined : vessels.find((candidate) => candidate.id === sailing.vesselId);
  if (vessel === undefined) return onTime;
  const ownSlot = vessel.scheduledDeparture === sailing.departingTime;

  if (ownSlot && vessel.atDock === false) {
    // AtDock flaps for a minute or two either side of a real departure, so it never retires a
    // sailing on its own. A false "still here" costs a wasted glance; a false "gone" hides the
    // late boat this whole feature exists to show.
    const moving = vessel.speed !== null && vessel.speed > UNDERWAY_KNOTS;
    const pulledOut = vessel.speed === null && vessel.leftDock !== null && Date.parse(vessel.leftDock) >= scheduledAt;
    if (moving || pulledOut) return { ...onTime, departed: true };
  }

  if (ownSlot && vessel.atDock === true) {
    const lateBy = Math.floor((now - scheduledAt) / 60000);
    // How late the boat is says nothing about whether the reading is trustworthy. Only a feed that
    // has stopped refreshing is stale, and a boat really can sit there for half an hour.
    if (lateBy < LATE_MINUTES || !feedIsFresh(vessel, now)) return onTime;
    return { ...onTime, departsAt: Math.max(scheduledAt, now), delayMinutes: lateBy, delaySource: 'observed' };
  }

  if (vessel.atDock === false && vessel.arrivingTerminalId !== null && vessel.arrivingTerminalId === sailing.departingTerminalId) {
    const updatedAt = vessel.updatedAt ? Date.parse(vessel.updatedAt) : NaN;
    if (!Number.isFinite(updatedAt) || updatedAt > now || now - updatedAt > CATCH_FEED_FRESH_MINUTES * 60000) return onTime;
    // The fastest of the recent crossings, not the median, because this projection only ever
    // claims the boat cannot sail before it has arrived. A median is late half the time, and
    // late here pushes leave-by out and loses someone a ferry. A borrowed reverse-direction
    // figure is not conservative enough to make that promise, so it is refused.
    const crossing = crossingFor(crossings, vessel.departingTerminalId, vessel.arrivingTerminalId);
    const fast = crossing && !crossing.borrowed && crossing.samples >= 3 ? crossing.fastMinutes : null;
    // No live-ETA fallback once the projection is spent, unlike the arrival columns. A boat still
    // out there can sail no earlier than now, and that floor is the conservative answer here.
    const eta = projectedArrival(vessel.leftDock, fast) ?? vesselEta(vessel) ?? vessel.eta;
    if (!eta) return onTime;
    const arrivesAt = Date.parse(eta);
    if (Number.isNaN(arrivesAt)) return onTime;
    const earliest = Math.max(arrivesAt, now) + CATCH_TURNAROUND_MINUTES * 60000;
    const delayMinutes = Math.floor((earliest - scheduledAt) / 60000);
    // Past the cap the boat is running a LATER slot, not a very late version of this one. WSDOT
    // reuses one vesselId across the whole day, so without this an inbound boat projects onto
    // every earlier slot it was ever booked for and keeps hours-dead sailings on the card.
    if (delayMinutes < LATE_MINUTES || delayMinutes > CATCH_STALE_DELAY_MINUTES) return onTime;
    return { ...onTime, departsAt: earliest, delayMinutes, delaySource: 'projected' };
  }

  return onTime;
}

export interface CatchTiming {
  trafficMinutes: number;
  queueMinutes: number;
}

function queueMinutesRemaining(leaveBy: number, now: number, queueMinutes: number) {
  return now < leaveBy ? null
    : Math.max(0, Math.min(queueMinutes, minutesFromClock(leaveBy + queueMinutes * 60000, now)));
}

export function catchWindows(
  sailings: Array<Pick<SailingView, 'departingTime' | 'departingTerminalId' | 'vesselId' | 'vesselName' | 'isCancelled' | 'spaceAvailable' | 'driveUpSpaceCount' | 'reservableSpaceCount' | 'maxSpaceCount'>>,
  now: number,
  timing: CatchTiming = { trafficMinutes: DEFAULT_SETTINGS.catchTrafficMinutes, queueMinutes: DEFAULT_SETTINGS.catchQueueMinutes },
  vessels: CatchVessel[] = [],
  crossings: Crossings = new Map(),
): CatchWindow[] {
  const trafficMs = timing.trafficMinutes * 60000;
  const padMs = (timing.trafficMinutes + timing.queueMinutes) * 60000;
  return sailings
    .flatMap((sailing) => {
      if (sailing.isCancelled) return [];
      const departure = catchDeparture(sailing, vessels, now, crossings);
      if (departure === null || departure.departed) return [];
      if (openSpaceCount(sailing) === 0) return [];
      if (now > departure.departsAt - trafficMs) return [];
      if (departure.delaySource !== 'observed' && departure.departsAt <= now) return [];
      const leaveBy = departure.scheduledAt - padMs;
      const estimatedLeaveBy = departure.delaySource === null ? null : departure.departsAt - padMs;
      const observedVessel = departure.delaySource === 'observed'
        ? vessels.find((vessel) => vessel.id === sailing.vesselId)
        : undefined;
      const observedAt = observedVessel?.updatedAt ? Date.parse(observedVessel.updatedAt) : NaN;
      return [{
        departureAt: new Date(departure.scheduledAt).toISOString(),
        expectedDepartureAt: departure.delaySource === null ? null : new Date(departure.departsAt).toISOString(),
        delayMinutes: departure.delayMinutes,
        delaySource: departure.delaySource,
        leaveByAt: new Date(leaveBy).toISOString(),
        minutesAway: minutesFromClock(leaveBy, now),
        queueMinutesRemaining: queueMinutesRemaining(leaveBy, now, timing.queueMinutes),
        estimatedLeaveByAt: estimatedLeaveBy === null ? null : new Date(estimatedLeaveBy).toISOString(),
        estimatedMinutesAway: estimatedLeaveBy === null ? null : minutesFromClock(estimatedLeaveBy, now),
        estimatedQueueMinutesRemaining: estimatedLeaveBy === null ? null : queueMinutesRemaining(estimatedLeaveBy, now, timing.queueMinutes),
        dimScheduled: now > departure.scheduledAt - trafficMs
          && (departure.delaySource === 'projected'
            || (Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= CATCH_FEED_FRESH_MINUTES * 60000)),
        vesselId: sailing.vesselId,
        vesselName: sailing.vesselName ?? null,
        spaceLabel: sailing.spaceAvailable ? compactVehicleSpace(sailing) : null,
        spacePercent: openSpacePercent(sailing),
        spaceTotal: sailing.maxSpaceCount,
      }];
    })
    .sort((left, right) => left.leaveByAt.localeCompare(right.leaveByAt));
}

export function openSpaceCount(sailing: Pick<SailingView, 'spaceAvailable' | 'driveUpSpaceCount' | 'reservableSpaceCount'>) {
  if (!sailing.spaceAvailable) return null;
  if (sailing.driveUpSpaceCount === null && sailing.reservableSpaceCount === null) return null;
  return Math.max(0, (sailing.driveUpSpaceCount ?? 0) + (sailing.reservableSpaceCount ?? 0));
}

export function openSpacePercent(sailing: Pick<SailingView, 'spaceAvailable' | 'maxSpaceCount' | 'driveUpSpaceCount' | 'reservableSpaceCount'>) {
  const open = openSpaceCount(sailing);
  if (open === null || !sailing.maxSpaceCount) return null;
  return Math.max(0, Math.min(100, Math.round((open / sailing.maxSpaceCount) * 100)));
}
