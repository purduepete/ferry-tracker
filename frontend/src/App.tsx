import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Anchor, ArrowLeftRight, ArrowRight, Clock3, Database, RefreshCw, Route, Ship, Terminal } from 'lucide-react';
import type { ApiEnvelope, SailingView, TerminalMateView, TerminalView, VesselView } from '@ferry-tracker/shared';
import { ferryApi } from './api';
import { FilterSelect } from './components/FilterSelect';
import { ThemeMenu } from './theme/ThemeMenu';

type Tab = 'relationship' | 'terminals' | 'vessels' | 'schedule' | 'raw';

const tabs: Array<{ id: Tab; label: string; icon: typeof Route }> = [
  { id: 'relationship', label: 'Relationship', icon: Route },
  { id: 'terminals', label: 'Terminals', icon: Terminal },
  { id: 'vessels', label: 'Vessels', icon: Ship },
  { id: 'schedule', label: 'Sailings', icon: Clock3 },
  { id: 'raw', label: 'Raw JSON', icon: Database },
];
const MINIMUM_SKELETON_MS = 500;
const SKELETON_EXIT_MS = 520;

function localTime(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Not reported';
}

function refreshTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function latestTimestamp(current: string | null, ...values: string[]) {
  return [current, ...values].filter((value): value is string => value !== null).sort().at(-1) ?? null;
}

function vehicleSpace(sailing: SailingView) {
  if (!sailing.spaceAvailable) return 'Not reported';
  const counts = spaceCounts(sailing);
  return sailing.maxSpaceCount === null ? counts : `${counts} of ${sailing.maxSpaceCount} spaces`;
}

function spaceCounts(space: Pick<SailingView, 'driveUpSpaceCount' | 'reservableSpaceCount'>) {
  const values: string[] = [];
  if (space.driveUpSpaceCount !== null) values.push(`${space.driveUpSpaceCount} drive-up`);
  if (space.reservableSpaceCount !== null) values.push(`${space.reservableSpaceCount} reservable`);
  return values.length ? values.join(', ') : 'Count hidden';
}

function Field({ label, value }: { label: string; value: unknown }) {
  return <div className="field"><dt>{label}</dt><dd>{value === null || value === undefined || value === '' ? <span className="null">Not reported</span> : String(value)}</dd></div>;
}

function ViewPlaceholder({ label, tab }: { label: string; tab: Tab }) {
  if (tab === 'terminals' || tab === 'vessels') {
    return <div className="view-placeholder" role="status" aria-label={label}><span className="sr-only">{label}</span><div className="data-grid placeholder-card-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <div className="data-card placeholder-node" key={index}><i /><i /><i /><i /></div>)}</div></div>;
  }
  if (tab === 'schedule' || tab === 'raw') {
    return <div className="view-placeholder" role="status" aria-label={label}><span className="sr-only">{label}</span><div className="wide-placeholder" aria-hidden="true"><i /><i /><i /><i /><i /></div></div>;
  }
  return <div className="view-placeholder" role="status" aria-label={label}><span className="sr-only">{label}</span><div className="relationship-grid placeholder-grid" aria-hidden="true"><div className="relationship-node placeholder-node"><i /><i /><i /><i /></div><div className="relationship-link" /><div className="relationship-node placeholder-node"><i /><i /><i /><i /><i /></div><div className="relationship-link" /><div className="relationship-node placeholder-node"><i /><i /><i /><i /><i /></div></div></div>;
}

