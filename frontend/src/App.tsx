import { isValidElement, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Anchor, ArrowLeftRight, ArrowRight, Car, Clock3, ExternalLink, History, ListFilter, MapPin, RefreshCw, Ship, Star, Waypoints, Wind } from 'lucide-react';
import type { ApiEnvelope, SailingView, TerminalMateView, TerminalView, VesselView } from '@ferry-tracker/shared';
import { ferryApi } from './api';
import { FilterSelect } from './components/FilterSelect';
import { ThemeMenu } from './theme/ThemeMenu';

type Tab = 'routes' | 'terminals' | 'vessels' | 'schedule';

const tabs: Array<{ id: Tab; label: string; icon: typeof Waypoints }> = [
  { id: 'routes', label: 'Routes', icon: Waypoints },
  { id: 'terminals', label: 'Terminals', icon: MapPin },
  { id: 'vessels', label: 'Vessels', icon: Ship },
  { id: 'schedule', label: 'Sailings', icon: Clock3 },
];
const MINIMUM_SKELETON_MS = 500;
const SKELETON_EXIT_MS = 520;
const LIVE_DATE = 'live';
const favoriteTerminalsKey = 'ferry-tracker-favorite-terminals';
const lastRouteKey = 'ferry-tracker-last-route';
const sailingsOnlyKey = 'ferry-tracker-sailings-only';

function loadFavoriteTerminalIds() {
  try {
    const stored = JSON.parse(localStorage.getItem(favoriteTerminalsKey) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored.filter((value): value is number => Number.isInteger(value)))];
  } catch {
    return [];
  }
}

function loadLastRoute(): { terminalId: number | null; destinationId: number | null } {
  const empty = { terminalId: null, destinationId: null };
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(lastRouteKey) ?? 'null');
    if (stored === null || typeof stored !== 'object') return empty;
    const { terminalId, destinationId } = stored as Record<string, unknown>;
    return {
      terminalId: Number.isInteger(terminalId) ? terminalId as number : null,
      destinationId: Number.isInteger(destinationId) ? destinationId as number : null,
    };
  } catch {
    return empty;
  }
}

function loadSailingsOnly() {
  try {
    return localStorage.getItem(sailingsOnlyKey) === 'true';
  } catch {
    return false;
  }
}

function localTime(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value)) : '—';
}

function refreshTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}

export function recordedSpaceLabel(sailing: Pick<SailingView, 'spaceSource' | 'spaceObservedAt' | 'spaceLeadSeconds'>) {
  if (sailing.spaceSource !== 'recorded' || sailing.spaceObservedAt === null) return null;
  const at = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sailing.spaceObservedAt));
  const lead = sailing.spaceLeadSeconds;
  if (lead === null) return `Last recorded at ${at}`;
  const ago = lead < 90 ? `${Math.max(0, lead)} sec` : `${Math.round(lead / 60)} min`;
  return `Last recorded at ${at}, ${ago} before departure`;
}

function RecordedSpaceMark({ sailing }: { sailing: SailingView }) {
  const label = recordedSpaceLabel(sailing);
  if (label === null) return null;
  return <History className="recorded-mark" size={12} role="img" aria-label={label} />;
}

// Floored, not rounded: a boat 40 seconds late still shows the same clock minute as its
// slot, so rounding up would contradict the times either side of the pill.
const LATE_MINUTES = 2;

export function departureDelayLabel(sailing: Pick<SailingView, 'actualDeparture'>) {
  return sailing.actualDeparture ? `Left ${clockTime(sailing.actualDeparture)}` : null;
}

export function departureDelayMinutes(sailing: Pick<SailingView, 'actualDeparture' | 'departureDelayMinutes'>) {
  if (!sailing.actualDeparture || sailing.departureDelayMinutes === null) return null;
  const minutes = Math.floor(sailing.departureDelayMinutes);
  return minutes < LATE_MINUTES ? null : minutes;
}

function clockTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

