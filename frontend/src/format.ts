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

export const BAINBRIDGE_TERMINAL_ID = 3;
export const SEATTLE_TERMINAL_ID = 7;
// Offloaded traffic takes about this long to clear the dock and reach the road.
export const DISRUPTION_LEAD_MINUTES = 10;
// And about this long to drain off it again.
export const DISRUPTION_DURATION_MINUTES = 15;
// Drive to the terminal, then sit in the holding lane before they load.
export const CATCH_TRAVEL_MINUTES = 15;
export const CATCH_BUFFER_MINUTES = 15;
export const CATCH_DEFAULT_PAD_MINUTES = CATCH_TRAVEL_MINUTES + CATCH_BUFFER_MINUTES;
export const CATCH_PAD_CHOICES = [0, 5, 10, 15, 20, 25, 30, 40, 45, 60, 75, 90];
export const THRESHOLD_MINUTE_CHOICES = [0, 2, 3, 5, 7, 10, 12, 15, 20, 25, 30, 45, 60];
export const SPACE_SOON_PERCENT_CHOICES = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
export const SPACE_IMMINENT_PERCENT_CHOICES = [5, 10, 15, 20, 25, 30, 35];
export const DISRUPTION_LEAD_CHOICES = [0, 5, 10, 15, 20, 25, 30];
export const DISRUPTION_DURATION_CHOICES = [5, 10, 15, 20, 25, 30, 45, 60];

export interface FerrySettings {
  catchPadMinutes: number;
  catchSoonMinutes: number;
  catchImminentMinutes: number;
  spaceSoonPercent: number;
  spaceImminentPercent: number;
  disruptionLeadMinutes: number;
  disruptionDurationMinutes: number;
  disruptionSoonMinutes: number;
  disruptionImminentMinutes: number;
}

export const DEFAULT_SETTINGS: FerrySettings = {
  catchPadMinutes: CATCH_DEFAULT_PAD_MINUTES,
  catchSoonMinutes: 10,
  catchImminentMinutes: 5,
  spaceSoonPercent: 50,
  spaceImminentPercent: 25,
  disruptionLeadMinutes: DISRUPTION_LEAD_MINUTES,
  disruptionDurationMinutes: DISRUPTION_DURATION_MINUTES,
  disruptionSoonMinutes: 15,
  disruptionImminentMinutes: 5,
};

export const SETTING_CHOICES: Record<keyof FerrySettings, number[]> = {
  catchPadMinutes: CATCH_PAD_CHOICES,
  catchSoonMinutes: THRESHOLD_MINUTE_CHOICES,
  catchImminentMinutes: THRESHOLD_MINUTE_CHOICES,
  spaceSoonPercent: SPACE_SOON_PERCENT_CHOICES,
  spaceImminentPercent: SPACE_IMMINENT_PERCENT_CHOICES,
  disruptionLeadMinutes: DISRUPTION_LEAD_CHOICES,
  disruptionDurationMinutes: DISRUPTION_DURATION_CHOICES,
  disruptionSoonMinutes: THRESHOLD_MINUTE_CHOICES,
  disruptionImminentMinutes: THRESHOLD_MINUTE_CHOICES,
};

export const settingsKey = 'ferry-tracker-settings';
const legacyCatchPadKey = 'ferry-tracker-catch-pad';

// Red can never be a looser threshold than yellow, whatever the stored value or the picker says.
export function normalizeSettings(raw: unknown): FerrySettings {
  const stored = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof FerrySettings>) {
    const value = stored[key];
    if (typeof value === 'number' && SETTING_CHOICES[key].includes(value)) settings[key] = value;
  }
  settings.catchImminentMinutes = Math.min(settings.catchImminentMinutes, settings.catchSoonMinutes);
  settings.disruptionImminentMinutes = Math.min(settings.disruptionImminentMinutes, settings.disruptionSoonMinutes);
  settings.spaceImminentPercent = Math.min(settings.spaceImminentPercent, settings.spaceSoonPercent);
  return settings;
}

export function loadSettings(): FerrySettings {
  try {
    const raw = localStorage.getItem(settingsKey);
    if (raw !== null) return normalizeSettings(JSON.parse(raw));
    // The pad used to live in its own key, so an existing visitor keeps the pad they chose.
    const pad = localStorage.getItem(legacyCatchPadKey);
    return normalizeSettings(pad === null ? {} : { catchPadMinutes: Number(pad) });
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: FerrySettings) {
  try {
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  } catch { /* The settings just fall back to the defaults on the next visit. */ }
}

export const favoriteTerminalsKey = 'ferry-tracker-favorite-terminals';

// The stored order is the order Settings shows them in, so duplicates and non-integers are dropped.
export function loadFavoriteTerminalIds(): number[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(favoriteTerminalsKey) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored.filter((value): value is number => Number.isInteger(value)))];
  } catch {
    return [];
  }
}

