import { isValidElement, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Anchor, ArrowLeftRight, ArrowRight, Car, ChevronDown, Clock3, ExternalLink, GripVertical, History, ListFilter, MapPin, Plus, RefreshCw, RotateCcw, Settings, Ship, Star, Timer, TrafficCone, Waypoints, Wind, X } from 'lucide-react';
import type { ApiEnvelope, SailingView, TerminalMateView, TerminalView, VesselView } from '@ferry-tracker/shared';
import { ferryApi } from './api';
import { addFavoriteRoute, BAINBRIDGE_TERMINAL_ID, capacityLevel, CATCH_MINUTE_CHOICES, catchPillClass, catchTiming, catchWindowLevel, catchWindows, clearCatchOverride, clockTime, compactVehicleSpace, DEFAULT_SETTINGS, departureDelayLabel, departureDelayMinutes, disruptionLevel, disruptionLoad, disruptionWaves, fieldTime, getCurrentSailing, isCurrentSailing, isPublishedRoute, LATE_MINUTES, loadCatchOverrides, loadFavoriteRoutes, loadFavoriteTerminalIds, loadSettings, localTime, normalizeSettings, openSpacePercent, orderTerminals, recordedSpaceLabel, refreshTime, removeFavoriteRoute, renameFavoriteRoute, reorderFavoriteRoutes, reorderFavoriteTerminals, routeKey, routeName, routePairName, sailingArrival, sailingTimeMinutes, saveCatchOverrides, saveFavoriteRoutes, saveFavoriteTerminalIds, saveSettings, SEATTLE_TERMINAL_ID, serviceDayLabel, SETTING_CHOICES, setCatchOverride, toggleFavoriteTerminalId, vehicleSpace, vesselDelayMinutes, vesselEta, vesselRouteRank, type CatchOverride, type FavoriteRoute, type FerrySettings, type CatchWindow } from './format';
import { FilterSelect } from './components/FilterSelect';
import { ThemeMenu } from './theme/ThemeMenu';

type Tab = 'routes' | 'terminals' | 'vessels' | 'schedule' | 'catch' | 'disruption' | 'settings';

const tabs: Array<{ id: Tab; label: string; icon: typeof Waypoints }> = [
  { id: 'routes', label: 'Routes', icon: Waypoints },
  { id: 'catch', label: 'Catch', icon: Timer },
  { id: 'disruption', label: 'Disruption', icon: TrafficCone },
  { id: 'schedule', label: 'Sailings', icon: Clock3 },
  { id: 'vessels', label: 'Vessels', icon: Ship },
  { id: 'terminals', label: 'Terminals', icon: MapPin },
  { id: 'settings', label: 'Settings', icon: Settings },
];
const COUNTDOWN_TICK_MS = 15_000;
const BACKGROUND_REFRESH_MS = 60_000;
const MINIMUM_SKELETON_MS = 500;
const SKELETON_EXIT_MS = 520;
const LIVE_DATE = 'live';
const lastRouteKey = 'ferry-tracker-last-route';
const sailingsOnlyKey = 'ferry-tracker-sailings-only';
const catchRouteKey = 'ferry-tracker-catch-route';
const catchPaddingOpenKey = 'ferry-tracker-catch-padding-open';

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

function loadCatchRoute() {
  try {
    return localStorage.getItem(catchRouteKey);
  } catch {
    return null;
  }
}

function loadCatchPaddingOpen() {
  try {
    return localStorage.getItem(catchPaddingOpenKey) === 'true';
  } catch {
    return false;
  }
}

function RecordedSpaceMark({ sailing }: { sailing: SailingView }) {
  const label = recordedSpaceLabel(sailing);
  if (label === null) return null;
  return <History className="recorded-mark" size={12} role="img" aria-label={label} />;
}

