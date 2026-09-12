import type { CrossingView, SailingView, TerminalCameraView, TerminalMateView, TerminalView, VesselView } from '@ferry-tracker/shared';

// Floored, not rounded: a boat 40 seconds late still shows the same clock minute as its
// slot, so rounding up would contradict the times either side of the pill.
export const LATE_MINUTES = 2;

export function localTime(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value)) : '—';
}

// Parsed rather than concatenated so a camera URL that already carries a query keeps working.
export function cacheBusted(imageUrl: string, stamp: number) {
  try {
    const url = new URL(imageUrl);
    url.searchParams.set('t', String(stamp));
    return url.toString();
  } catch {
    return imageUrl;
  }
}

export function cameraAlt(camera: Pick<TerminalCameraView, 'title'>, terminalName: string) {
  return camera.title.trim() || `${terminalName} terminal camera`;
}

export function alertCountLabel(count: number) {
  return count === 1 ? '1 service alert' : `${count} service alerts`;
}

// WSDOT stamps nearly every bulletin "All Alerts", so the token only earns its place when it says
// something, which keeps a real type like "Cancellation" showing if they ever start sending one.
export function alertMeta(type: string | null, publishedAt: string | null) {
  const label = type?.trim().toLowerCase() === 'all alerts' ? null : type;
  return [label, publishedAt ? fieldTime(publishedAt) : null].filter(Boolean).join(' · ');
}

// Multicolumn balances by height, which strands the remainder in the last column. A reader
// scanning a schedule expects the leftmost column to be the fullest, so the indexes returned
// here get a forced `break-before: column` to override the browser's own split.
export function sailingColumnBreaks(count: number, columns: number) {
  const breaks = new Set<number>();
  if (columns < 2) return breaks;
  const base = Math.floor(count / columns);
  const extra = count % columns;
  let index = 0;
  for (let column = 0; column < columns - 1; column += 1) {
    index += base + (column < extra ? 1 : 0);
    if (index > 0 && index < count) breaks.add(index);
  }
  return breaks;
}

export function clockTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

export const STALE_REFRESH_MS = 300_000;