export function saveFavoriteTerminalIds(ids: number[]) {
  try {
    localStorage.setItem(favoriteTerminalsKey, JSON.stringify(ids));
  } catch { /* Favorites remain active for this tab. */ }
}

export interface TerminalOrderEntry<T> {
  terminal: T;
  favorite: boolean;
}

// Favorites lead in the order chosen on Settings; the rest stay alphabetical.
export function orderTerminals<T extends { id: number; name: string }>(terminals: T[], favoriteIds: number[]): Array<TerminalOrderEntry<T>> {
  const favorites = favoriteIds
    .map((id) => terminals.find((terminal) => terminal.id === id))
    .filter((terminal): terminal is T => terminal !== undefined)
    .map((terminal) => ({ terminal, favorite: true }));
  const rest = terminals
    .filter((terminal) => !favoriteIds.includes(terminal.id))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((terminal) => ({ terminal, favorite: false }));
  return [...favorites, ...rest];
}

// Moves the dragged favorite to where the target sits. Favorites for terminals WSDOT has stopped
// publishing are invisible, so only the visible ids are rewritten and their slots stay put.
export function reorderFavoriteTerminals(favoriteIds: number[], visibleIds: number[], id: number, targetId: number): number[] {
  const from = visibleIds.indexOf(id);
  const to = visibleIds.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return favoriteIds;
  const moved = [...visibleIds];
  moved.splice(to, 0, ...moved.splice(from, 1));
  const next = [...favoriteIds];
  let taken = 0;
  for (const [index, value] of favoriteIds.entries()) {
    if (visibleIds.includes(value)) next[index] = moved[taken++];
  }
  return next;
}

export function toggleFavoriteTerminalId(favoriteIds: number[], id: number): number[] {
  return favoriteIds.includes(id) ? favoriteIds.filter((value) => value !== id) : [...favoriteIds, id];
}

export interface DisruptionWave {
  vesselId: number;
  vesselName: string;
  landingAt: string;
  disruptionAt: string;
  clearsAt: string;
  minutesAway: number;
  minutesLeft: number;
  active: boolean;
  ongoing: boolean;
}

export function disruptionLevel(minutesAway: number, settings: FerrySettings = DEFAULT_SETTINGS) {
  return minutesAway < settings.disruptionImminentMinutes ? 'imminent'
    : minutesAway < settings.disruptionSoonMinutes ? 'soon'
    : 'clear';
}

// A boat can still read as underway for a tick after it ties up, so an observed arrival
// this close to a live ETA is the same landing seen twice.
const DISRUPTION_MERGE_MINUTES = 30;

function disruptionWave(vesselId: number, vesselName: string, landing: number, now: number, settings: FerrySettings): DisruptionWave[] {
  const disruption = landing + settings.disruptionLeadMinutes * 60000;
  const clears = disruption + settings.disruptionDurationMinutes * 60000;
  if (clears <= now) return [];
  return [{
    vesselId,
    vesselName,
    landingAt: new Date(landing).toISOString(),
    disruptionAt: new Date(disruption).toISOString(),
    clearsAt: new Date(clears).toISOString(),
    minutesAway: Math.floor((disruption - now) / 60000),
    minutesLeft: Math.max(0, Math.ceil((clears - now) / 60000)),
    active: disruption <= now,
    ongoing: false,
  }];
}