// An on-time departure says nothing the scheduled time did not already say.
function DepartureDelay({ sailing }: { sailing: SailingView }) {
  const label = departureDelayLabel(sailing);
  const delay = departureDelayMinutes(sailing);
  if (label === null || delay === null) return null;
  return <span className="departure-delay">{label}<span className="delay-pill" title={`Left ${delay} minutes after the scheduled departure`}>{delay} min</span></span>;
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

function SailingArrival({ sailing, vessels }: { sailing: SailingView; vessels: VesselView[] }) {
  const arrival = sailingArrival(sailing, vessels);
  if (arrival === null) return <>—</>;
  if (!arrival.estimated) return <>{localTime(arrival.at)}</>;
  return <span className="estimated-time" title="Estimated from the vessel's live ETA">{localTime(arrival.at)}</span>;
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

function CapacityPill({ openPercent, total }: { openPercent: number | null; total: number | null }) {
  if (openPercent === null) return null;
  // WSDOT reports space left; the pill reads how full the boat is, which is what people ask.
  const full = 100 - openPercent;
  const label = `${full}% of ${total} vehicle spaces taken`;
  return <span className={`capacity-pill ${capacityLevel(openPercent)}`} aria-label={label} title={label}>{full}%</span>;
}

function CapacityMeter({ sailing }: { sailing: SailingView }) {
  const percent = openSpacePercent(sailing);
  // A wide-open sailing carries no decision value, so only a partial boat gets a pill.
  if (percent === 100) return null;
  return <CapacityPill openPercent={percent} total={sailing.maxSpaceCount} />;
}

// The pill is the whole statement, so the word "late" is never printed beside it.
function CatchDelay({ window }: { window: CatchWindow }) {
  if (window.delayMinutes === null) return null;
  const title = window.delaySource === 'observed'
    ? `Still at the dock ${window.delayMinutes} minutes after the scheduled departure`
    : `Not expected to leave before ${clockTime(window.expectedDepartureAt ?? window.departureAt)}, ${window.delayMinutes} minutes late`;
  return <span className="delay-pill" title={title}>{window.delayMinutes} min</span>;
}

function CatchTimes({ window, settings, compact = false }: { window: CatchWindow; settings: FerrySettings; compact?: boolean }) {
  const estimatedLeaveByAt = window.estimatedLeaveByAt;
  const hasEstimate = window.estimatedMinutesAway !== null && estimatedLeaveByAt !== null;
  const scheduledLevel = catchWindowLevel({ minutesAway: window.minutesAway, spacePercent: window.spacePercent, queueMinutesRemaining: window.queueMinutesRemaining }, settings);
  const estimateTitle = window.delaySource === 'observed'
    ? 'Based on the delay observed so far; departure could be now'
    : 'Based on the inbound vessel ETA; departure may change';
  return <div className={`catch-times${compact ? ' is-compact' : ''}${hasEstimate ? ' has-estimate' : ''}`}>
    <div className={`catch-time is-${scheduledLevel}${window.dimScheduled ? ' is-muted' : ''}`} role="group" aria-label="Scheduled leave by">
      {hasEstimate && <span className="catch-time-label">Scheduled</span>}
      <strong className="countdown-value">{window.queueMinutesRemaining ?? window.minutesAway} min</strong>
      {window.queueMinutesRemaining !== null && <span className="catch-leave-at">Queue remaining</span>}
      <span className="catch-leave-at">Leave by {clockTime(window.leaveByAt)}</span>
      {!compact && <span className="countdown-at">{clockTime(window.departureAt)} sailing</span>}
    </div>
    {hasEstimate && <div className={`catch-time is-${catchWindowLevel(window, settings)}`} role="group" aria-label="Estimated leave by" title={estimateTitle}>
      <span className="catch-time-label">Estimated{window.delaySource === 'observed' ? ' (delay so far)' : ''}</span>
      <strong className="countdown-value">{window.estimatedQueueMinutesRemaining ?? window.estimatedMinutesAway} min</strong>
      {window.estimatedQueueMinutesRemaining !== null && <span className="catch-leave-at">Queue remaining</span>}
      <span className="catch-leave-at">Leave by {clockTime(estimatedLeaveByAt)}</span>
      {window.expectedDepartureAt && <span className="countdown-at">{clockTime(window.expectedDepartureAt)} sailing<CatchDelay window={window} /></span>}
    </div>}
  </div>;
}

function Field({ label, value }: { label: string; value: unknown }) {
  const empty = value === null || value === undefined || value === '';
  return <div className="field"><dt>{label}</dt><dd>{empty ? '—' : isValidElement(value) ? value : String(value)}</dd></div>;
}

function SettingField({ label, ariaLabel, hint, setting, unit, settings, onChange }: {
  label: string;
  ariaLabel: string;
  hint: string;
  setting: keyof FerrySettings;
  unit: string;
  settings: FerrySettings;
  onChange: (setting: keyof FerrySettings, value: number) => void;
}) {
  return (
    <label className="setting-field">
      <span className="setting-label">{label}</span>
      <FilterSelect
        ariaLabel={ariaLabel}
        value={settings[setting]}
        onChange={(value) => onChange(setting, value)}
        options={SETTING_CHOICES[setting].map((value) => ({ value, label: unit === '%' ? `${value}%` : `${value} min` }))}
      />
      <span className="setting-hint">{hint}</span>
    </label>
  );
}

function VesselLink({ vesselId, vesselName, vessels, onOpen }: { vesselId: number | null; vesselName: string; vessels: VesselView[]; onOpen: (terminalId: number | null, destination: number | null) => void }) {
  const live = vessels.find((vessel) => vessel.id === vesselId);
  if (!live || live.departingTerminalId === null) return <>{vesselName}</>;
  return <button className="card-link" type="button" title={`Show ${vesselName}'s current route in the routes view`} onClick={() => onOpen(live.departingTerminalId, live.arrivingTerminalId)}>{vesselName}</button>;
}

function SailingVessel({ sailing, vessels, onOpen }: { sailing: SailingView; vessels: VesselView[]; onOpen: (terminalId: number | null, destination: number | null) => void }) {
  if (!sailing.vesselName) return <span className="null">null</span>;
  return <VesselLink vesselId={sailing.vesselId} vesselName={sailing.vesselName} vessels={vessels} onOpen={onOpen} />;
}

function ViewPlaceholder({ label, tab, sailingsOnly }: { label: string; tab: Tab; sailingsOnly?: boolean }) {
  if (tab === 'terminals' || tab === 'vessels') {
    return <div className="view-placeholder" role="status" aria-label={label}><span className="sr-only">{label}</span><div className="data-grid placeholder-card-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <div className="data-card placeholder-node" key={index}><i /><i /><i /><i /></div>)}</div></div>;
  }
  if (tab === 'schedule' || tab === 'catch' || tab === 'disruption' || tab === 'settings') {
    return <div className="view-placeholder" role="status" aria-label={label}><span className="sr-only">{label}</span><div className="wide-placeholder" aria-hidden="true"><i /><i /><i /><i /><i /></div></div>;
  }
  return <div className="view-placeholder" role="status" aria-label={label}><span className="sr-only">{label}</span><div className={`relationship-grid placeholder-grid${sailingsOnly ? ' is-sailings-only' : ''}`} aria-hidden="true"><div className="relationship-node placeholder-node"><i /><i /><i /><i /></div><div className="relationship-link" /><div className="relationship-node placeholder-node"><i /><i /><i /><i /><i /></div><div className="relationship-link" /><div className="relationship-node placeholder-node"><i /><i /><i /><i /><i /></div></div></div>;
}

export function App() {
  const [terminalResponse, setTerminalResponse] = useState<ApiEnvelope<TerminalView[]> | null>(null);
  const [vesselResponse, setVesselResponse] = useState<ApiEnvelope<VesselView[]> | null>(null);
  const [mateResponse, setMateResponse] = useState<ApiEnvelope<TerminalMateView[]> | null>(null);
  const [scheduleResponse, setScheduleResponse] = useState<ApiEnvelope<SailingView[]> | null>(null);
  const [catchResponse, setCatchResponse] = useState<ApiEnvelope<SailingView[]> | null>(null);
  const [inboundResponse, setInboundResponse] = useState<ApiEnvelope<SailingView[]> | null>(null);
  const [inboundError, setInboundError] = useState<string | null>(null);
  const [catchLoading, setCatchLoading] = useState(false);
  const [catchError, setCatchError] = useState<string | null>(null);
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
  const [draggedFavoriteId, setDraggedFavoriteId] = useState<number | null>(null);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [favoriteRoutes, setFavoriteRoutes] = useState<FavoriteRoute[]>(loadFavoriteRoutes);
  const [draggedRouteKey, setDraggedRouteKey] = useState<string | null>(null);
  const [favoriteRoutesOpen, setFavoriteRoutesOpen] = useState(false);
  const [newRouteOriginId, setNewRouteOriginId] = useState<number | null>(null);
  const [newRouteDestinationId, setNewRouteDestinationId] = useState<number | null>(null);
  const [selectedCatchRoute, setSelectedCatchRoute] = useState<string | null>(loadCatchRoute);
  const [catchOverrides, setCatchOverrides] = useState(loadCatchOverrides);
  const [catchPaddingOpen, setCatchPaddingOpen] = useState(loadCatchPaddingOpen);
  const [sailingsOnly, setSailingsOnly] = useState(loadSailingsOnly);
  const [settings, setSettings] = useState<FerrySettings>(loadSettings);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const overviewRequestId = useRef(0);
  const scheduleRequestId = useRef(0);
  const vesselStackRef = useRef<HTMLDivElement>(null);
  const favoriteListRef = useRef<HTMLUListElement>(null);
  const favoriteRouteListRef = useRef<HTMLUListElement>(null);
  const [vesselStackHeight, setVesselStackHeight] = useState(0);
  const previousTabRef = useRef<Tab>(tab);
  const historyDatesRef = useRef<string[]>(historyDates);
  const serviceDateRef = useRef(serviceDate);
  historyDatesRef.current = historyDates;
  serviceDateRef.current = serviceDate;

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
        setCountdownNow(Date.now());
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
  const orderedTerminals = orderTerminals(terminals, favoriteTerminalIds);
  const favoriteOrder = orderedTerminals.filter((entry) => entry.favorite).map((entry) => entry.terminal.id);
  const terminalOptions = orderedTerminals.map(({ terminal, favorite }) => ({ value: terminal.id, label: terminal.name, favorite }));
  const vessels = vesselResponse?.data ?? [];
  const mates = mateResponse?.data ?? [];
  const selectedTerminal = terminals.find((terminal) => terminal.id === selectedTerminalId) ?? null;
  const destinationIds = [...new Set(mates
    .filter((mate) => mate.departingTerminalId === selectedTerminalId)
    .map((mate) => mate.arrivingTerminalId))];
  const effectiveDestinationId = destinationId !== null && destinationIds.includes(destinationId)
    ? destinationId
    : destinationIds[0] ?? null;
  const catchRoute = favoriteRoutes.find((route) => routeKey(route) === selectedCatchRoute) ?? favoriteRoutes[0] ?? null;
  const catchOriginId = catchRoute?.originId ?? null;
  const catchDestinationId = catchRoute?.destinationId ?? null;
  const catchRouteKeyValue = catchRoute ? routeKey(catchRoute) : null;
  const timing = catchTiming(settings, catchRouteKeyValue === null ? undefined : catchOverrides[catchRouteKeyValue]);
  const newRouteDestinationIds = [...new Set(mates
    .filter((mate) => mate.departingTerminalId === newRouteOriginId)
    .map((mate) => mate.arrivingTerminalId))];
  const effectiveNewRouteDestinationId = newRouteDestinationId !== null && newRouteDestinationIds.includes(newRouteDestinationId)
    ? newRouteDestinationId
    : newRouteDestinationIds[0] ?? null;
  const canAddRoute = newRouteOriginId !== null && effectiveNewRouteDestinationId !== null
    && !favoriteRoutes.some((route) => routeKey(route) === `${newRouteOriginId}-${effectiveNewRouteDestinationId}`);
  const routelessTab = tab === 'catch' || tab === 'disruption' || tab === 'settings' || tab === 'vessels' || tab === 'terminals';
  const quickPickRoutes = favoriteRoutes.filter((route) => isPublishedRoute(route, mates));
  const associatedVessels = selectedTerminalId === null ? [] : vessels
    .filter((vessel) => vessel.departingTerminalId === selectedTerminalId || vessel.arrivingTerminalId === selectedTerminalId)
    .sort((left, right) =>
      vesselRouteRank(left, selectedTerminalId, effectiveDestinationId) - vesselRouteRank(right, selectedTerminalId, effectiveDestinationId)
      || left.name.localeCompare(right.name));
  const hasOverview = terminalResponse !== null && vesselResponse !== null && mateResponse !== null;
  const recordedDay = serviceDate !== LIVE_DATE;
  const latestRecordedDay = historyDates[0] ?? null;
  // A finished day never gains another sailing, so only the day still being recorded is polled.
  const scheduleDayIsLive = !recordedDay || serviceDate === latestRecordedDay;
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

  // Browsing the Sailings tab defaults to the most recently recorded day; leaving it goes back to live.
  useEffect(() => {
    const previousTab = previousTabRef.current;
    if (tab === 'schedule' && previousTab !== 'schedule') {
      if (historyDatesRef.current.length) setServiceDate(historyDatesRef.current[0]);
    } else if (previousTab === 'schedule' && tab !== 'schedule') {
      if (serviceDateRef.current !== LIVE_DATE) setServiceDate(LIVE_DATE);
    }
    previousTabRef.current = tab;
  }, [tab]);

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
  const currentSailing = scheduleResponse?.data ? getCurrentSailing(scheduleResponse.data, vessels) : null;
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const waves = disruptionWaves(vessels, countdownNow, settings, inboundResponse?.data ?? []);
  const [nextWave, ...laterWaves] = waves;
  const nextLoad = nextWave && nextWave.vesselId !== null && nextWave.source !== 'schedule'
    ? disruptionLoad(inboundResponse?.data ?? [], nextWave.vesselId, nextWave.landingAt) : null;
  const catches = catchWindows(catchResponse?.data ?? [], countdownNow, timing, vessels);
  const [nextCatch, ...laterCatches] = catches;
  const minuteOptions = CATCH_MINUTE_CHOICES.map((minutes) => ({ value: minutes, label: `${minutes} min` }));

  const changeCatchOverride = (patch: Partial<CatchOverride>) => {
    if (catchRouteKeyValue === null) return;
    const next = setCatchOverride(catchOverrides, catchRouteKeyValue, patch);
    setCatchOverrides(next);
    saveCatchOverrides(next);
  };

  const resetCatchOverride = () => {
    if (catchRouteKeyValue === null) return;
    const next = clearCatchOverride(catchOverrides, catchRouteKeyValue);
    setCatchOverrides(next);
    saveCatchOverrides(next);
  };

  const changeSetting = (key: keyof FerrySettings, value: number) => {
    const next = normalizeSettings({ ...settings, [key]: value });
    setSettings(next);
    saveSettings(next);
  };

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
  };
  // A manual refresh replaces the same data in place, so it must not raise the loading cover.
  const refreshing = loading || scheduleLoading;
  const viewUpdating = !backgroundRefresh && (loading || (scheduleLoading && (tab === 'routes' || tab === 'schedule')));
  const initialLoading = !initialDataVisible && (loading || hasOverview);

  useEffect(() => {
    if (backgroundRefresh && !refreshing) setBackgroundRefresh(false);
  }, [backgroundRefresh, refreshing]);

  // The countdown only has to stay honest while it is on screen.
  useEffect(() => {
    if (tab !== 'catch' && tab !== 'disruption') return;
    setCountdownNow(Date.now());
    const timer = window.setInterval(() => setCountdownNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [tab]);

  // Ticking the clock is not enough: a boat that ties up leaves the vessel feed and the one
  // behind it only appears in a fresh fetch, so the countdown tabs poll while they are open.
  // Sailings polls for the same reason: the rollup stamps a dock arrival minutes after it happens.
  useEffect(() => {
    const polling = tab === 'catch' || tab === 'disruption' || (tab === 'schedule' && scheduleDayIsLive);
    if (!polling) return;
    const timer = window.setInterval(() => {
      setBackgroundRefresh(true);
      loadOverview();
      setRefreshVersion((current) => current + 1);
    }, BACKGROUND_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [scheduleDayIsLive, tab]);

  // The Catch tab follows the chosen favorite route, so it needs its own schedule rather than
  // the route the selectors happen to be showing. Keyed on the terminals, so renaming a
  // favorite does not refetch.
  useEffect(() => {
    if (tab !== 'catch' || catchOriginId === null || catchDestinationId === null) return;
    const controller = new AbortController();
    let active = true;
    setCatchLoading(true);
    ferryApi.schedule(catchOriginId, catchDestinationId, controller.signal)
      .then((schedule) => {
        if (!active) return;
        setCatchResponse(schedule);
        setCatchError(null);
        setLastRefreshAt((current) => latestTimestamp(current, schedule.fetchedAt));
      })
      .catch((cause: unknown) => {
        if (active) setCatchError(cause instanceof Error ? cause.message : 'Unable to load the schedule for this route.');
      })
      .finally(() => {
        if (active) setCatchLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [catchOriginId, catchDestinationId, refreshVersion, tab]);

  // Inbound sailings supply observed arrivals, scheduled fallback times, and recorded capacity.
  useEffect(() => {
    if (tab !== 'disruption') return;
    const controller = new AbortController();
    let active = true;
    ferryApi.schedule(SEATTLE_TERMINAL_ID, BAINBRIDGE_TERMINAL_ID, controller.signal)
      .then((schedule) => {
        if (!active) return;
        setInboundResponse(schedule);
        setInboundError(null);
        setCountdownNow(Date.now());
        setLastRefreshAt((current) => latestTimestamp(current, schedule.fetchedAt));
      })
      .catch(() => {
        if (active) setInboundError('Schedule unavailable. Retrying on the next refresh.');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [refreshVersion, tab]);

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

  // The band sits on Routes and Sailings alike, so a chip there changes the route in place.
  const pickRoute = (terminalId: number, destination: number) => {
    setSelectedTerminalId(terminalId);
    setDestinationId(destination);
  };

  const toggleFavoriteTerminal = (terminalId: number) => {
    const nextFavorites = toggleFavoriteTerminalId(favoriteTerminalIds, terminalId);
    setFavoriteTerminalIds(nextFavorites);
    saveFavoriteTerminalIds(nextFavorites);
  };

  const reorderFavoriteTerminal = (terminalId: number, targetId: number) => {
    const nextFavorites = reorderFavoriteTerminals(favoriteTerminalIds, favoriteOrder, terminalId, targetId);
    setFavoriteTerminalIds(nextFavorites);
    saveFavoriteTerminalIds(nextFavorites);
  };

  const nudgeFavoriteTerminal = (terminalId: number, direction: -1 | 1) => {
    const target = favoriteOrder[favoriteOrder.indexOf(terminalId) + direction];
    if (target !== undefined) reorderFavoriteTerminal(terminalId, target);
  };

  // The dragged row swaps into place as the pointer passes each favorite, so it follows the grip.
  const dragFavoriteTerminal = (clientY: number, terminalId: number) => {
    for (const row of favoriteListRef.current?.querySelectorAll<HTMLElement>('li.is-favorite') ?? []) {
      const box = row.getBoundingClientRect();
      if (clientY < box.top || clientY > box.bottom) continue;
      const overId = Number(row.dataset.terminalId);
      if (overId !== terminalId) reorderFavoriteTerminal(terminalId, overId);
      return;
    }
  };

  // Reordering moves the grip's own DOM node, which drops its pointer capture, so the window
  // has to see the rest of the drag.
  useEffect(() => {
    if (draggedFavoriteId === null && draggedRouteKey === null) return;
    const move = (event: PointerEvent) => {
      if (draggedFavoriteId !== null) dragFavoriteTerminal(event.clientY, draggedFavoriteId);
      else if (draggedRouteKey !== null) dragFavoriteRoute(event.clientY, draggedRouteKey);
    };
    const stop = () => {
      setDraggedFavoriteId(null);
      setDraggedRouteKey(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  });

  const changeFavoriteRoutes = (next: FavoriteRoute[]) => {
    setFavoriteRoutes(next);
    saveFavoriteRoutes(next);
  };

  const addRoute = () => {
    if (newRouteOriginId === null || effectiveNewRouteDestinationId === null) return;
    changeFavoriteRoutes(addFavoriteRoute(favoriteRoutes, newRouteOriginId, effectiveNewRouteDestinationId));
    setNewRouteDestinationId(null);
  };

  const nudgeFavoriteRoute = (key: string, direction: -1 | 1) => {
    const keys = favoriteRoutes.map(routeKey);
    const target = keys[keys.indexOf(key) + direction];
    if (target !== undefined) changeFavoriteRoutes(reorderFavoriteRoutes(favoriteRoutes, key, target));
  };

  const dragFavoriteRoute = (clientY: number, key: string) => {
    for (const row of favoriteRouteListRef.current?.querySelectorAll<HTMLElement>('li') ?? []) {
      const box = row.getBoundingClientRect();
      if (clientY < box.top || clientY > box.bottom) continue;
      const overKey = row.dataset.routeKey;
      if (overKey && overKey !== key) changeFavoriteRoutes(reorderFavoriteRoutes(favoriteRoutes, key, overKey));
      return;
    }
  };

  const changeCatchRoute = (key: string) => {
    setSelectedCatchRoute(key);
    try { localStorage.setItem(catchRouteKey, key); } catch { /* The choice just resets on the next visit. */ }
  };

  const toggleSailingsOnly = () => {
    const next = !sailingsOnly;
    setSailingsOnly(next);
    try { localStorage.setItem(sailingsOnlyKey, String(next)); } catch { /* The choice just resets on the next visit. */ }
  };

  const toggleCatchPadding = () => {
    const next = !catchPaddingOpen;
    setCatchPaddingOpen(next);
    try { localStorage.setItem(catchPaddingOpenKey, String(next)); } catch { /* The choice just resets on the next visit. */ }
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
      <header className={`app-header${recordedDay && !routelessTab ? ' is-recorded' : ''}`}>
        <div className="header-inner">
        <button className="brand" type="button" title="Go to Routes" onClick={() => setTab('routes')}><span className="brand-mark"><Anchor size={22} /></span><div><strong>Ferry Tracker</strong><span>WSDOT data explorer</span></div></button>
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
        {/* Catch follows its own favorite route, Disruption is pinned, and Settings has no route at all. */}
        <section className={`selection-band${tab === 'routes' && sailingsOnly ? ' is-sailings-only' : ''}${routelessTab ? ' is-routeless' : ''}${quickPickRoutes.length === 0 ? ' is-chipless' : ''}`} aria-labelledby="route-heading">
          <div className="route-title"><span className="eyebrow">Route explorer</span><h1 id="route-heading">Sailings and vessel positions</h1></div>
          <div className="route-controls">
            <div className="selectors">
              <label><span>Origin</span><FilterSelect ariaLabel="Origin" value={selectedTerminalId} onChange={setSelectedTerminalId} disabled={loading && !backgroundRefresh} options={terminalOptions} /></label>
              <button className="swap-button" type="button" aria-label="Reverse route" title={canSwapRoute ? 'Swap origin and destination' : 'Reverse route unavailable'} disabled={!canSwapRoute} onClick={swapRoute}><ArrowLeftRight size={18} /></button>
              <label><span>Destination</span><FilterSelect ariaLabel="Destination" value={effectiveDestinationId} onChange={setDestinationId} disabled={!destinationIds.length} placeholder="No live association" options={destinationIds.map((id) => ({ value: id, label: terminals.find((terminal) => terminal.id === id)?.name ?? 'Unknown' }))} /></label>
              <label className="day-field"><span>Day</span><FilterSelect ariaLabel="Day" value={serviceDate} onChange={setServiceDate} disabled={!historyDates.length} options={dayOptions} /></label>
            </div>
            {!routelessTab && quickPickRoutes.length > 0 && <div className="route-chips" role="group" aria-label="Favorite routes">
              {quickPickRoutes.map((route) => {
                const key = routeKey(route);
                const active = selectedTerminalId === route.originId && effectiveDestinationId === route.destinationId;
                return <button key={key} type="button" className={`route-chip${active ? ' active' : ''}`} aria-pressed={active} title={routePairName(route, terminals)} onClick={() => pickRoute(route.originId, route.destinationId)}>{routeName(route, terminals)}</button>;
              })}
            </div>}
          </div>
        </section>

        {error && <div className="error-banner" role="alert">{error}</div>}
        <nav className="tabs" role="tablist" aria-label="Data views">
          {tabs.map(({ id, label, icon: Icon }, index) => <button ref={(element) => { tabRefs.current[index] = element; }} id={`tab-${id}`} aria-controls={`panel-${id}`} aria-selected={tab === id} role="tab" tabIndex={tab === id ? 0 : -1} key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)} onKeyDown={(event) => handleTabKeyDown(event, index)}><Icon size={16} /><span className="tab-label">{label}</span></button>)}
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

          {tab === 'catch' && <div className="countdown-card">
            <div className="schedule-heading catch-heading has-switcher">
              <div><span className="node-type">Leave by</span><h2>{catchRoute ? routeName(catchRoute, terminals) : 'No favorite route'}</h2></div>
              {favoriteRoutes.length > 1 && <div className="route-chips" role="group" aria-label="Catch route">
                {favoriteRoutes.map((route) => {
                  const key = routeKey(route);
                  const active = key === catchRouteKeyValue;
                  return <button key={key} type="button" className={`route-chip${active ? ' active' : ''}`} aria-pressed={active} title={routePairName(route, terminals)} onClick={() => changeCatchRoute(key)}>{routeName(route, terminals)}</button>;
                })}
              </div>}
            </div>
            {catchRoute && <div className="catch-timing">
              <button className="settings-disclosure" type="button" aria-expanded={catchPaddingOpen} onClick={toggleCatchPadding}>
                <ChevronDown className={catchPaddingOpen ? 'open' : ''} size={14} />
                <span className="node-type">Padding</span>
                <span className="settings-disclosure-count">{timing.padMinutes} min</span>
                {timing.overridden && <span className="catch-timing-custom">Custom</span>}
              </button>
              {catchPaddingOpen && <div className="catch-timing-controls">
                <label><span>Traffic</span><FilterSelect ariaLabel="Catch traffic" value={timing.trafficMinutes} onChange={(value) => changeCatchOverride({ trafficMinutes: value })} options={minuteOptions} /></label>
                <label><span>Queue</span><FilterSelect ariaLabel="Catch queue" value={timing.queueMinutes} onChange={(value) => changeCatchOverride({ queueMinutes: value })} options={minuteOptions} /></label>
                {timing.overridden && <button className="catch-timing-reset" type="button" title="Go back to the padding in Settings" onClick={resetCatchOverride}><RotateCcw size={13} aria-hidden="true" /><span className="catch-timing-words">Use settings</span></button>}
              </div>}
            </div>}
            {!catchRoute ? <div className="empty">Add a favorite route in Settings to see when to leave.</div>
              : catchLoading && !catchResponse ? <div className="sailing-placeholder" aria-hidden="true"><i /><i /><i /></div>
              : catchError ? <div className="empty">{catchError}</div>
              : nextCatch ? <>
                <div className={`countdown-headline is-${catchWindowLevel(nextCatch, settings)}`}>
                  <CatchTimes window={nextCatch} settings={settings} />
                </div>
                <dl className="countdown-detail">
                  <Field label="Departure" value={<>{nextCatch.expectedDepartureAt && 'Scheduled '}{fieldTime(nextCatch.departureAt)}<CatchDelay window={nextCatch} />{nextCatch.expectedDepartureAt && <span className="catch-departure-estimate" title={nextCatch.delaySource === 'observed' ? 'Delay observed so far; not a future departure forecast' : 'Earliest departure from the inbound vessel ETA'}>Estimated {fieldTime(nextCatch.expectedDepartureAt)}{nextCatch.delaySource === 'observed' ? ' (delay so far)' : ''}</span>}</>} />
                  <Field label="Vessel" value={nextCatch.vesselName && <VesselLink vesselId={nextCatch.vesselId} vesselName={nextCatch.vesselName} vessels={vessels} onOpen={openRoute} />} />
                  <Field label="Space" value={nextCatch.spaceLabel && <>{nextCatch.spaceLabel} <CapacityPill openPercent={nextCatch.spacePercent} total={nextCatch.spaceTotal} /></>} />
                </dl>
                {laterCatches.length > 0 && <div className="countdown-later"><span className="node-type">Then</span><ol className="sailing-list">{laterCatches.slice(0, 4).map((window) => <li key={window.departureAt}><strong>{clockTime(window.departureAt)}<CatchDelay window={window} /></strong><CatchTimes window={window} settings={settings} compact /><span>{window.spaceLabel ? `${window.spaceLabel} ` : ''}<CapacityPill openPercent={window.spacePercent} total={window.spaceTotal} /></span></li>)}</ol></div>}
              </> : <div className="empty">No sailing left today that you can still make.</div>}
          </div>}

          {tab === 'disruption' && <div className="countdown-card">
            <div className="schedule-heading"><span className="node-type">Next disruption</span><h2>Bainbridge Island offload</h2></div>
            {inboundError && <div className="empty" role="status">{inboundResponse ? 'Schedule refresh failed. Showing the last loaded schedule.' : inboundError}</div>}
            {nextWave ? <>
              <div className={`countdown-headline is-${disruptionLevel(nextWave.minutesAway, settings)}`}>
                <strong className="countdown-value">{nextWave.active
                  ? (nextWave.ongoing ? 'Ongoing' : `${nextWave.minutesLeft} min left`)
                  : nextWave.minutesAway < 1 ? 'under 1 min' : `${nextWave.minutesAway} min`}</strong>
                <span className="countdown-at">Traffic {nextWave.active ? 'since' : 'from'} {clockTime(nextWave.disruptionAt)}</span>
                {nextWave.source === 'schedule' && <span className="countdown-at" title="Published arrival, or scheduled departure plus a 35-minute crossing when arrival is unavailable">Scheduled estimate</span>}
              </div>
              <dl className="countdown-detail">
                <Field label="Vessel" value={<VesselLink vesselId={nextWave.vesselId} vesselName={nextWave.vesselName} vessels={vessels} onOpen={openRoute} />} />
                <Field label="Lands" value={fieldTime(nextWave.landingAt)} />
                <Field label="Disruption" value={nextWave.ongoing ? `${clockTime(nextWave.disruptionAt)} onward` : `${clockTime(nextWave.disruptionAt)} to ${clockTime(nextWave.clearsAt)}`} />
                <Field label="Capacity" value={nextLoad && <CapacityPill openPercent={nextLoad.openPercent} total={nextLoad.totalSpace} />} />
              </dl>
              {laterWaves.length > 0 && <div className="countdown-later"><span className="node-type">Behind it</span><ol className="sailing-list">{laterWaves.slice(0, 4).map((wave) => <li key={`${wave.vesselId}-${wave.disruptionAt}`}><strong>{clockTime(wave.disruptionAt)}<span className={`capacity-pill ${catchPillClass(disruptionLevel(wave.minutesAway, settings))}`}>{wave.active ? 'now' : `${wave.minutesAway} min`}</span></strong><span>{wave.vesselName} lands {clockTime(wave.landingAt)}{wave.source === 'schedule' ? ' (scheduled estimate)' : ''}</span></li>)}</ol></div>}
            </> : !inboundError && <div className="empty">{inboundResponse === null ? 'Loading the inbound schedule...' : 'No upcoming arrival is available in the current schedule.'}</div>}
          </div>}

          {tab === 'settings' && <div className="countdown-card settings-card">
            <div className="schedule-heading"><h2>Settings</h2></div>
            <div className="settings-section">
              <button className="settings-disclosure" type="button" aria-expanded={favoritesOpen} onClick={() => setFavoritesOpen(!favoritesOpen)}>
                <ChevronDown className={favoritesOpen ? 'open' : ''} size={14} />
                <span className="node-type">Favorite terminals</span>
                <span className="settings-disclosure-count">{favoriteOrder.length} starred</span>
              </button>
              {favoritesOpen && <>
              <p className="settings-note">Starred terminals lead the Origin list. Drag a handle to change their order.</p>
              <ul className="favorite-list" ref={favoriteListRef}>
                {orderedTerminals.map(({ terminal, favorite }) => <li
                  key={terminal.id}
                  data-terminal-id={terminal.id}
                  className={`${favorite ? 'is-favorite' : ''}${draggedFavoriteId === terminal.id ? ' is-dragging' : ''}`}
                >
                  {favorite ? <button
                    className="favorite-grip"
                    type="button"
                    aria-label={`Reorder ${terminal.name}`}
                    title="Drag to reorder, or use the arrow keys"
                    onPointerDown={(event) => { event.preventDefault(); event.currentTarget.focus(); setDraggedFavoriteId(terminal.id); }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                      event.preventDefault();
                      nudgeFavoriteTerminal(terminal.id, event.key === 'ArrowUp' ? -1 : 1);
                    }}
                  ><GripVertical size={14} /></button> : <span className="favorite-grip is-placeholder" />}
                  <span className="favorite-name">{terminal.name}</span>
                  <button className={`favorite-star${favorite ? ' active' : ''}`} type="button" aria-pressed={favorite} aria-label={favorite ? `Remove ${terminal.name} from favorites` : `Add ${terminal.name} to favorites`} title={favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => toggleFavoriteTerminal(terminal.id)}><Star fill={favorite ? 'currentColor' : 'none'} size={15} /></button>
                </li>)}
              </ul>
              </>}
            </div>
            <div className="settings-section">
              <button className="settings-disclosure" type="button" aria-expanded={favoriteRoutesOpen} onClick={() => setFavoriteRoutesOpen(!favoriteRoutesOpen)}>
                <ChevronDown className={favoriteRoutesOpen ? 'open' : ''} size={14} />
                <span className="node-type">Favorite routes</span>
                <span className="settings-disclosure-count">{favoriteRoutes.length} saved</span>
              </button>
              {favoriteRoutesOpen && <>
              <p className="settings-note">Favorite routes fill the Catch tab and the quick pick beside the selectors. Drag a handle to change their order.</p>
              <ul className="favorite-list favorite-route-list" ref={favoriteRouteListRef}>
                {favoriteRoutes.map((route) => {
                  const key = routeKey(route);
                  const pair = routePairName(route, terminals);
                  return <li key={key} data-route-key={key} className={`is-favorite${draggedRouteKey === key ? ' is-dragging' : ''}`}>
                    <button
                      className="favorite-grip"
                      type="button"
                      aria-label={`Reorder ${pair}`}
                      title="Drag to reorder, or use the arrow keys"
                      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.focus(); setDraggedRouteKey(key); }}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                        event.preventDefault();
                        nudgeFavoriteRoute(key, event.key === 'ArrowUp' ? -1 : 1);
                      }}
                    ><GripVertical size={14} /></button>
                    <span className="favorite-route">
                      <input className="favorite-label" value={route.label} maxLength={24} placeholder={pair} aria-label={`Label for ${pair}`} onChange={(event) => changeFavoriteRoutes(renameFavoriteRoute(favoriteRoutes, key, event.target.value))} />
                      <span className="favorite-pair">{pair}{!isPublishedRoute(route, mates) && hasOverview && <em> · not sailing</em>}</span>
                    </span>
                    <button className="favorite-remove" type="button" aria-label={`Remove ${pair} from favorite routes`} title="Remove this route" onClick={() => changeFavoriteRoutes(removeFavoriteRoute(favoriteRoutes, key))}><X size={15} /></button>
                  </li>;
                })}
              </ul>
              {!favoriteRoutes.length && <p className="settings-note">No favorite routes yet.</p>}
              <div className="route-add">
                <FilterSelect ariaLabel="New route origin" value={newRouteOriginId} onChange={setNewRouteOriginId} placeholder="Origin" options={terminalOptions} />
                <ArrowRight className="route-add-arrow" size={14} aria-hidden="true" />
                <FilterSelect ariaLabel="New route destination" value={effectiveNewRouteDestinationId} onChange={setNewRouteDestinationId} disabled={!newRouteDestinationIds.length} placeholder="Destination" options={newRouteDestinationIds.map((id) => ({ value: id, label: terminals.find((terminal) => terminal.id === id)?.name ?? 'Unknown' }))} />
                <button className="route-add-button" type="button" disabled={!canAddRoute} title={canAddRoute ? 'Save this route' : 'Pick a route that is not already saved'} onClick={addRoute}><Plus size={14} />Add route</button>
              </div>
              </>}
            </div>
            <div className="settings-section">
              <span className="node-type">Catch</span>
              <div className="settings-subgroup">
                <span className="settings-subhead">Padding</span>
                <div className="settings-grid">
                  <SettingField label="Traffic" ariaLabel="Catch traffic default" hint="Time to drive to the terminal" setting="catchTrafficMinutes" unit="min" settings={settings} onChange={changeSetting} />
                  <SettingField label="Queue" ariaLabel="Catch queue default" hint="Time waiting in the holding lane" setting="catchQueueMinutes" unit="min" settings={settings} onChange={changeSetting} />
                </div>
              </div>
              <div className="settings-subgroup">
                <span className="settings-subhead">Time left to leave</span>
                <div className="settings-grid">
                  <SettingField label="Turns yellow below" ariaLabel="Catch yellow under" hint="Minutes left to leave" setting="catchSoonMinutes" unit="min" settings={settings} onChange={changeSetting} />
                </div>
              </div>
              <div className="settings-subgroup">
                <span className="settings-subhead">Vehicle space</span>
                <div className="settings-grid">
                  <SettingField label="Turns yellow below" ariaLabel="Space yellow under" hint="Remaining capacity" setting="spaceSoonPercent" unit="%" settings={settings} onChange={changeSetting} />
                  <SettingField label="Turns red below" ariaLabel="Space red under" hint="Remaining capacity" setting="spaceImminentPercent" unit="%" settings={settings} onChange={changeSetting} />
                </div>
              </div>
            </div>
            <div className="settings-section">
              <span className="node-type">Disruption</span>
              <div className="settings-grid">
                <SettingField label="Lead" ariaLabel="Disruption lead" hint="Offload to traffic on the road" setting="disruptionLeadMinutes" unit="min" settings={settings} onChange={changeSetting} />
                <SettingField label="Lasts" ariaLabel="Disruption duration" hint="How long the traffic disrupts for" setting="disruptionDurationMinutes" unit="min" settings={settings} onChange={changeSetting} />
                <SettingField label="Turns yellow below" ariaLabel="Disruption yellow under" hint="Minutes until traffic hits" setting="disruptionSoonMinutes" unit="min" settings={settings} onChange={changeSetting} />
                <SettingField label="Turns red below" ariaLabel="Disruption red under" hint="Minutes until traffic hits" setting="disruptionImminentMinutes" unit="min" settings={settings} onChange={changeSetting} />
              </div>
            </div>
            <div className="settings-footer">
              <button type="button" className="reset-settings" onClick={resetSettings}>Reset to defaults</button>
            </div>
          </div>}

          </div>

          {(viewUpdating || retainedUpdateSkeleton) && <div className={`view-loading-cover${viewUpdating ? '' : ' is-exiting'}`}><ViewPlaceholder label="Loading updated ferry data" tab={tab} sailingsOnly={sailingsOnly} /></div>}
          </div>}
        </section>
      </main>
    </div>
  );
}