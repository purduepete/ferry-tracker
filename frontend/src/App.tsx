import { useEffect, useState } from 'react';
import { Anchor, ArrowRight, Clock3, Database, RefreshCw, Route, Ship, Terminal } from 'lucide-react';
import type { ApiEnvelope, SailingSpaceView, SailingView, TerminalMateView, TerminalView, VesselView } from '@ferry-tracker/shared';
import { ferryApi } from './api';
import { ThemeMenu } from './theme/ThemeMenu';

type Tab = 'relationship' | 'terminals' | 'vessels' | 'schedule' | 'raw';

const tabs: Array<{ id: Tab; label: string; icon: typeof Route }> = [
  { id: 'relationship', label: 'Relationship', icon: Route },
  { id: 'terminals', label: 'Terminals', icon: Terminal },
  { id: 'vessels', label: 'Vessels', icon: Ship },
  { id: 'schedule', label: 'Schedule', icon: Clock3 },
  { id: 'raw', label: 'Raw JSON', icon: Database },
];

function localTime(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Not reported';
}

function vehicleSpace(sailing: SailingView) {
  if (!sailing.spaceAvailable) return 'Not reported';
  return spaceCounts(sailing);
}

function spaceCounts(space: Pick<SailingSpaceView, 'driveUpSpaceCount' | 'reservableSpaceCount'>) {
  const values: string[] = [];
  if (space.driveUpSpaceCount !== null) values.push(`${space.driveUpSpaceCount} drive-up`);
  if (space.reservableSpaceCount !== null) values.push(`${space.reservableSpaceCount} reservable`);
  return values.length ? values.join(', ') : 'Count hidden';
}

function Field({ label, value }: { label: string; value: unknown }) {
  return <div className="field"><dt>{label}</dt><dd>{value === null || value === undefined || value === '' ? <span className="null">Not reported</span> : String(value)}</dd></div>;
}

