import type { SailingView, TerminalCameraView, TerminalMateView, TerminalView, VesselView } from '@ferry-tracker/shared';
import {
  DEFAULT_SETTINGS,
  LATE_MINUTES,
  UNDERWAY_KNOTS,
  crossingFor,
  minutesFromClock,
  openSpaceCount,
  openSpacePercent,
  projectedArrival,
  spaceCounts,
  vesselDelayMinutes,
  vesselEta,
} from '@ferry-tracker/shared';
import type { CatchOverride, Crossings, FerrySettings } from '@ferry-tracker/shared';

// The catch core is shared with the server so /api/catch answers from the same rules the
// Catch tab renders. Re-exported here so every caller keeps importing from one module.
export {
  CATCH_DEFAULT_PAD_MINUTES,
  CATCH_FEED_FRESH_MINUTES,
  CATCH_QUEUE_MINUTES,
  CATCH_STALE_DELAY_MINUTES,
  CATCH_TRAFFIC_MINUTES,
  CATCH_TURNAROUND_MINUTES,
  DEFAULT_SETTINGS,
  DISRUPTION_DURATION_MINUTES,
  DISRUPTION_LEAD_MINUTES,
  LATE_MINUTES,
  UNDERWAY_KNOTS,
  catchDeparture,
  catchLevel,
  catchSpaceLevel,
  catchTiming,
  catchWindowLevel,
  catchWindows,
  compactVehicleSpace,
  crossingFor,
  crossingKey,
  openSpaceCount,
  openSpacePercent,
  projectedArrival,
  spaceCounts,
  vesselDelayMinutes,
  vesselEta,
} from '@ferry-tracker/shared';
export type {
  CatchDelaySource,
  CatchDeparture,
  CatchOverride,
  CatchTiming,
  CatchVessel,
  CatchWindow,
  Crossings,
  FerrySettings,
} from '@ferry-tracker/shared';

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

export const BAINBRIDGE_TERMINAL_ID = 3;
export const SEATTLE_TERMINAL_ID = 7;

// 'clock' means the boat is overdue and the estimate is only walking forward with the current
// time, which is a different claim from either of the other two and has to be labelled as one.
export type ArrivalSource = 'median' | 'feed' | 'clock';

export interface ArrivalEstimate {
  at: string;
  source: ArrivalSource;
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
    return live === null ? null : { at: live, source: 'feed' };
  }
  if (Date.parse(projected) >= now) return { at: projected, source: 'median' };
  const tracked = vessel.eta === null ? Number.NaN : Date.parse(vessel.eta);
  if (tracked >= now) return { at: vessel.eta as string, source: 'feed' };
  return { at: new Date(now).toISOString(), source: 'clock' };
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

export const CATCH_MINUTE_CHOICES = [0, 5, 10, 15, 20, 25, 30, 40, 45, 60, 75, 90];
export const THRESHOLD_MINUTE_CHOICES = [0, 2, 3, 5, 7, 10, 12, 15, 20, 25, 30, 45, 60];
export const SPACE_SOON_PERCENT_CHOICES = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
export const SPACE_IMMINENT_PERCENT_CHOICES = [5, 10, 15, 20, 25, 30, 35];
export const DISRUPTION_LEAD_CHOICES = [0, 5, 10, 15, 20, 25, 30];
export const DISRUPTION_DURATION_CHOICES = [5, 10, 15, 20, 25, 30, 45, 60];

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
): { at: string; estimated: boolean; samples: number | null; source: ArrivalSource | null } | null {
  if (sailing.actualArrival) return { at: sailing.actualArrival, estimated: false, samples: null, source: null };
  if (sailing.arrivingTime) return { at: sailing.arrivingTime, estimated: false, samples: null, source: null };
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
  const samples = estimate.source === 'median' ? crossing?.samples ?? null : null;
  return { at: estimate.at, estimated: true, samples, source: estimate.source };
}

// Measured against the actual departure when there is one, so the crossing never absorbs
// time the boat spent late at the dock.
export function sailingTimeMinutes(
  sailing: Pick<SailingView, 'actualArrival' | 'arrivingTime' | 'vesselId' | 'departingTime' | 'actualDeparture' | 'departureDelayMinutes'>
    & Partial<Pick<SailingView, 'departingTerminalId' | 'arrivingTerminalId'>>,
  vessels: Array<Pick<VesselView, 'id' | 'atDock' | 'eta' | 'leftDock' | 'scheduledDeparture'> & Partial<Pick<VesselView, 'speed'>>>,
  crossings: Crossings = new Map(),
  now: number = Date.now(),
): { minutes: number; estimated: boolean; samples: number | null; source: ArrivalSource | null } | null {
  const arrival = sailingArrival(sailing, vessels, crossings, now);
  const departure = sailingDeparture(sailing, vessels)?.at ?? sailing.departingTime;
  if (arrival === null || departure === null) return null;
  const minutes = (Date.parse(arrival.at) - Date.parse(departure)) / 60000;
  if (Number.isNaN(minutes) || minutes <= 0) return null;
  return { minutes: Math.round(minutes), estimated: arrival.estimated, samples: arrival.samples, source: arrival.source };
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

export function vehicleSpace(sailing: SailingView) {
  if (!sailing.spaceAvailable) return '—';
  const counts = spaceCounts(sailing);
  return sailing.maxSpaceCount === null ? counts : `${counts} of ${sailing.maxSpaceCount} spaces`;
}

// The Sailings-tab schedule list is the tightest space of all, so it drops to "up"/"res".
export function phoneVehicleSpace(sailing: Pick<SailingView, 'spaceAvailable' | 'driveUpSpaceCount' | 'reservableSpaceCount' | 'maxSpaceCount'>) {
  if (!sailing.spaceAvailable) return '—';
  const counts = spaceCounts(sailing, true);
  return sailing.maxSpaceCount === null ? counts : `${counts} / ${sailing.maxSpaceCount}`;
}

export function catchPillClass(level: 'clear' | 'soon' | 'imminent') {
  return level === 'clear' ? 'open' : level === 'soon' ? 'tight' : 'full';
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