// A wave lives from the offload reaching the road until the duration runs out, so a window
// already open still counts. Docked boats leave the vessel feed, so the boat that most
// recently landed comes from the observed arrival on its inbound leg instead.
export function disruptionWaves(
  vessels: Array<Pick<VesselView, 'id' | 'name' | 'arrivingTerminalId' | 'atDock' | 'eta' | 'leftDock' | 'scheduledDeparture'>>,
  now: number,
  settings: FerrySettings = DEFAULT_SETTINGS,
  landed: Array<Pick<SailingView, 'vesselId' | 'vesselName' | 'actualArrival'>> = [],
): DisruptionWave[] {
  const observed = landed.flatMap((leg) => {
    if (leg.vesselId === null || !leg.actualArrival) return [];
    const landing = Date.parse(leg.actualArrival);
    if (Number.isNaN(landing)) return [];
    return disruptionWave(leg.vesselId, leg.vesselName ?? 'Ferry', landing, now, settings);
  });
  const underway = vessels.flatMap((vessel) => {
    if (vessel.arrivingTerminalId !== BAINBRIDGE_TERMINAL_ID || vessel.atDock !== false || !vessel.eta) return [];
    const landing = Date.parse(vesselEta(vessel) ?? vessel.eta);
    if (Number.isNaN(landing)) return [];
    const duplicate = observed.some((seen) => seen.vesselId === vessel.id
      && Math.abs(Date.parse(seen.landingAt) - landing) < DISRUPTION_MERGE_MINUTES * 60000);
    return duplicate ? [] : disruptionWave(vessel.id, vessel.name, landing, now, settings);
  });
  const waves = [...observed, ...underway].sort((left, right) => left.disruptionAt.localeCompare(right.disruptionAt));
  // Traffic never lets up when the boat behind arrives before this one's window closes.
  for (const [index, wave] of waves.entries()) {
    wave.ongoing = waves[index + 1] !== undefined && waves[index + 1].disruptionAt <= wave.clearsAt;
  }
  return waves;
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
export function compactVehicleSpace(sailing: Pick<SailingView, 'spaceAvailable' | 'driveUpSpaceCount' | 'reservableSpaceCount' | 'maxSpaceCount'>) {
  if (!sailing.spaceAvailable) return '—';
  const counts = spaceCounts(sailing);
  return sailing.maxSpaceCount === null ? counts : `${counts} / ${sailing.maxSpaceCount}`;
}

export interface CatchWindow {
  departureAt: string;
  leaveByAt: string;
  minutesAway: number;
  vesselId: number | null;
  vesselName: string | null;
  spaceLabel: string | null;
  spacePercent: number | null;
  spaceTotal: number | null;
}

export function catchLevel(minutesAway: number, settings: FerrySettings = DEFAULT_SETTINGS) {
  return minutesAway < settings.catchImminentMinutes ? 'imminent'
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
export function catchWindowLevel(window: Pick<CatchWindow, 'minutesAway' | 'spacePercent'>, settings: FerrySettings = DEFAULT_SETTINGS) {
  const rank = { clear: 0, soon: 1, imminent: 2 };
  const byTime = catchLevel(window.minutesAway, settings);
  const bySpace = catchSpaceLevel(window.spacePercent, settings);
  return rank[bySpace] > rank[byTime] ? bySpace : byTime;
}

export function catchPillClass(level: 'clear' | 'soon' | 'imminent') {
  return level === 'clear' ? 'open' : level === 'soon' ? 'tight' : 'full';
}

// How far past leave-by a sailing still counts as catchable.
export const CATCH_LATE_LIMIT_MINUTES = 15;

// A boat still at the dock is worth showing once leave-by has passed, so minutesAway can run
// negative, but only until it is 15 minutes gone or the deck is full.
export function catchWindows(
  sailings: Array<Pick<SailingView, 'departingTime' | 'actualDeparture' | 'vesselId' | 'vesselName' | 'isCancelled' | 'spaceAvailable' | 'driveUpSpaceCount' | 'reservableSpaceCount' | 'maxSpaceCount'>>,
  now: number,
  padMinutes: number = DEFAULT_SETTINGS.catchPadMinutes,
): CatchWindow[] {
  return sailings
    .flatMap((sailing) => {
      const departure = sailing.actualDeparture ?? sailing.departingTime;
      if (!departure || sailing.isCancelled) return [];
      const departsAt = Date.parse(departure);
      if (Number.isNaN(departsAt)) return [];
      if (departsAt <= now) return [];
      if (openSpaceCount(sailing) === 0) return [];
      const leaveBy = departsAt - padMinutes * 60000;
      const minutesAway = Math.floor((leaveBy - now) / 60000);
      if (minutesAway < -CATCH_LATE_LIMIT_MINUTES) return [];
      return [{
        departureAt: new Date(departsAt).toISOString(),
        leaveByAt: new Date(leaveBy).toISOString(),
        minutesAway,
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

export function capacityLevel(percent: number) {
  return percent <= 10 ? 'full' : percent <= 30 ? 'tight' : 'open';
}

export interface DisruptionLoad {
  percentFull: number;
  openPercent: number;
  openCount: number;
  totalSpace: number;
  observedAt: string | null;
}

// How full the boat was on the way in. WSDOT drops a sailing from the space feed the moment it
// leaves, so the counts here are capture's last reading before departure.
export function disruptionLoad(
  sailings: Array<Pick<SailingView, 'vesselId' | 'departingTime' | 'spaceAvailable' | 'driveUpSpaceCount' | 'reservableSpaceCount' | 'maxSpaceCount' | 'spaceObservedAt'>>,
  vesselId: number,
  landingAt: string,
): DisruptionLoad | null {
  const leg = sailings
    .filter((sailing) => sailing.vesselId === vesselId && sailing.departingTime !== null && sailing.departingTime < landingAt)
    .sort((left, right) => (left.departingTime ?? '').localeCompare(right.departingTime ?? ''))
    .at(-1);
  if (!leg?.maxSpaceCount) return null;
  const openPercent = openSpacePercent(leg);
  const openCount = openSpaceCount(leg);
  if (openPercent === null || openCount === null) return null;
  return {
    percentFull: 100 - openPercent,
    openPercent,
    openCount,
    totalSpace: leg.maxSpaceCount,
    observedAt: leg.spaceObservedAt,
  };
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