export function App() {
  const [terminalResponse, setTerminalResponse] = useState<ApiEnvelope<TerminalView[]> | null>(null);
  const [vesselResponse, setVesselResponse] = useState<ApiEnvelope<VesselView[]> | null>(null);
  const [mateResponse, setMateResponse] = useState<ApiEnvelope<TerminalMateView[]> | null>(null);
  const [scheduleResponse, setScheduleResponse] = useState<ApiEnvelope<SailingView[]> | null>(null);
  const [spaceResponse, setSpaceResponse] = useState<ApiEnvelope<SailingSpaceView[]> | null>(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState<number | null>(null);
  const [destinationId, setDestinationId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('relationship');
  const [loading, setLoading] = useState(true);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = () => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([ferryApi.terminals(controller.signal), ferryApi.vessels(controller.signal), ferryApi.terminalMates(controller.signal)])
      .then(([terminals, vessels, mates]) => {
        setTerminalResponse(terminals);
        setVesselResponse(vessels);
        setMateResponse(mates);
        setSelectedTerminalId((current) => current ?? terminals.data[0]?.id ?? null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load ferry data.'))
      .finally(() => setLoading(false));
    return controller;
  };

  useEffect(() => {
    const controller = loadOverview();
    return () => controller.abort();
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

  useEffect(() => {
    if (selectedTerminalId === null || effectiveDestinationId === null) return;
    const controller = new AbortController();
    setScheduleLoading(true);
    setScheduleResponse(null);
    setSpaceResponse(null);
    setError(null);
    Promise.all([
      ferryApi.schedule(selectedTerminalId, effectiveDestinationId, controller.signal),
      ferryApi.sailingSpaces(selectedTerminalId, effectiveDestinationId, controller.signal),
    ])
      .then(([schedule, spaces]) => {
        setScheduleResponse(schedule);
        setSpaceResponse(spaces);
      })
      .catch((cause: unknown) => {
        if ((cause as Error).name !== 'AbortError') setError(cause instanceof Error ? cause.message : 'Unable to load schedule.');
      })
      .finally(() => setScheduleLoading(false));
    return () => controller.abort();
  }, [effectiveDestinationId, selectedTerminalId]);

  const destination = terminals.find((terminal) => terminal.id === effectiveDestinationId) ?? null;
  const raw = { terminals: terminalResponse?.raw, terminalMates: mateResponse?.raw, vessels: vesselResponse?.raw, schedule: scheduleResponse?.raw, sailingSpaces: spaceResponse?.raw };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><Anchor size={24} /><div><strong>Ferry Tracker</strong><span>WSDOT data explorer</span></div></div>
        <div className="header-actions">
          {terminalResponse && <span className={`source-badge ${terminalResponse.source}`}>{terminalResponse.source}</span>}
          <button className="icon-button" type="button" title="Refresh data" aria-label="Refresh data" onClick={loadOverview}><RefreshCw size={18} /></button>
          <ThemeMenu />
        </div>
      </header>

      <main>
        <section className="selection-band" aria-labelledby="route-heading">
          <div><span className="eyebrow">Phase 0</span><h1 id="route-heading">Trace the ferry data</h1></div>
          <div className="selectors">
            <label><span>Terminal</span><select value={selectedTerminalId ?? ''} onChange={(event) => setSelectedTerminalId(Number(event.target.value))} disabled={loading}>
              {terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.name} · {terminal.id}</option>)}
            </select></label>
            <ArrowRight className="selector-arrow" size={20} />
            <label><span>Associated destination</span><select value={effectiveDestinationId ?? ''} onChange={(event) => setDestinationId(Number(event.target.value))} disabled={!destinationIds.length}>
              {!destinationIds.length && <option value="">No live association</option>}
              {destinationIds.map((id) => <option key={id} value={id}>{terminals.find((terminal) => terminal.id === id)?.name ?? 'Unknown'} · {id}</option>)}
            </select></label>
          </div>
        </section>

        {error && <div className="error-banner" role="alert">{error}</div>}
        <nav className="tabs" aria-label="Data views">
          {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}
        </nav>

        <section className="view" aria-live="polite">
          {loading ? <div className="state"><RefreshCw className="spin" />Loading WSDOT data…</div> : null}

          {!loading && tab === 'relationship' && <div className="relationship-grid">
            <article className="relationship-node terminal-node"><span className="node-type">Terminal</span><h2>{selectedTerminal?.name ?? 'No terminal'}</h2><code>TerminalID {selectedTerminalId ?? '—'}</code><Field label="City" value={selectedTerminal?.city} /><Field label="Coordinates" value={selectedTerminal ? `${selectedTerminal.latitude}, ${selectedTerminal.longitude}` : null} /></article>
            <div className="relationship-link"><span>{associatedVessels.length} associated</span><ArrowRight /></div>
            <div className="vessel-stack">{associatedVessels.length ? associatedVessels.map((vessel) => <article className="relationship-node vessel-node" key={vessel.id}><span className="node-type">Vessel</span><h2>{vessel.name}</h2><code>VesselID {vessel.id}</code><p>{vessel.departingTerminalName} <ArrowRight size={14} /> {vessel.arrivingTerminalName}</p><Field label="Class" value={vessel.vesselClass} /><Field label="Left dock" value={localTime(vessel.leftDock)} /><Field label="ETA" value={localTime(vessel.eta)} /><Field label="ETA basis" value={vessel.etaBasis} /><Field label="Speed" value={vessel.speed === null ? null : `${vessel.speed} knots`} /></article>) : <div className="empty">No vessel currently references this terminal.</div>}</div>
            <div className="relationship-link"><span>{scheduleResponse?.data.length ?? 0} sailings</span><ArrowRight /></div>
            <article className="relationship-node schedule-node">
              <span className="node-type">Today's full schedule</span>
              <h2>{selectedTerminal?.name ?? '—'} to {destination?.name ?? '—'}</h2>
              {scheduleLoading ? <p>Loading schedule…</p> : scheduleResponse?.data.length ? <ol className="sailing-list">{scheduleResponse.data.map((sailing, index) => <li key={`${sailing.departingTime}-${index}`}><strong>{localTime(sailing.departingTime)}</strong><span>{sailing.vesselName ?? 'Vessel unassigned'} {sailing.vesselId ? `· ${sailing.vesselId}` : ''}</span><span className="space-count">Vehicle space: {vehicleSpace(sailing)}</span></li>)}</ol> : <div className="empty">No sailings returned for this direction today.</div>}
              {!!spaceResponse?.data.length && <div className="space-reports"><span className="node-type">Current vehicle-space reports</span>{spaceResponse.data.map((space) => <div className="space-report" key={`${space.vesselId}-${space.departure}`}><strong>{localTime(space.departure)}</strong><span>{space.vesselName}</span><span>{spaceCounts(space)} of {space.maxSpaceCount ?? 'unknown'} spaces</span></div>)}</div>}
            </article>
          </div>}

          {!loading && tab === 'terminals' && <div className="data-grid">{terminals.map((terminal) => <article className="data-card" key={terminal.id}><h2>{terminal.name}</h2><code>TerminalID {terminal.id}</code><dl><Field label="Subject" value={terminal.subjectName} /><Field label="City" value={terminal.city} /><Field label="Latitude" value={terminal.latitude} /><Field label="Longitude" value={terminal.longitude} /></dl></article>)}</div>}

          {!loading && tab === 'vessels' && <div className="data-grid">{vessels.map((vessel) => <article className="data-card" key={vessel.id}><h2>{vessel.name}</h2><code>VesselID {vessel.id}</code><dl><Field label="Class" value={vessel.vesselClass} /><Field label="Direction" value={`${vessel.departingTerminalName ?? '?'} → ${vessel.arrivingTerminalName ?? '?'}`} /><Field label="Terminal IDs" value={`${vessel.departingTerminalId ?? '?'} → ${vessel.arrivingTerminalId ?? '?'}`} /><Field label="In service" value={vessel.inService} /><Field label="At dock" value={vessel.atDock} /><Field label="Left dock" value={localTime(vessel.leftDock)} /><Field label="ETA" value={localTime(vessel.eta)} /><Field label="ETA basis" value={vessel.etaBasis} /><Field label="Updated" value={localTime(vessel.updatedAt)} /></dl></article>)}</div>}

          {!loading && tab === 'schedule' && <div className="schedule-view"><div className="table-wrap"><table><thead><tr><th>Departure</th><th>Arrival</th><th>Vessel</th><th>Vehicle space</th><th>Capacity</th><th>Terminal IDs</th></tr></thead><tbody>{scheduleResponse?.data.map((sailing, index) => <tr key={`${sailing.departingTime}-${index}`}><td>{localTime(sailing.departingTime)}</td><td>{localTime(sailing.arrivingTime)}</td><td>{sailing.vesselName ?? <span className="null">null</span>}<small>{sailing.vesselId ? `ID ${sailing.vesselId}` : ''}</small></td><td>{vehicleSpace(sailing)}</td><td>{sailing.maxSpaceCount ?? 'Not reported'}</td><td>{sailing.departingTerminalId} → {sailing.arrivingTerminalId}</td></tr>)}</tbody></table>{!scheduleLoading && !scheduleResponse?.data.length && <div className="empty">No schedule records returned.</div>}</div>{!!spaceResponse?.data.length && <div className="availability-band"><div><span className="node-type">Current WSDOT vehicle-space reports</span><h2>Upcoming departures</h2></div>{spaceResponse.data.map((space) => <div className="availability-row" key={`${space.vesselId}-${space.departure}`}><strong>{localTime(space.departure)}</strong><span>{space.vesselName}</span><span>{spaceCounts(space)}</span><span>Capacity {space.maxSpaceCount ?? 'unknown'}</span></div>)}</div>}</div>}

          {!loading && tab === 'raw' && <div className="raw-panel"><div className="raw-heading"><div><span className="node-type">Unmodified source shape</span><h2>WSDOT response JSON</h2></div><span>Secrets removed server-side</span></div><pre>{JSON.stringify(raw, null, 2)}</pre></div>}
        </section>
      </main>
    </div>
  );
}