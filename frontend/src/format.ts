import type { SailingView, VesselView } from '@ferry-tracker/shared';

// Floored, not rounded: a boat 40 seconds late still shows the same clock minute as its
// slot, so rounding up would contradict the times either side of the pill.
export const LATE_MINUTES = 2;

export function localTime(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value)) : '—';
}

export function refreshTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}

export function clockTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

// Vessel cards stack several timestamps, so today's date is repeated noise.
export function fieldTime(value: string | null) {
  if (!value) return '—';
  const at = new Date(value);
  return at.toDateString() === new Date().toDateString() ? clockTime(value) : localTime(value);
}

// Split by hand because Date.parse treats a bare YYYY-MM-DD as UTC and can shift the day.
export function serviceDayLabel(serviceDate: string) {
  const [year, month, day] = serviceDate.split('-').map(Number);
  if (!year || !month || !day) return serviceDate;
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day));
}

export function recordedSpaceLabel(sailing: Pick<SailingView, 'spaceSource' | 'spaceObservedAt' | 'spaceLeadSeconds'>) {
  if (sailing.spaceSource !== 'recorded' || sailing.spaceObservedAt === null) return null;
  const at = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sailing.spaceObservedAt));
  const lead = sailing.spaceLeadSeconds;
  if (lead === null) return `Last recorded at ${at}`;
  const ago = lead < 90 ? `${Math.max(0, lead)} sec` : `${Math.round(lead / 60)} min`;
  return `Last recorded at ${at}, ${ago} before departure`;
}

export function departureDelayLabel(sailing: Pick<SailingView, 'actualDeparture'>) {
  return sailing.actualDeparture ? `Left ${clockTime(sailing.actualDeparture)}` : null;
}

export function departureDelayMinutes(sailing: Pick<SailingView, 'actualDeparture' | 'departureDelayMinutes'>) {
  if (!sailing.actualDeparture || sailing.departureDelayMinutes === null) return null;
  const minutes = Math.floor(sailing.departureDelayMinutes);
  return minutes < LATE_MINUTES ? null : minutes;
}

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

// WSDOT publishes a scheduled arrival on almost no route, so the observed dock arrival is
// the usual answer and the live ETA covers the one crossing still in progress.
export function sailingArrival(
  sailing: Pick<SailingView, 'actualArrival' | 'arrivingTime' | 'vesselId' | 'departingTime'>,
  vessels: Array<Pick<VesselView, 'id' | 'atDock' | 'eta' | 'leftDock' | 'scheduledDeparture'>>,
): { at: string; estimated: boolean } | null {
  if (sailing.actualArrival) return { at: sailing.actualArrival, estimated: false };
  if (sailing.arrivingTime) return { at: sailing.arrivingTime, estimated: false };
  // Matched on the scheduled departure so a boat that runs the route twice cannot lend its
  // ETA to the wrong row.
  const underway = vessels.find((vessel) =>
    vessel.id === sailing.vesselId && vessel.atDock === false && vessel.scheduledDeparture === sailing.departingTime);
  if (!underway?.eta) return null;
  return { at: vesselEta(underway) ?? underway.eta, estimated: true };
}

// Measured against the actual departure when there is one, so the crossing never absorbs
// time the boat spent late at the dock.
export function sailingTimeMinutes(
  sailing: Pick<SailingView, 'actualArrival' | 'arrivingTime' | 'vesselId' | 'departingTime' | 'actualDeparture'>,
  vessels: Array<Pick<VesselView, 'id' | 'atDock' | 'eta' | 'leftDock' | 'scheduledDeparture'>>,
): { minutes: number; estimated: boolean } | null {
  const arrival = sailingArrival(sailing, vessels);
  const departure = sailing.actualDeparture ?? sailing.departingTime;
  if (arrival === null || departure === null) return null;
  const minutes = (Date.parse(arrival.at) - Date.parse(departure)) / 60000;
  if (Number.isNaN(minutes) || minutes <= 0) return null;
  return { minutes: Math.round(minutes), estimated: arrival.estimated };
}

export function spaceCounts(space: Pick<SailingView, 'driveUpSpaceCount' | 'reservableSpaceCount'>) {
  const values: string[] = [];
  if (space.driveUpSpaceCount !== null) values.push(`${space.driveUpSpaceCount} drive-up`);
  if (space.reservableSpaceCount !== null) values.push(`${space.reservableSpaceCount} reservable`);
  return values.length ? values.join(', ') : 'Count hidden';
}

export function vehicleSpace(sailing: SailingView) {
  if (!sailing.spaceAvailable) return '—';
  const counts = spaceCounts(sailing);
  return sailing.maxSpaceCount === null ? counts : `${counts} of ${sailing.maxSpaceCount} spaces`;
}

// The relationship card column is far narrower than the table cell, so the count sheds its wording there.
export function compactVehicleSpace(sailing: SailingView) {
  if (!sailing.spaceAvailable) return '—';
  const counts = spaceCounts(sailing);
  return sailing.maxSpaceCount === null ? counts : `${counts} / ${sailing.maxSpaceCount}`;
}

export function openSpacePercent(sailing: Pick<SailingView, 'spaceAvailable' | 'maxSpaceCount' | 'driveUpSpaceCount' | 'reservableSpaceCount'>) {
  if (!sailing.spaceAvailable || !sailing.maxSpaceCount) return null;
  if (sailing.driveUpSpaceCount === null && sailing.reservableSpaceCount === null) return null;
  const open = (sailing.driveUpSpaceCount ?? 0) + (sailing.reservableSpaceCount ?? 0);
  return Math.max(0, Math.min(100, Math.round((open / sailing.maxSpaceCount) * 100)));
}

export function capacityLevel(percent: number) {
  return percent <= 10 ? 'full' : percent <= 30 ? 'tight' : 'open';
}

// 0 sails the selected route, 1 sails it in reverse, 2 leaves the origin for elsewhere, 3 only arrives.
export function vesselRouteRank(
  vessel: Pick<VesselView, 'departingTerminalId' | 'arrivingTerminalId'>,
  originId: number,
  destinationId: number | null,
) {
  if (destinationId !== null && vessel.departingTerminalId === originId && vessel.arrivingTerminalId === destinationId) return 0;
  if (destinationId !== null && vessel.departingTerminalId === destinationId && vessel.arrivingTerminalId === originId) return 1;
  return vessel.departingTerminalId === originId ? 2 : 3;
}