export function App() {
  const [terminalResponse, setTerminalResponse] = useState<ApiEnvelope<TerminalView[]> | null>(null);
  const [vesselResponse, setVesselResponse] = useState<ApiEnvelope<VesselView[]> | null>(null);
  const [mateResponse, setMateResponse] = useState<ApiEnvelope<TerminalMateView[]> | null>(null);
  const [scheduleResponse, setScheduleResponse] = useState<ApiEnvelope<SailingView[]> | null>(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState<number | null>(null);
  const [destinationId, setDestinationId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('relationship');
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
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const overviewRequestId = useRef(0);
  const scheduleRequestId = useRef(0);

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
        setSelectedTerminalId((current) => current ?? terminals.data[0]?.id ?? null);
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
  const vessels = vesselResponse?.data ?? [];
  const selectedTerminal = terminals.find((terminal) => terminal.id === selectedTerminalId) ?? null;
  const associatedVessels = selectedTerminalId === null ? [] : vessels.filter((vessel) =>
    vessel.departingTerminalId === selectedTerminalId || vessel.arrivingTerminalId === selectedTerminalId,
  );
  const destinationIds = [...new Set((mateResponse?.data ?? [])
    .filter((mate) => mate.departingTerminalId === selectedTerminalId)
    .map((mate) => mate.arrivingTerminalId))];
  const effectiveDestinationId = destinationId !== null && destinationIds.includes(destinationId)
    ? destinationId
    : destinationIds[0] ?? null;
  const hasOverview = terminalResponse !== null && vesselResponse !== null && mateResponse !== null;

  useEffect(() => {
    if (selectedTerminalId === null || effectiveDestinationId === null) return;
    const controller = new AbortController();
    const requestId = ++scheduleRequestId.current;
    const startedAt = performance.now();
    let finishTimer: number | undefined;
    let active = true;
    setScheduleLoading(true);
    setError(null);
    ferryApi.schedule(selectedTerminalId, effectiveDestinationId, controller.signal)
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
  }, [effectiveDestinationId, refreshVersion, selectedTerminalId]);

  useEffect(() => {
    const routeSettled = selectedTerminalId === null || effectiveDestinationId === null || initialScheduleSettled;
    if (minimumInitialSkeletonElapsed && hasOverview && !loading && !scheduleLoading && routeSettled) setInitialDataVisible(true);
  }, [effectiveDestinationId, hasOverview, initialScheduleSettled, loading, minimumInitialSkeletonElapsed, scheduleLoading, selectedTerminalId]);

  useEffect(() => {
    if (!initialDataVisible) return;
    const timer = window.setTimeout(() => setInitialSkeletonVisible(false), SKELETON_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [initialDataVisible]);

  const destination = terminals.find((terminal) => terminal.id === effectiveDestinationId) ?? null;
  const raw = { terminals: terminalResponse?.raw, terminalMates: mateResponse?.raw, vessels: vesselResponse?.raw, schedule: scheduleResponse?.raw };
  const viewUpdating = loading || (scheduleLoading && (tab === 'relationship' || tab === 'schedule' || tab === 'raw'));
  const initialLoading = !initialDataVisible && (loading || hasOverview);

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
    loadOverview();
    setRefreshVersion((current) => current + 1);
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
          <button className="icon-button" type="button" title="Refresh data" aria-label="Refresh data" disabled={loading || scheduleLoading} onClick={refreshAll}><RefreshCw size={18} /></button>
          <ThemeMenu />
        </div>
        </div>
      </header>

      <main>
        <section className="selection-band" aria-labelledby="route-heading">
          <div className="route-title"><span className="eyebrow">Live route explorer</span><h1 id="route-heading">Trace the ferry data</h1></div>
          <div className="selectors">
            <label><span>Terminal</span><FilterSelect ariaLabel="Terminal" value={selectedTerminalId} onChange={setSelectedTerminalId} disabled={loading} options={terminals.map((terminal) => ({ value: terminal.id, label: `${terminal.name} · ${terminal.id}` }))} /></label>
            <button className="swap-button" type="button" aria-label="Reverse route" title={canSwapRoute ? 'Swap terminal and destination' : 'Reverse route unavailable'} disabled={!canSwapRoute} onClick={swapRoute}><ArrowLeftRight size={18} /></button>
            <label><span>Associated destination</span><FilterSelect ariaLabel="Associated destination" value={effectiveDestinationId} onChange={setDestinationId} disabled={!destinationIds.length} placeholder="No live association" options={destinationIds.map((id) => ({ value: id, label: `${terminals.find((terminal) => terminal.id === id)?.name ?? 'Unknown'} · ${id}` }))} /></label>
          </div>
        </section>

        {error && <div className="error-banner" role="alert">{error}</div>}
        <nav className="tabs" role="tablist" aria-label="Data views">
          {tabs.map(({ id, label, icon: Icon }, index) => <button ref={(element) => { tabRefs.current[index] = element; }} id={`tab-${id}`} aria-controls={`panel-${id}`} aria-selected={tab === id} role="tab" tabIndex={tab === id ? 0 : -1} key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)} onKeyDown={(event) => handleTabKeyDown(event, index)}><Icon size={16} />{label}</button>)}
        </nav>

        <section className="view" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} aria-live="polite" aria-busy={initialLoading || viewUpdating}>
          {(initialLoading || (initialDataVisible && initialSkeletonVisible)) && <div className={`initial-loading-cover${initialDataVisible ? ' is-exiting' : ''}`}><ViewPlaceholder label="Loading ferry data" tab={tab} /></div>}
          {!initialDataVisible && !initialLoading && <div className="state">Ferry data is unavailable.</div>}

          {initialDataVisible && <div className={`view-content${viewUpdating ? ' is-updating' : ''}`}>
          {tab === 'relationship' && <div className="relationship-grid">
            <article className="relationship-node terminal-node"><span className="node-type">Terminal</span><h2>{selectedTerminal?.name ?? 'No terminal'}</h2><code>TerminalID {selectedTerminalId ?? '—'}</code><Field label="City" value={selectedTerminal?.city} /><Field label="Coordinates" value={selectedTerminal ? `${selectedTerminal.latitude}, ${selectedTerminal.longitude}` : null} /></article>
            <div className="relationship-link"><span>{associatedVessels.length} associated</span><ArrowRight /></div>
            <div className="vessel-stack">{associatedVessels.length ? associatedVessels.map((vessel) => <article className="relationship-node vessel-node" key={vessel.id}><span className="node-type">Vessel</span><h2>{vessel.name}</h2><code>VesselID {vessel.id}</code><p>{vessel.departingTerminalName} <ArrowRight size={14} /> {vessel.arrivingTerminalName}</p><Field label="Class" value={vessel.vesselClass} /><Field label="Left dock" value={localTime(vessel.leftDock)} /><Field label="ETA" value={localTime(vessel.eta)} /><Field label="ETA basis" value={vessel.etaBasis} /><Field label="Speed" value={vessel.speed === null ? null : `${vessel.speed} knots`} /></article>) : <div className="empty">No vessel currently references this terminal.</div>}</div>
            <div className="relationship-link"><span>{scheduleResponse?.data.length ?? 0} sailings</span><ArrowRight /></div>
            <article className="relationship-node schedule-node">
              <span className="node-type">Sailings &amp; vehicle space</span>
              <h2>{selectedTerminal?.name ?? '—'} to {destination?.name ?? '—'}</h2>
              <p className="window-label">Past 2 hours · Next 12 hours</p>
              {scheduleResponse?.data.length ? <ol className="sailing-list">{scheduleResponse.data.map((sailing, index) => <li key={`${sailing.departingTime}-${index}`}><strong>{localTime(sailing.departingTime)}</strong><span>{sailing.vesselName ?? 'Vessel unassigned'} {sailing.vesselId ? `· ${sailing.vesselId}` : ''}</span><span className="space-count">Vehicle space: {vehicleSpace(sailing)}</span></li>)}</ol> : scheduleLoading ? <div className="sailing-placeholder" aria-hidden="true"><i /><i /><i /></div> : <div className="empty">No sailings in this 14-hour window.</div>}
            </article>
          </div>}

          {tab === 'terminals' && <div className="data-grid">{terminals.map((terminal) => <article className="data-card" key={terminal.id}><h2>{terminal.name}</h2><code>TerminalID {terminal.id}</code><dl><Field label="Subject" value={terminal.subjectName} /><Field label="City" value={terminal.city} /><Field label="Latitude" value={terminal.latitude} /><Field label="Longitude" value={terminal.longitude} /></dl></article>)}</div>}

          {tab === 'vessels' && <div className="data-grid">{vessels.map((vessel) => <article className="data-card" key={vessel.id}><h2>{vessel.name}</h2><code>VesselID {vessel.id}</code><dl><Field label="Class" value={vessel.vesselClass} /><Field label="Direction" value={`${vessel.departingTerminalName ?? '?'} → ${vessel.arrivingTerminalName ?? '?'}`} /><Field label="Terminal IDs" value={`${vessel.departingTerminalId ?? '?'} → ${vessel.arrivingTerminalId ?? '?'}`} /><Field label="In service" value={vessel.inService} /><Field label="At dock" value={vessel.atDock} /><Field label="Left dock" value={localTime(vessel.leftDock)} /><Field label="ETA" value={localTime(vessel.eta)} /><Field label="ETA basis" value={vessel.etaBasis} /><Field label="Updated" value={localTime(vessel.updatedAt)} /></dl></article>)}</div>}

          {tab === 'schedule' && <div className="schedule-card"><div className="schedule-heading"><span className="node-type">Sailings &amp; vehicle space</span><h2>Past 2 hours · Next 12 hours</h2></div><div className="table-wrap"><table><thead><tr><th>Departure</th><th>Arrival</th><th>Vessel</th><th>Vehicle space</th><th>Terminal IDs</th></tr></thead><tbody>{scheduleResponse?.data.map((sailing, index) => <tr key={`${sailing.departingTime}-${index}`}><td>{localTime(sailing.departingTime)}</td><td>{localTime(sailing.arrivingTime)}</td><td>{sailing.vesselName ?? <span className="null">null</span>}<small>{sailing.vesselId ? `ID ${sailing.vesselId}` : ''}</small></td><td>{vehicleSpace(sailing)}</td><td>{sailing.departingTerminalId} → {sailing.arrivingTerminalId}</td></tr>)}</tbody></table>{!scheduleLoading && !scheduleResponse?.data.length && <div className="empty">No sailings in this 14-hour window.</div>}</div></div>}

          {tab === 'raw' && <div className="raw-panel"><div className="raw-heading"><div><span className="node-type">Unmodified source shape</span><h2>WSDOT response JSON</h2></div><span>Secrets removed server-side</span></div><pre>{JSON.stringify(raw, null, 2)}</pre></div>}
          {(viewUpdating || retainedUpdateSkeleton) && <div className={`view-loading-cover${viewUpdating ? '' : ' is-exiting'}`}><ViewPlaceholder label="Loading updated ferry data" tab={tab} /></div>}
          </div>}
        </section>
      </main>
    </div>
  );
}