// Both arguments are client-clock milliseconds. Comparing against the server's fetchedAt
// would let a skewed client render stale data that just arrived.
export function refreshIsStale(lastRefreshMs: number | null, now: number) {
  if (lastRefreshMs === null) return false;
  return now - lastRefreshMs >= STALE_REFRESH_MS;
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

export interface ArrivalEstimate {
  at: string;
  fromMedian: boolean;
}

// The median beats WSDOT's estimate right up until the boat overruns it. Past that the median has
// nothing left to say and the feed takes over, because it is still tracking the vessel's real
// position. With both spent the clock is all that is left, and an arrival that has been and gone
// is worse than one that walks forward.
export function estimatedArrival(
  departedAt: string | null | undefined,
  medianMinutes: number | null,
  vessel: Pick<VesselView, 'eta' | 'leftDock' | 'scheduledDeparture'>,
  now: number,
): ArrivalEstimate | null {
  const projected = projectedArrival(departedAt, medianMinutes);
  // Minutes into a crossing the feed is still anchored to a stale position, so a late boat needs
  // its delay added back. An hour into a 31 minute crossing that delay is long since priced in,
  // and the raw ETA is the only figure re-estimated against where the boat actually is.
  if (projected === null) {
    const live = vesselEta(vessel) ?? vessel.eta;
    return live === null ? null : { at: live, fromMedian: false };
  }
  if (Date.parse(projected) >= now) return { at: projected, fromMedian: true };
  const tracked = vessel.eta === null ? Number.NaN : Date.parse(vessel.eta);
  if (tracked >= now) return { at: vessel.eta as string, fromMedian: false };
  return { at: new Date(now).toISOString(), fromMedian: false };
}

// The last few crossings on this pair beat WSDOT's estimate, which is anchored to some other
// vessel's stale position. The feed is still the answer for a pair with no measured history.
export function vesselArrival(
  vessel: Pick<VesselView, 'eta' | 'leftDock' | 'scheduledDeparture' | 'arrivingTerminalId'> & Partial<Pick<VesselView, 'departingTerminalId'>>,
  crossings: Crossings = new Map(),
  now: number = Date.now(),
): ArrivalEstimate | null {
  const crossing = crossingFor(crossings, vessel.departingTerminalId, vessel.arrivingTerminalId);
  return estimatedArrival(vessel.leftDock, crossing?.medianMinutes ?? null, vessel, now);
}

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
export const CATCH_MINUTE_CHOICES = [0, 5, 10, 15, 20, 25, 30, 40, 45, 60, 75, 90];
export const THRESHOLD_MINUTE_CHOICES = [0, 2, 3, 5, 7, 10, 12, 15, 20, 25, 30, 45, 60];
export const SPACE_SOON_PERCENT_CHOICES = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
export const SPACE_IMMINENT_PERCENT_CHOICES = [5, 10, 15, 20, 25, 30, 35];
export const DISRUPTION_LEAD_CHOICES = [0, 5, 10, 15, 20, 25, 30];
export const DISRUPTION_DURATION_CHOICES = [5, 10, 15, 20, 25, 30, 45, 60];

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

export const SETTING_CHOICES: Record<keyof FerrySettings, number[]> = {
  catchTrafficMinutes: CATCH_MINUTE_CHOICES,
  catchQueueMinutes: CATCH_MINUTE_CHOICES,
  catchSoonMinutes: THRESHOLD_MINUTE_CHOICES,
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
  // Padding used to be one number, so an old total carries over as traffic with nothing queued.
  const pad = stored.catchPadMinutes;
  if (stored.catchTrafficMinutes === undefined && typeof pad === 'number' && CATCH_MINUTE_CHOICES.includes(pad)) {
    settings.catchTrafficMinutes = pad;
    settings.catchQueueMinutes = 0;
  }
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

export const cameraOrderKey = 'ferry-tracker-camera-order';
export type CameraOrder = Record<string, number[]>;
const CAMERA_ORDER_LIMIT = 64;

export function loadCameraOrder(): CameraOrder {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(cameraOrderKey) ?? '{}');
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return {};
    const order: CameraOrder = {};
    for (const [terminalId, ids] of Object.entries(stored).slice(0, CAMERA_ORDER_LIMIT)) {
      if (!Array.isArray(ids)) continue;
      const clean = [...new Set(ids.filter((value): value is number => Number.isInteger(value)))].slice(0, CAMERA_ORDER_LIMIT);
      if (clean.length > 0) order[terminalId] = clean;
    }
    return order;
  } catch {
    return {};
  }
}

export function saveCameraOrder(order: CameraOrder) {
  try {
    localStorage.setItem(cameraOrderKey, JSON.stringify(order));
  } catch { /* The order remains active for this tab. */ }
}

// A camera WSDOT adds later has no stored slot, so it lands after the ones that do.
export function orderCameras<T extends { id: number }>(cameras: T[], ids: number[] | undefined): T[] {
  if (!ids || ids.length === 0) return cameras;
  const chosen = ids
    .map((id) => cameras.find((camera) => camera.id === id))
    .filter((camera): camera is T => camera !== undefined);
  const rest = cameras.filter((camera) => !ids.includes(camera.id));
  return [...chosen, ...rest];
}