// Vessel cards stack several timestamps, so today's date is repeated noise.
function fieldTime(value: string | null) {
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

// An on-time departure says nothing the scheduled time did not already say.
function DepartureDelay({ sailing }: { sailing: SailingView }) {
  const label = departureDelayLabel(sailing);
  const delay = departureDelayMinutes(sailing);
  if (label === null || delay === null) return null;
  return <span className="departure-delay">{label}<span className="delay-pill" title={`Left ${delay} minutes after the scheduled departure`}>{delay} min</span></span>;
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

function VesselDeparture({ vessel }: { vessel: VesselView }) {
  const delay = vesselDelayMinutes(vessel);
  if (!vessel.leftDock) return <>—</>;
  if (delay === null || delay < LATE_MINUTES) return <>{fieldTime(vessel.leftDock)}</>;
  return <>{fieldTime(vessel.leftDock)}<span className="delay-pill" title={`Left ${delay} minutes after the scheduled departure`}>{delay} min</span></>;
}

function VesselEta({ vessel }: { vessel: VesselView }) {
  const adjusted = vesselEta(vessel);
  if (!vessel.eta) return <>—</>;
  if (adjusted === null) return <>{fieldTime(vessel.eta)}</>;
  return <>{fieldTime(vessel.eta)}<span className="delay-pill" title={`WSDOT's estimate plus the ${vesselDelayMinutes(vessel)} min departure delay`}>{clockTime(adjusted)}</span></>;
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

function SailingArrival({ sailing, vessels }: { sailing: SailingView; vessels: VesselView[] }) {
  const arrival = sailingArrival(sailing, vessels);
  if (arrival === null) return <>—</>;
  if (!arrival.estimated) return <>{localTime(arrival.at)}</>;
  return <span className="estimated-time" title="Estimated from the vessel's live ETA">{localTime(arrival.at)}</span>;
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

function SailingTime({ sailing, vessels }: { sailing: SailingView; vessels: VesselView[] }) {
  const crossing = sailingTimeMinutes(sailing, vessels);
  if (crossing === null) return <>—</>;
  if (!crossing.estimated) return <>{crossing.minutes} min</>;
  return <span className="estimated-time" title="Estimated from the vessel's live ETA">{crossing.minutes} min</span>;
}

function latestTimestamp(current: string | null, ...values: string[]) {
  return [current, ...values].filter((value): value is string => value !== null).sort().at(-1) ?? null;
}

function vehicleSpace(sailing: SailingView) {
  if (!sailing.spaceAvailable) return '—';
  const counts = spaceCounts(sailing);
  return sailing.maxSpaceCount === null ? counts : `${counts} of ${sailing.maxSpaceCount} spaces`;
}

// The relationship card column is far narrower than the table cell, so the count sheds its wording there.
function compactVehicleSpace(sailing: SailingView) {
  if (!sailing.spaceAvailable) return '—';
  const counts = spaceCounts(sailing);
  return sailing.maxSpaceCount === null ? counts : `${counts} / ${sailing.maxSpaceCount}`;
}

function spaceCounts(space: Pick<SailingView, 'driveUpSpaceCount' | 'reservableSpaceCount'>) {
  const values: string[] = [];
  if (space.driveUpSpaceCount !== null) values.push(`${space.driveUpSpaceCount} drive-up`);
  if (space.reservableSpaceCount !== null) values.push(`${space.reservableSpaceCount} reservable`);
  return values.length ? values.join(', ') : 'Count hidden';
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

function CapacityMeter({ sailing }: { sailing: SailingView }) {
  const percent = openSpacePercent(sailing);
  // A wide-open sailing carries no decision value, so only a partial boat gets a pill.
  if (percent === null || percent === 100) return null;
  const label = `${percent}% of ${sailing.maxSpaceCount} vehicle spaces open`;
  return <span className={`capacity-pill ${capacityLevel(percent)}`} aria-label={label} title={label}>{percent}%</span>;
}

function getCurrentSailing(sailings: SailingView[]): SailingView | null {
  const now = new Date();
  const fifteenMinutesMs = 15 * 60 * 1000;
  const departedAt = (sailing: SailingView) => (sailing.departingTime === null ? null : new Date(sailing.departingTime).getTime());

  // Find sailings that departed within the last 15 minutes
  const recentPast = sailings.filter(sailing => {
    const departure = departedAt(sailing);
    if (departure === null) return false;
    const timeDiff = now.getTime() - departure;
    return timeDiff >= 0 && timeDiff <= fifteenMinutesMs;
  });

  if (recentPast.length) {
    // Return the most recent one (latest departure time)
    return recentPast.reduce((latest, current) =>
      (departedAt(current) ?? 0) > (departedAt(latest) ?? 0) ? current : latest
    );
  }

  // Otherwise, return the next upcoming sailing
  const upcoming = sailings.filter(sailing => {
    const departure = departedAt(sailing);
    return departure !== null && departure > now.getTime();
  });

  return upcoming.length ? upcoming[0] : null;
}

function isCurrentSailing(sailing: SailingView, currentSailing: SailingView | null): boolean {
  if (!currentSailing) return false;
  return sailing.departingTime === currentSailing.departingTime;
}

function Field({ label, value }: { label: string; value: unknown }) {
  const empty = value === null || value === undefined || value === '';
  return <div className="field"><dt>{label}</dt><dd>{empty ? '—' : isValidElement(value) ? value : String(value)}</dd></div>;
}

function SailingVessel({ sailing, vessels, onOpen }: { sailing: SailingView; vessels: VesselView[]; onOpen: (terminalId: number | null, destination: number | null) => void }) {
  if (!sailing.vesselName) return <span className="null">null</span>;
  const live = vessels.find((vessel) => vessel.id === sailing.vesselId);
  if (!live || live.departingTerminalId === null) return <>{sailing.vesselName}</>;
  return <button className="card-link" type="button" title={`Show ${sailing.vesselName}'s current route in the routes view`} onClick={() => onOpen(live.departingTerminalId, live.arrivingTerminalId)}>{sailing.vesselName}</button>;
}

function ViewPlaceholder({ label, tab, sailingsOnly }: { label: string; tab: Tab; sailingsOnly?: boolean }) {
  if (tab === 'terminals' || tab === 'vessels') {
    return <div className="view-placeholder" role="status" aria-label={label}><span className="sr-only">{label}</span><div className="data-grid placeholder-card-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <div className="data-card placeholder-node" key={index}><i /><i /><i /><i /></div>)}</div></div>;
  }
  if (tab === 'schedule') {
    return <div className="view-placeholder" role="status" aria-label={label}><span className="sr-only">{label}</span><div className="wide-placeholder" aria-hidden="true"><i /><i /><i /><i /><i /></div></div>;
  }
  return <div className="view-placeholder" role="status" aria-label={label}><span className="sr-only">{label}</span><div className={`relationship-grid placeholder-grid${sailingsOnly ? ' is-sailings-only' : ''}`} aria-hidden="true"><div className="relationship-node placeholder-node"><i /><i /><i /><i /></div><div className="relationship-link" /><div className="relationship-node placeholder-node"><i /><i /><i /><i /><i /></div><div className="relationship-link" /><div className="relationship-node placeholder-node"><i /><i /><i /><i /><i /></div></div></div>;
}

export function App() {
  const [terminalResponse, setTerminalResponse] = useState<ApiEnvelope<TerminalView[]> | null>(null);
  const [vesselResponse, setVesselResponse] = useState<ApiEnvelope<VesselView[]> | null>(null);
  const [mateResponse, setMateResponse] = useState<ApiEnvelope<TerminalMateView[]> | null>(null);
  const [scheduleResponse, setScheduleResponse] = useState<ApiEnvelope<SailingView[]> | null>(null);
  const [restoredRoute] = useState(loadLastRoute);
  const [selectedTerminalId, setSelectedTerminalId] = useState<number | null>(restoredRoute.terminalId);
  const [destinationId, setDestinationId] = useState<number | null>(restoredRoute.destinationId);
  const [serviceDate, setServiceDate] = useState<string>(LIVE_DATE);
  const [historyDates, setHistoryDates] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('routes');
  const [loading, setLoading] = useState(true);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [minimumInitialSkeletonElapsed, setMinimumInitialSkeletonElapsed] = useState(false);
  const [initialScheduleSettled, setInitialScheduleSettled] = useState(false);
  const [initialDataVisible, setInitialDataVisible] = useState(false);
  const [initialSkeletonVisible, setInitialSkeletonVisible] = useState(true);
  const [retainedUpdateSkeleton, setRetainedUpdateSkeleton] = useState(false);
  const [backgroundRefresh, setBackgroundRefresh] = useState(false);
  const [favoriteTerminalIds, setFavoriteTerminalIds] = useState<number[]>(loadFavoriteTerminalIds);
  const [sailingsOnly, setSailingsOnly] = useState(loadSailingsOnly);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const overviewRequestId = useRef(0);
  const scheduleRequestId = useRef(0);
  const vesselStackRef = useRef<HTMLDivElement>(null);
  const [vesselStackHeight, setVesselStackHeight] = useState(0);

  const loadOverview = () => {
    const controller = new AbortController();
    const requestId = ++overviewRequestId.current;
    setLoading(true);
    setError(null);
    Promise.all([ferryApi.terminals(controller.signal), ferryApi.vessels(controller.signal), ferryApi.terminalMates(controller.signal)])
      .then(([terminals, vessels, mates]) => {
        if (requestId !== overviewRequestId.current) return;
        setTerminalResponse(terminals);
        setVesselResponse(vessels);
        setMateResponse(mates);
        // A restored terminal is only kept while WSDOT still publishes it.
        setSelectedTerminalId((current) => (current !== null && terminals.data.some((terminal) => terminal.id === current) ? current : terminals.data[0]?.id ?? null));
        setLastRefreshAt((current) => latestTimestamp(current, terminals.fetchedAt, vessels.fetchedAt, mates.fetchedAt));
      })
      .catch((cause: unknown) => {
        if (requestId === overviewRequestId.current && (cause as Error).name !== 'AbortError') setError(cause instanceof Error ? cause.message : 'Unable to load ferry data.');
      })
      .finally(() => {
        if (requestId === overviewRequestId.current) setLoading(false);
      });
    return controller;
  };

  useEffect(() => {
    const controller = loadOverview();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinimumInitialSkeletonElapsed(true), MINIMUM_SKELETON_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const terminals = terminalResponse?.data ?? [];
  const favoriteTerminalIdSet = new Set(favoriteTerminalIds);
  const terminalOptions = terminals
    .map((terminal) => ({ value: terminal.id, label: terminal.name, favorite: favoriteTerminalIdSet.has(terminal.id) }))
    .sort((left, right) => Number(right.favorite) - Number(left.favorite) || left.label.localeCompare(right.label));
  const vessels = vesselResponse?.data ?? [];
  const selectedTerminal = terminals.find((terminal) => terminal.id === selectedTerminalId) ?? null;
  const destinationIds = [...new Set((mateResponse?.data ?? [])
    .filter((mate) => mate.departingTerminalId === selectedTerminalId)
    .map((mate) => mate.arrivingTerminalId))];
  const effectiveDestinationId = destinationId !== null && destinationIds.includes(destinationId)
    ? destinationId
    : destinationIds[0] ?? null;
  const associatedVessels = selectedTerminalId === null ? [] : vessels
    .filter((vessel) => vessel.departingTerminalId === selectedTerminalId || vessel.arrivingTerminalId === selectedTerminalId)
    .sort((left, right) =>
      vesselRouteRank(left, selectedTerminalId, effectiveDestinationId) - vesselRouteRank(right, selectedTerminalId, effectiveDestinationId)
      || left.name.localeCompare(right.name));
  const hasOverview = terminalResponse !== null && vesselResponse !== null && mateResponse !== null;
  const recordedDay = serviceDate !== LIVE_DATE;
  const dayOptions = [
    { value: LIVE_DATE, label: 'Today, live' },
    ...historyDates.map((date) => ({ value: date, label: serviceDayLabel(date), icon: <History className="recorded-mark" size={13} aria-hidden="true" /> })),
  ];

  useEffect(() => {
    if (selectedTerminalId === null) return;
    try {
      localStorage.setItem(lastRouteKey, JSON.stringify({ terminalId: selectedTerminalId, destinationId: effectiveDestinationId }));
    } catch { /* The route just falls back to the default on the next visit. */ }
  }, [effectiveDestinationId, selectedTerminalId]);

  useEffect(() => {
    if (selectedTerminalId === null || effectiveDestinationId === null) return;
    const controller = new AbortController();
    const requestId = ++scheduleRequestId.current;
    const startedAt = performance.now();
    let finishTimer: number | undefined;
    let active = true;
    setScheduleLoading(true);
    setError(null);
    const request = serviceDate === LIVE_DATE
      ? ferryApi.schedule(selectedTerminalId, effectiveDestinationId, controller.signal)
      : ferryApi.historySailings(selectedTerminalId, effectiveDestinationId, serviceDate, controller.signal);
    request
      .then((schedule) => {
        if (requestId !== scheduleRequestId.current) return;
        setScheduleResponse(schedule);
        setInitialScheduleSettled(true);
        setLastRefreshAt((current) => latestTimestamp(current, schedule.fetchedAt));
      })
      .catch((cause: unknown) => {
        if (requestId === scheduleRequestId.current && (cause as Error).name !== 'AbortError') {
          setScheduleResponse(null);
          setInitialScheduleSettled(true);
          setError(cause instanceof Error ? cause.message : 'Unable to load schedule.');
        }
      })
      .finally(() => {
        if (!active || requestId !== scheduleRequestId.current) return;
        const remaining = Math.max(0, MINIMUM_SKELETON_MS - (performance.now() - startedAt));
        finishTimer = window.setTimeout(() => {
          if (active && requestId === scheduleRequestId.current) setScheduleLoading(false);
        }, remaining);
      });
    return () => {
      active = false;
      controller.abort();
      if (finishTimer !== undefined) window.clearTimeout(finishTimer);
    };
  }, [effectiveDestinationId, refreshVersion, selectedTerminalId, serviceDate]);

  // A 404 means capture is off on this server, which leaves the picker showing today only.
  useEffect(() => {
    if (selectedTerminalId === null || effectiveDestinationId === null) return;
    const controller = new AbortController();
    ferryApi.historyDates(selectedTerminalId, effectiveDestinationId, controller.signal)
      .then((dates) => setHistoryDates(dates.data))
      .catch(() => setHistoryDates([]));
    return () => controller.abort();
  }, [effectiveDestinationId, refreshVersion, selectedTerminalId]);

  useEffect(() => {
    if (serviceDate !== LIVE_DATE && !historyDates.includes(serviceDate)) setServiceDate(LIVE_DATE);
  }, [historyDates, serviceDate]);

  useEffect(() => {
    const routeSettled = selectedTerminalId === null || effectiveDestinationId === null || initialScheduleSettled;
    if (minimumInitialSkeletonElapsed && hasOverview && !loading && !scheduleLoading && routeSettled) setInitialDataVisible(true);
  }, [effectiveDestinationId, hasOverview, initialScheduleSettled, loading, minimumInitialSkeletonElapsed, scheduleLoading, selectedTerminalId]);

  useEffect(() => {
    if (!initialDataVisible) return;
    const timer = window.setTimeout(() => setInitialSkeletonVisible(false), SKELETON_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [initialDataVisible]);

  // The schedule column dictates the grid row height, so the connectors need the stack measured.
  useEffect(() => {
    const node = vesselStackRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setVesselStackHeight(entry.contentRect.height));
    observer.observe(node);
    return () => observer.disconnect();
  }, [initialDataVisible, tab]);

  const destination = terminals.find((terminal) => terminal.id === effectiveDestinationId) ?? null;
  const currentSailing = scheduleResponse?.data ? getCurrentSailing(scheduleResponse.data) : null;
  // A manual refresh replaces the same data in place, so it must not raise the loading cover.
  const refreshing = loading || scheduleLoading;
  const viewUpdating = !backgroundRefresh && (loading || (scheduleLoading && (tab === 'routes' || tab === 'schedule')));
  const initialLoading = !initialDataVisible && (loading || hasOverview);

  useEffect(() => {
    if (backgroundRefresh && !refreshing) setBackgroundRefresh(false);
  }, [backgroundRefresh, refreshing]);

  useEffect(() => {
    if (viewUpdating) {
      setRetainedUpdateSkeleton(true);
      return;
    }
    if (!retainedUpdateSkeleton) return;
    const timer = window.setTimeout(() => setRetainedUpdateSkeleton(false), SKELETON_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [retainedUpdateSkeleton, viewUpdating]);
  const canSwapRoute = selectedTerminalId !== null && effectiveDestinationId !== null && (mateResponse?.data ?? []).some((mate) =>
    mate.departingTerminalId === effectiveDestinationId && mate.arrivingTerminalId === selectedTerminalId,
  );

  const swapRoute = () => {
    if (!canSwapRoute || selectedTerminalId === null || effectiveDestinationId === null) return;
    const previousTerminalId = selectedTerminalId;
    setSelectedTerminalId(effectiveDestinationId);
    setDestinationId(previousTerminalId);
  };

  const refreshAll = () => {
    setBackgroundRefresh(true);
    loadOverview();
    setRefreshVersion((current) => current + 1);
  };

  const openRoute = (terminalId: number | null, destination: number | null) => {
    if (terminalId === null) return;
    setSelectedTerminalId(terminalId);
    setDestinationId(destination);
    setTab('routes');
  };

  const toggleFavoriteTerminal = () => {
    if (selectedTerminalId === null) return;
    const nextFavorites = favoriteTerminalIds.includes(selectedTerminalId)
      ? favoriteTerminalIds.filter((id) => id !== selectedTerminalId)
      : [...favoriteTerminalIds, selectedTerminalId];
    setFavoriteTerminalIds(nextFavorites);
    try { localStorage.setItem(favoriteTerminalsKey, JSON.stringify(nextFavorites)); } catch { /* Favorites remain active for this tab. */ }
  };

  const toggleSailingsOnly = () => {
    const next = !sailingsOnly;
    setSailingsOnly(next);
    try { localStorage.setItem(sailingsOnlyKey, String(next)); } catch { /* The choice just resets on the next visit. */ }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setTab(tabs[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
        <div className="brand"><span className="brand-mark"><Anchor size={22} /></span><div><strong>Ferry Tracker</strong><span>WSDOT data explorer</span></div></div>
        <div className="header-actions">
          {lastRefreshAt && <span className="refresh-time" title={`Last refresh ${localTime(lastRefreshAt)}`}><Clock3 size={13} /><span className="refresh-time-label">Last refresh</span><time dateTime={lastRefreshAt}>{refreshTime(lastRefreshAt)}</time></span>}
          {terminalResponse && <span className={`source-badge ${terminalResponse.source}`}>{terminalResponse.source}</span>}
          {tab === 'routes' && <button className={`icon-button sailings-only-button${sailingsOnly ? ' active' : ''}`} type="button" aria-pressed={sailingsOnly} aria-label="Sailings only" title={sailingsOnly ? 'Show the terminal and vessels again' : 'Show the sailings schedule only'} onClick={toggleSailingsOnly}><ListFilter size={18} /></button>}
          <button className={`icon-button${refreshing ? ' is-busy' : ''}`} type="button" title="Refresh data" aria-label="Refresh data" disabled={refreshing} onClick={refreshAll}><RefreshCw size={18} /></button>
          <ThemeMenu />
        </div>
        </div>
      </header>

      <main>
        <section className={`selection-band${tab === 'routes' && sailingsOnly ? ' is-sailings-only' : ''}`} aria-labelledby="route-heading">
          <div className="route-title"><span className="eyebrow">Live route explorer</span><h1 id="route-heading">Live sailings and vessel positions</h1></div>
          <div className="selectors">
            <div className="selector-field"><span>Terminal</span><div className="selector-control-row"><FilterSelect ariaLabel="Terminal" value={selectedTerminalId} onChange={setSelectedTerminalId} disabled={loading && !backgroundRefresh} options={terminalOptions} /><button className={`favorite-button${selectedTerminalId !== null && favoriteTerminalIdSet.has(selectedTerminalId) ? ' active' : ''}`} type="button" aria-label={selectedTerminalId === null ? 'Favorite selected origin' : favoriteTerminalIdSet.has(selectedTerminalId) ? `Remove ${selectedTerminal?.name ?? 'selected origin'} from favorites` : `Add ${selectedTerminal?.name ?? 'selected origin'} to favorites`} title={selectedTerminalId !== null && favoriteTerminalIdSet.has(selectedTerminalId) ? 'Remove from favorites' : 'Add to favorites'} disabled={selectedTerminalId === null || (loading && !backgroundRefresh)} aria-pressed={selectedTerminalId !== null && favoriteTerminalIdSet.has(selectedTerminalId)} onClick={toggleFavoriteTerminal}><Star fill={selectedTerminalId !== null && favoriteTerminalIdSet.has(selectedTerminalId) ? 'currentColor' : 'none'} size={16} /></button></div></div>
            <button className="swap-button" type="button" aria-label="Reverse route" title={canSwapRoute ? 'Swap terminal and destination' : 'Reverse route unavailable'} disabled={!canSwapRoute} onClick={swapRoute}><ArrowLeftRight size={18} /></button>
            <label><span>Destination</span><FilterSelect ariaLabel="Destination" value={effectiveDestinationId} onChange={setDestinationId} disabled={!destinationIds.length} placeholder="No live association" options={destinationIds.map((id) => ({ value: id, label: terminals.find((terminal) => terminal.id === id)?.name ?? 'Unknown' }))} /></label>
            <label className="day-field"><span>Day</span><FilterSelect ariaLabel="Day" value={serviceDate} onChange={setServiceDate} disabled={!historyDates.length} options={dayOptions} /></label>
          </div>
        </section>

        {error && <div className="error-banner" role="alert">{error}</div>}
        <nav className={`tabs${tab === 'routes' && sailingsOnly ? ' is-sailings-only' : ''}`} role="tablist" aria-label="Data views">
          {tabs.map(({ id, label, icon: Icon }, index) => <button ref={(element) => { tabRefs.current[index] = element; }} id={`tab-${id}`} aria-controls={`panel-${id}`} aria-selected={tab === id} role="tab" tabIndex={tab === id ? 0 : -1} key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)} onKeyDown={(event) => handleTabKeyDown(event, index)}><Icon size={16} />{label}</button>)}
        </nav>

        <section className="view" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} aria-live="polite" aria-busy={initialLoading || viewUpdating || backgroundRefresh}>
          {(initialLoading || (initialDataVisible && initialSkeletonVisible)) && <div className={`initial-loading-cover${initialDataVisible ? ' is-exiting' : ''}`}><ViewPlaceholder label="Loading ferry data" tab={tab} sailingsOnly={sailingsOnly} /></div>}
          {!initialDataVisible && !initialLoading && <div className="state">Ferry data is unavailable.</div>}

          {initialDataVisible && <div className={`view-content${viewUpdating ? ' is-updating' : ''}`}>
          {/* Keyed by tab so React remounts the panel and replays the enter animation on every switch. */}
          <div className="view-panel" key={tab}>
          {tab === 'routes' && <div className={`relationship-grid${sailingsOnly ? ' is-sailings-only' : ''}`} style={vesselStackHeight ? { '--vessel-stack-height': `${vesselStackHeight}px` } as CSSProperties : undefined}>
            <article className="relationship-node terminal-node"><span className="node-type">Terminal</span><h2>{selectedTerminal?.name ?? 'No terminal'}</h2><div className="field"><dt>City</dt><dd>{selectedTerminal?.city}{selectedTerminal?.latitude && selectedTerminal?.longitude ? <> <a href={`https://maps.google.com/?q=${selectedTerminal.latitude},${selectedTerminal.longitude}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none', marginLeft: '6px' }}><ExternalLink size={13} /></a></> : null}</dd></div><Field label="Coordinates" value={selectedTerminal ? `${selectedTerminal.latitude}, ${selectedTerminal.longitude}` : null} /></article>
            <div className="relationship-link"><span>{associatedVessels.length} associated</span><ArrowRight /></div>
            <div className={`vessel-stack${recordedDay ? ' is-dimmed' : ''}`} ref={vesselStackRef}>{recordedDay && <p className="vessel-live-note">Live positions only.</p>}{associatedVessels.length ? associatedVessels.map((vessel) => <article className="relationship-node vessel-node" key={vessel.id}><span className="node-type">Vessel</span><div className="vessel-status-icon">{vessel.atDock ? <Anchor size={20} /> : <Wind size={20} />}</div><h2>{vessel.name}</h2><p>{vessel.departingTerminalName ?? '—'} <ArrowRight size={14} /> {vessel.arrivingTerminalName ?? '—'}</p><Field label="Class" value={vessel.vesselClass} /><Field label="Left dock" value={<VesselDeparture vessel={vessel} />} /><Field label="ETA" value={<VesselEta vessel={vessel} />} /><Field label="ETA basis" value={vessel.etaBasis ? <span className="field-note">{vessel.etaBasis}</span> : null} /><Field label="Speed" value={vessel.speed === null ? null : `${vessel.speed} knots`} /><Field label="Updated" value={fieldTime(vessel.updatedAt)} /></article>) : <div className="empty">No vessel currently references this terminal.</div>}</div>
            <div className="relationship-link"><span>{scheduleResponse?.data.length ?? 0} sailings</span><ArrowRight /></div>
            <article className="relationship-node schedule-node">
              <span className="node-type">Sailings schedule</span>
              <h2>{selectedTerminal?.name ?? '—'} to {destination?.name ?? '—'}</h2>
              {scheduleResponse?.data.length ? <ol className="sailing-list">{scheduleResponse.data.map((sailing, index) => <li key={`${sailing.departingTime}-${index}`} className={isCurrentSailing(sailing, currentSailing) ? 'current' : ''}><strong>{localTime(sailing.departingTime)}</strong><span>{sailing.vesselName ?? 'Vessel unassigned'}</span>{sailing.spaceAvailable && <span className={`space-count${sailing.spaceSource === 'recorded' ? ' is-recorded' : ''}`} title={recordedSpaceLabel(sailing) ?? undefined}><Car className="space-icon" size={13} role="img" aria-label="Vehicle space" />{compactVehicleSpace(sailing)} <RecordedSpaceMark sailing={sailing} /> <CapacityMeter sailing={sailing} /></span>}<DepartureDelay sailing={sailing} /></li>)}</ol> : scheduleLoading ? <div className="sailing-placeholder" aria-hidden="true"><i /><i /><i /></div> : <div className="empty">No sailings in this 14-hour window.</div>}
            </article>
          </div>}

          {tab === 'terminals' && <div className="data-grid">{terminals.map((terminal) => <article className="data-card" key={terminal.id}><h2><button className="card-link" type="button" title={`Show ${terminal.name} in the routes view`} onClick={() => openRoute(terminal.id, null)}>{terminal.name}</button></h2><dl><div className="field"><dt>City</dt><dd>{terminal.city}{terminal.latitude && terminal.longitude ? <> <a href={`https://maps.google.com/?q=${terminal.latitude},${terminal.longitude}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none', marginLeft: '6px' }}><ExternalLink size={13} /></a></> : null}</dd></div><Field label="Latitude" value={terminal.latitude} /><Field label="Longitude" value={terminal.longitude} /></dl></article>)}</div>}

          {tab === 'vessels' && <div className="data-grid">{vessels.map((vessel) => <article className="data-card" key={vessel.id}><div className="vessel-status-icon">{vessel.atDock ? <Anchor size={20} /> : <Wind size={20} />}</div><h2>{vessel.departingTerminalId === null ? vessel.name : <button className="card-link" type="button" title={`Show ${vessel.name}'s route in the routes view`} onClick={() => openRoute(vessel.departingTerminalId, vessel.arrivingTerminalId)}>{vessel.name}</button>}</h2><dl><Field label="Class" value={vessel.vesselClass} /><Field label="Direction" value={`${vessel.departingTerminalName ?? '?'} → ${vessel.arrivingTerminalName ?? '?'}`} /><Field label="In service" value={vessel.inService} /><Field label="At dock" value={vessel.atDock} /><Field label="Left dock" value={<VesselDeparture vessel={vessel} />} /><Field label="ETA" value={<VesselEta vessel={vessel} />} /><Field label="ETA basis" value={vessel.etaBasis ? <span className="field-note">{vessel.etaBasis}</span> : null} /><Field label="Updated" value={fieldTime(vessel.updatedAt)} /></dl></article>)}</div>}

          {tab === 'schedule' && <div className="schedule-card"><div className="schedule-heading"><span className="node-type">Sailings schedule</span></div><div className="table-wrap"><table><thead><tr><th>Departure</th><th>Left</th><th>Arrival</th><th>Sailing time</th><th>Vessel</th><th>Vehicle space</th></tr></thead><tbody>{scheduleResponse?.data.map((sailing, index) => <tr key={`${sailing.departingTime}-${index}`} className={isCurrentSailing(sailing, currentSailing) ? 'current' : ''}><td>{localTime(sailing.departingTime)}</td><td>{departureDelayMinutes(sailing) === null ? '—' : <DepartureDelay sailing={sailing} />}</td><td><SailingArrival sailing={sailing} vessels={vessels} /></td><td><SailingTime sailing={sailing} vessels={vessels} /></td><td><SailingVessel sailing={sailing} vessels={vessels} onOpen={openRoute} /></td><td className={sailing.spaceSource === 'recorded' ? 'is-recorded' : undefined} title={recordedSpaceLabel(sailing) ?? undefined}>{vehicleSpace(sailing)} <RecordedSpaceMark sailing={sailing} /> <CapacityMeter sailing={sailing} /></td></tr>)}</tbody></table>{!scheduleLoading && !scheduleResponse?.data.length && <div className="empty">No sailings in this 14-hour window.</div>}</div></div>}

          </div>

          {(viewUpdating || retainedUpdateSkeleton) && <div className={`view-loading-cover${viewUpdating ? '' : ' is-exiting'}`}><ViewPlaceholder label="Loading updated ferry data" tab={tab} sailingsOnly={sailingsOnly} /></div>}
          </div>}
        </section>
      </main>
    </div>
  );
}