// Moves the dragged camera to where the target sits.
export function reorderCameras(orderedIds: number[], id: number, targetId: number): number[] {
  const from = orderedIds.indexOf(id);
  const to = orderedIds.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return orderedIds;
  const next = [...orderedIds];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export const favoriteRoutesKey = 'ferry-tracker-favorite-routes';
const ROUTE_LABEL_LIMIT = 24;

export interface FavoriteRoute {
  originId: number;
  destinationId: number;
  label: string;
}

type RoutePair = Pick<FavoriteRoute, 'originId' | 'destinationId'>;

// The pair is the identity, so a route can only be saved once and nothing has to mint an id.
export function routeKey(route: RoutePair) {
  return `${route.originId}-${route.destinationId}`;
}

export const DEFAULT_FAVORITE_ROUTES: FavoriteRoute[] = [
  { originId: BAINBRIDGE_TERMINAL_ID, destinationId: SEATTLE_TERMINAL_ID, label: 'BI → SEA' },
  { originId: SEATTLE_TERMINAL_ID, destinationId: BAINBRIDGE_TERMINAL_ID, label: 'SEA → BI' },
];

export function normalizeFavoriteRoutes(raw: unknown): FavoriteRoute[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const routes: FavoriteRoute[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const { originId, destinationId, label } = entry as Record<string, unknown>;
    if (!Number.isInteger(originId) || !Number.isInteger(destinationId) || originId === destinationId) continue;
    const route: FavoriteRoute = {
      originId: originId as number,
      destinationId: destinationId as number,
      label: typeof label === 'string' ? label.slice(0, ROUTE_LABEL_LIMIT).trim() : '',
    };
    if (seen.has(routeKey(route))) continue;
    seen.add(routeKey(route));
    routes.push(route);
  }
  return routes;
}

// WSDOT decides which pairs sail, so a route is only offered while it is still published.
export function isPublishedRoute(route: RoutePair, mates: Array<Pick<TerminalMateView, 'departingTerminalId' | 'arrivingTerminalId'>>) {
  return mates.some((mate) => mate.departingTerminalId === route.originId && mate.arrivingTerminalId === route.destinationId);
}

export function loadFavoriteRoutes(): FavoriteRoute[] {
  try {
    const raw = localStorage.getItem(favoriteRoutesKey);
    // An empty list is a real choice, so only a missing key seeds the Bainbridge pair.
    return raw === null ? DEFAULT_FAVORITE_ROUTES : normalizeFavoriteRoutes(JSON.parse(raw));
  } catch {
    return DEFAULT_FAVORITE_ROUTES;
  }
}

export function saveFavoriteRoutes(routes: FavoriteRoute[]) {
  try {
    localStorage.setItem(favoriteRoutesKey, JSON.stringify(routes));
  } catch { /* The routes remain active for this tab. */ }
}

export function addFavoriteRoute(routes: FavoriteRoute[], originId: number, destinationId: number, label = ''): FavoriteRoute[] {
  const route: FavoriteRoute = { originId, destinationId, label: label.slice(0, ROUTE_LABEL_LIMIT).trim() };
  if (originId === destinationId || routes.some((existing) => routeKey(existing) === routeKey(route))) return routes;
  return [...routes, route];
}

export function removeFavoriteRoute(routes: FavoriteRoute[], key: string): FavoriteRoute[] {
  return routes.filter((route) => routeKey(route) !== key);
}

// Not trimmed here, or a space could never be typed between two words.
export function renameFavoriteRoute(routes: FavoriteRoute[], key: string, label: string): FavoriteRoute[] {
  return routes.map((route) => (routeKey(route) === key ? { ...route, label: label.slice(0, ROUTE_LABEL_LIMIT) } : route));
}

export function reorderFavoriteRoutes(routes: FavoriteRoute[], key: string, targetKey: string): FavoriteRoute[] {
  const from = routes.findIndex((route) => routeKey(route) === key);
  const to = routes.findIndex((route) => routeKey(route) === targetKey);
  if (from === -1 || to === -1 || from === to) return routes;
  const moved = [...routes];
  moved.splice(to, 0, ...moved.splice(from, 1));
  return moved;
}

export function routePairName(route: RoutePair, terminals: Array<Pick<TerminalView, 'id' | 'name'>>) {
  const name = (id: number) => terminals.find((terminal) => terminal.id === id)?.name ?? 'Unknown';
  return `${name(route.originId)} to ${name(route.destinationId)}`;
}

export function routeName(route: FavoriteRoute, terminals: Array<Pick<TerminalView, 'id' | 'name'>>) {
  return route.label || routePairName(route, terminals);
}

export const catchOverridesKey = 'ferry-tracker-catch-overrides';

// Null means the route defers to the global setting for that half of the padding.
export interface CatchOverride {
  trafficMinutes: number | null;
  queueMinutes: number | null;
}

export type CatchOverrides = Record<string, CatchOverride>;

function overrideMinutes(value: unknown): number | null {
  return typeof value === 'number' && CATCH_MINUTE_CHOICES.includes(value) ? value : null;
}

export function normalizeCatchOverrides(raw: unknown): CatchOverrides {
  if (raw === null || typeof raw !== 'object') return {};
  const overrides: CatchOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const { trafficMinutes, queueMinutes } = value as Record<string, unknown>;
    const override = { trafficMinutes: overrideMinutes(trafficMinutes), queueMinutes: overrideMinutes(queueMinutes) };
    if (override.trafficMinutes !== null || override.queueMinutes !== null) overrides[key] = override;
  }
  return overrides;
}

export function loadCatchOverrides(): CatchOverrides {
  try {
    return normalizeCatchOverrides(JSON.parse(localStorage.getItem(catchOverridesKey) ?? 'null'));
  } catch {
    return {};
  }
}

export function saveCatchOverrides(overrides: CatchOverrides) {
  try {
    localStorage.setItem(catchOverridesKey, JSON.stringify(overrides));
  } catch { /* The route just falls back to the global padding on the next visit. */ }
}

// Dropping the entry once both halves are null keeps a cleared route out of storage entirely.
export function setCatchOverride(overrides: CatchOverrides, key: string, patch: Partial<CatchOverride>): CatchOverrides {
  const current = overrides[key] ?? { trafficMinutes: null, queueMinutes: null };
  const next = { ...current, ...patch };
  if (next.trafficMinutes === null && next.queueMinutes === null) return clearCatchOverride(overrides, key);
  return { ...overrides, [key]: next };
}

export function clearCatchOverride(overrides: CatchOverrides, key: string): CatchOverrides {
  return Object.fromEntries(Object.entries(overrides).filter(([entryKey]) => entryKey !== key));
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
function minutesFromClock(target: number, now: number) {
  return Math.floor((target - Math.floor(now / 60000) * 60000) / 60000);
}

export interface DisruptionWave {
  vesselId: number | null;
  vesselName: string;
  source: 'observed' | 'live' | 'schedule';
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
// Only reached before the pair has enough measured crossings to speak for itself.
const BAINBRIDGE_CROSSING_MINUTES = 35;

function disruptionWave(vesselId: number | null, vesselName: string, landing: number, now: number, settings: FerrySettings, source: DisruptionWave['source']): DisruptionWave[] {
  const disruption = landing + settings.disruptionLeadMinutes * 60000;
  const clears = disruption + settings.disruptionDurationMinutes * 60000;
  if (clears <= now) return [];
  return [{
    vesselId,
    vesselName,
    source,
    landingAt: new Date(landing).toISOString(),
    disruptionAt: new Date(disruption).toISOString(),
    clearsAt: new Date(clears).toISOString(),
    minutesAway: minutesFromClock(disruption, now),
    minutesLeft: Math.max(0, minutesFromClock(clears, now)),
    active: disruption <= now,
    ongoing: false,
  }];
}

// A wave lives from the offload reaching the road until the duration runs out, so a window
// already open still counts. Docked boats leave the vessel feed, so the boat that most
// recently landed comes from the observed arrival on its inbound leg instead.
export function disruptionWaves(
  vessels: Array<Pick<VesselView, 'id' | 'name' | 'arrivingTerminalId' | 'atDock' | 'eta' | 'leftDock' | 'scheduledDeparture'> & Partial<Pick<VesselView, 'departingTerminalId'>>>,
  now: number,
  settings: FerrySettings = DEFAULT_SETTINGS,
  landed: Array<Pick<SailingView, 'vesselId' | 'vesselName' | 'actualArrival'> & Partial<Pick<SailingView, 'departingTime' | 'arrivingTime' | 'isCancelled' | 'departingTerminalId' | 'arrivingTerminalId'>>> = [],
  crossings: Crossings = new Map(),
): DisruptionWave[] {
  const crossingMinutes = crossingFor(crossings, SEATTLE_TERMINAL_ID, BAINBRIDGE_TERMINAL_ID)?.medianMinutes
    ?? BAINBRIDGE_CROSSING_MINUTES;
  const inbound = landed.filter((leg) => !leg.isCancelled
    && (leg.departingTerminalId == null || leg.departingTerminalId === SEATTLE_TERMINAL_ID)
    && (leg.arrivingTerminalId == null || leg.arrivingTerminalId === BAINBRIDGE_TERMINAL_ID));
  const observed = inbound.flatMap((leg) => {
    if (!leg.actualArrival) return [];
    const landing = Date.parse(leg.actualArrival);
    if (Number.isNaN(landing)) return [];
    return disruptionWave(leg.vesselId, leg.vesselName ?? 'Ferry', landing, now, settings, 'observed');
  });
  const underway = vessels.flatMap((vessel) => {
    if (vessel.arrivingTerminalId !== BAINBRIDGE_TERMINAL_ID || vessel.atDock !== false || !vessel.eta) return [];
    const landing = Date.parse(vesselArrival(vessel, crossings, now)?.at ?? vessel.eta);
    if (Number.isNaN(landing)) return [];
    const duplicate = observed.some((seen) => seen.vesselId === vessel.id
      && Math.abs(Date.parse(seen.landingAt) - landing) < DISRUPTION_MERGE_MINUTES * 60000);
    return duplicate ? [] : disruptionWave(vessel.id, vessel.name, landing, now, settings, 'live');
  });
  const scheduled = inbound.flatMap((leg) => {
    if (leg.actualArrival && Number.isFinite(Date.parse(leg.actualArrival))) return [];
    const departure = leg.departingTime ? Date.parse(leg.departingTime) : NaN;
    if (!Number.isFinite(departure)) return [];
    const publishedArrival = leg.arrivingTime ? Date.parse(leg.arrivingTime) : NaN;
    const landing = Number.isFinite(publishedArrival) && publishedArrival > departure
      ? publishedArrival : departure + crossingMinutes * 60000;
    const uniqueSlot = inbound.filter((candidate) => candidate.departingTime
      && Date.parse(candidate.departingTime) === departure).length === 1;
    const live = vessels.find((vessel) => vessel.arrivingTerminalId === BAINBRIDGE_TERMINAL_ID && vessel.atDock === false
      && vessel.eta && Number.isFinite(Date.parse(vesselArrival(vessel, crossings, now)?.at ?? vessel.eta))
      && ((vessel.scheduledDeparture && Date.parse(vessel.scheduledDeparture) === departure
          && (vessel.id === leg.vesselId || (uniqueSlot && vessel.departingTerminalId === SEATTLE_TERMINAL_ID)))
        || (vessel.id === leg.vesselId && !vessel.scheduledDeparture
          && Math.abs(Date.parse(vesselArrival(vessel, crossings, now)?.at ?? vessel.eta) - landing) < DISRUPTION_MERGE_MINUTES * 60000)));
    if (live) return [];
    return disruptionWave(leg.vesselId, leg.vesselName ?? 'Ferry', landing, now, settings, 'schedule');
  });
  const waves = [...observed, ...underway, ...scheduled].sort((left, right) => left.disruptionAt.localeCompare(right.disruptionAt));
  // Traffic never lets up when the boat behind arrives before this one's window closes.
  for (const [index, wave] of waves.entries()) {
    wave.ongoing = waves[index + 1] !== undefined && waves[index + 1].disruptionAt <= wave.clearsAt;
  }
  return waves;
}

// The recorded leg only lands once the crossing closes, so a boat still underway gets its
// departure from the live vessel feed instead.
export function sailingDeparture(
  sailing: Pick<SailingView, 'actualDeparture' | 'departureDelayMinutes' | 'vesselId' | 'departingTime'>,
  vessels: Array<Pick<VesselView, 'id' | 'atDock' | 'leftDock' | 'scheduledDeparture'> & Partial<Pick<VesselView, 'speed'>>> = [],
): { at: string; delayMinutes: number | null } | null {
  if (sailing.actualDeparture) return { at: sailing.actualDeparture, delayMinutes: departureDelayMinutes(sailing) };
  if (sailing.departingTime === null) return null;
  // Matched on the scheduled departure so a boat that runs the route twice cannot lend its
  // left-dock time to the wrong row.
  const underway = vessels.find((vessel) =>
    vessel.id === sailing.vesselId && vessel.atDock === false && vessel.scheduledDeparture === sailing.departingTime);
  if (!underway?.leftDock) return null;
  const scheduled = Date.parse(sailing.departingTime);
  const left = Date.parse(underway.leftDock);
  if (Number.isNaN(scheduled) || Number.isNaN(left)) return null;
  // AtDock flaps either side of a real departure and drags LeftDock with it, so the stamp is
  // believed only once the boat is independently moving. Same two signals catchDeparture uses.
  const speed = underway.speed ?? null;
  if (!(speed !== null && speed > UNDERWAY_KNOTS) && !(speed === null && left >= scheduled)) return null;
  const delay = vesselDelayMinutes(underway);
  // A ferry never leaves early, so a negative delay means the feed paired the wrong slot. Under
  // LATE_MINUTES the boat counts as on time, matching vesselEta, which keeps a crossing measured
  // between the two free of the delay at either threshold.
  if (delay === null || delay < 0) return null;
  return delay < LATE_MINUTES ? { at: sailing.departingTime, delayMinutes: null } : { at: underway.leftDock, delayMinutes: delay };
}

// WSDOT publishes a scheduled arrival on almost no route, so the observed dock arrival is the
// usual answer. For the one crossing still in progress, the pair's own recent crossings are
// worth about 2 minutes of error against 7 for the live ETA, which double counts the delay.
export function sailingArrival(
  sailing: Pick<SailingView, 'actualArrival' | 'arrivingTime' | 'vesselId' | 'departingTime' | 'actualDeparture' | 'departureDelayMinutes'>
    & Partial<Pick<SailingView, 'departingTerminalId' | 'arrivingTerminalId'>>,
  vessels: Array<Pick<VesselView, 'id' | 'atDock' | 'eta' | 'leftDock' | 'scheduledDeparture'> & Partial<Pick<VesselView, 'speed'>>>,
  crossings: Crossings = new Map(),
  now: number = Date.now(),
): { at: string; estimated: boolean; samples: number | null } | null {
  if (sailing.actualArrival) return { at: sailing.actualArrival, estimated: false, samples: null };
  if (sailing.arrivingTime) return { at: sailing.arrivingTime, estimated: false, samples: null };
  // Matched on the scheduled departure so a boat that runs the route twice cannot lend its
  // ETA to the wrong row.
  const underway = vessels.find((vessel) =>
    vessel.id === sailing.vesselId && vessel.atDock === false && vessel.scheduledDeparture === sailing.departingTime);
  if (!underway) return null;
  // Only a departure the fleet was actually seen to make can anchor a crossing. Without one the
  // projection would time a late boat as though it had left on schedule.
  const crossing = crossingFor(crossings, sailing.departingTerminalId, sailing.arrivingTerminalId);
  const departure = crossing ? sailingDeparture(sailing, vessels) : null;
  const estimate = estimatedArrival(departure?.at, crossing?.medianMinutes ?? null, underway, now);
  if (estimate === null) return null;
  return { at: estimate.at, estimated: true, samples: estimate.fromMedian ? crossing?.samples ?? null : null };
}

// Measured against the actual departure when there is one, so the crossing never absorbs
// time the boat spent late at the dock.
export function sailingTimeMinutes(
  sailing: Pick<SailingView, 'actualArrival' | 'arrivingTime' | 'vesselId' | 'departingTime' | 'actualDeparture' | 'departureDelayMinutes'>
    & Partial<Pick<SailingView, 'departingTerminalId' | 'arrivingTerminalId'>>,
  vessels: Array<Pick<VesselView, 'id' | 'atDock' | 'eta' | 'leftDock' | 'scheduledDeparture'> & Partial<Pick<VesselView, 'speed'>>>,
  crossings: Crossings = new Map(),
  now: number = Date.now(),
): { minutes: number; estimated: boolean; samples: number | null } | null {
  const arrival = sailingArrival(sailing, vessels, crossings, now);
  const departure = sailingDeparture(sailing, vessels)?.at ?? sailing.departingTime;
  if (arrival === null || departure === null) return null;
  const minutes = (Date.parse(arrival.at) - Date.parse(departure)) / 60000;
  if (Number.isNaN(minutes) || minutes <= 0) return null;
  return { minutes: Math.round(minutes), estimated: arrival.estimated, samples: arrival.samples };
}

type CurrentSailing = Pick<SailingView, 'departingTime' | 'actualDeparture' | 'vesselId'>;

const CURRENT_SAILING_GRACE_MS = 15 * 60 * 1000;

// A boat that has left is not the one you can still walk onto. The recorded actualDeparture
// only lands once the crossing finishes, so the live feed is what retires a sailing in the
// moment. With neither signal the schedule alone is unreliable for a late boat, and the grace
// keeps it current while it is probably still loading.
export function getCurrentSailing<T extends CurrentSailing>(
  sailings: T[],
  vessels: Array<Pick<VesselView, 'id' | 'atDock' | 'scheduledDeparture'>> = [],
  now: number = Date.now(),
): T | null {
  const scheduledAt = (sailing: T) => (sailing.departingTime === null ? null : Date.parse(sailing.departingTime));
  const gone = (sailing: T) =>
    (sailing.actualDeparture !== null && Date.parse(sailing.actualDeparture) <= now)
    || vessels.some((vessel) => vessel.id === sailing.vesselId && vessel.atDock === false && vessel.scheduledDeparture === sailing.departingTime);

  const justDeparted = sailings.filter((sailing) => {
    if (gone(sailing)) return false;
    const scheduled = scheduledAt(sailing);
    if (scheduled === null) return false;
    return now - scheduled >= 0 && now - scheduled <= CURRENT_SAILING_GRACE_MS;
  });
  if (justDeparted.length) {
    return justDeparted.reduce((latest, sailing) => ((scheduledAt(sailing) ?? 0) > (scheduledAt(latest) ?? 0) ? sailing : latest));
  }

  return sailings.find((sailing) => !gone(sailing) && (scheduledAt(sailing) ?? 0) > now) ?? null;
}

export function isCurrentSailing(sailing: Pick<CurrentSailing, 'departingTime'>, currentSailing: Pick<CurrentSailing, 'departingTime'> | null): boolean {
  if (!currentSailing) return false;
  return sailing.departingTime === currentSailing.departingTime;
}

export function spaceCounts(space: Pick<SailingView, 'driveUpSpaceCount' | 'reservableSpaceCount'>, compact = false) {
  const values: string[] = [];  if (space.driveUpSpaceCount !== null) values.push(`${space.driveUpSpaceCount} ${compact ? 'drv' : 'drive-up'}`);
  if (space.reservableSpaceCount !== null) values.push(`${space.reservableSpaceCount} ${compact ? 'res' : 'reservable'}`);
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

// The Sailings-tab schedule list is the tightest space of all, so it drops to "up"/"res".
export function phoneVehicleSpace(sailing: Pick<SailingView, 'spaceAvailable' | 'driveUpSpaceCount' | 'reservableSpaceCount' | 'maxSpaceCount'>) {
  if (!sailing.spaceAvailable) return '—';
  const counts = spaceCounts(sailing, true);
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

export function catchPillClass(level: 'clear' | 'soon' | 'imminent') {
  return level === 'clear' ? 'open' : level === 'soon' ? 'tight' : 'full';
}

export type CatchDelaySource = 'observed' | 'projected' | null;

export interface CatchDeparture {
  scheduledAt: number;
  departsAt: number;
  delayMinutes: number | null;
  delaySource: CatchDelaySource;
  departed: boolean;
}

type CatchVessel = Pick<VesselView, 'id' | 'atDock' | 'speed' | 'leftDock' | 'eta' | 'scheduledDeparture' | 'arrivingTerminalId' | 'updatedAt'>
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
