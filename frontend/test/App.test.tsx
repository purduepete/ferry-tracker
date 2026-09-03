// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { App, capacityLevel, departureDelayLabel, departureDelayMinutes, openSpacePercent, recordedSpaceLabel, sailingArrival, sailingTimeMinutes, serviceDayLabel, vesselDelayMinutes, vesselEta, vesselRouteRank } from '../src/App';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const terminals = [
  { id: 7, name: 'Seattle', subjectName: 'seattle', latitude: 47.6, longitude: -122.3, city: 'Seattle', raw: [] },
  { id: 3, name: 'Bainbridge Island', subjectName: 'bainbridge', latitude: 47.62, longitude: -122.5, city: 'Bainbridge Island', raw: [] },
];
const vessels = [{
  id: 1, name: 'Tacoma', vesselClass: 'Jumbo Mark II', departingTerminalId: 7, arrivingTerminalId: 3,
  departingTerminalName: 'Seattle', arrivingTerminalName: 'Bainbridge Island', latitude: 47.61, longitude: -122.4,
  speed: 15, heading: 278, inService: true, atDock: false, scheduledDeparture: null, updatedAt: '2026-09-01T16:30:00.000Z', raw: [],
}];

function json(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, fetchedAt: '2026-09-01T16:00:00.000Z', source: 'fixture', raw: data })));
}

describe('Ferry data explorer', () => {
  it('traces a terminal to its vessel and schedule', async () => {
    let scheduleCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
        { departingTerminalId: 3, departingTerminalName: 'Bainbridge Island', arrivingTerminalId: 7, arrivingTerminalName: 'Seattle' },
      ]);
      if (url.includes('/api/history')) return json([]);
      scheduleCalls += 1;
      return json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
  expect(screen.getByRole('status', { name: 'Loading ferry data' })).toBeInTheDocument();
  expect(document.querySelector('.spin')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Seattle' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tacoma' })).toBeInTheDocument();
    expect(screen.getByText(/Seattle to Bainbridge Island/)).toBeInTheDocument();
    expect(screen.getByText(new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date('2026-09-01T16:30:00.000Z')))).toBeInTheDocument();
    expect(screen.queryByText(/TerminalID|VesselID/)).not.toBeInTheDocument();
    expect(await screen.findByText(/176 drive-up \/ 202/)).toBeInTheDocument();
    expect(screen.queryByText('Current vehicle-space reports')).not.toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-09-01T16:00:00.000Z"]')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Reverse route' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Terminal' })).toHaveTextContent('Bainbridge Island'));
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Seattle');
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false'));

    const callsBeforeRefresh = scheduleCalls;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh data' }));
    await waitFor(() => expect(scheduleCalls).toBeGreaterThan(callsBeforeRefresh));

    await userEvent.click(screen.getByRole('tab', { name: 'Sailings' }));
    expect(screen.queryByRole('tab', { name: 'Raw JSON' })).not.toBeInTheDocument();
  });

  it('keeps the current view on screen while a manual refresh runs', async () => {
    let terminalCalls = 0;
    let releaseRefresh: () => void = () => {};
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) {
        terminalCalls += 1;
        return terminalCalls > 1 ? refreshGate.then(() => json(terminals)) : json(terminals);
      }
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    expect(await screen.findByRole('heading', { name: 'Tacoma' })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.view-loading-cover')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Refresh data' }));
    expect(screen.getByRole('heading', { name: 'Tacoma' })).toBeInTheDocument();
    expect(document.querySelector('.view-loading-cover')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh data' })).toHaveClass('is-busy');

    releaseRefresh();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh data' })).not.toHaveClass('is-busy'));
  });

  it('moves and selects tabs with arrow keys', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([]);
    });

    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    const routes = await screen.findByRole('tab', { name: 'Routes' });
    routes.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Terminals' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Terminals' })).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Sailings' })).toHaveFocus();
  });

  it('sorts persisted favorites alphabetically above other terminals', async () => {
    const favoriteTerminals = [
      terminals[0],
      terminals[1],
      { id: 1, name: 'Anacortes', subjectName: 'anacortes', latitude: 48.5, longitude: -122.6, city: 'Anacortes', raw: [] },
    ];
    localStorage.setItem('ferry-tracker-favorite-terminals', JSON.stringify([7, 1, 999]));
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(favoriteTerminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
        { departingTerminalId: 3, departingTerminalName: 'Bainbridge Island', arrivingTerminalId: 7, arrivingTerminalName: 'Seattle' },
      ]);
      if (url.includes('/api/history')) return json([]);
      return json([]);
    });

    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    const terminalTrigger = await screen.findByRole('button', { name: 'Terminal' });
    await user.click(terminalTrigger);
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-label') ?? option.textContent?.trim())).toEqual([
      'Anacortes',
      'Seattle',
      'Bainbridge Island',
    ]);

    await user.click(screen.getByRole('option', { name: 'Bainbridge Island' }));
    await user.click(screen.getByRole('button', { name: 'Add Bainbridge Island to favorites' }));
    expect(JSON.parse(localStorage.getItem('ferry-tracker-favorite-terminals') ?? '[]')).toEqual([7, 1, 999, 3]);
    await user.click(terminalTrigger);
    expect(screen.getAllByRole('option').map((option) => option.textContent?.trim())).toEqual([
      'Anacortes',
      'Bainbridge Island',
      'Seattle',
    ]);
  });

  it('covers retained sailing content with a skeleton while a changed route loads', async () => {
    let scheduleCalls = 0;
    let resolveChangedRoute!: (response: Response) => void;
    const changedRouteResponse = new Promise<Response>((resolve) => { resolveChangedRoute = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
        { departingTerminalId: 3, departingTerminalName: 'Bainbridge Island', arrivingTerminalId: 7, arrivingTerminalName: 'Seattle' },
      ]);
      if (url.includes('/api/history')) return json([]);
      scheduleCalls += 1;
      if (scheduleCalls > 1) return changedRouteResponse;
      return json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    expect(await screen.findByText(/176 drive-up \/ 202/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reverse route' }));

    expect(screen.getByText(/176 drive-up \/ 202/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading updated ferry data' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'true');

    resolveChangedRoute(await json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T18:00:00.000Z', arrivingTime: '2026-09-01T18:35:00.000Z', departingTerminalId: 3, arrivingTerminalId: 7, isCancelled: false, driveUpSpaceCount: 95, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]));
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByText(/95 drive-up \/ 202/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading updated ferry data' })).not.toBeInTheDocument());
  });

  it('marks a vessel destination WSDOT has not published yet', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json([{ ...vessels[0], arrivingTerminalId: null, arrivingTerminalName: null }]);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
      ]);
      return json([]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Tacoma' });

    const direction = screen.getByRole('heading', { name: 'Tacoma' }).nextElementSibling;
    expect(direction?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Seattle —');
  });
});

describe('Remembered route', () => {
  function mockRoute() {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
        { departingTerminalId: 3, departingTerminalName: 'Bainbridge Island', arrivingTerminalId: 7, arrivingTerminalName: 'Seattle' },
      ]);
      if (url.includes('/api/history')) return json([]);
      return json([]);
    });
  }

  it('opens on the stored terminal and destination instead of the first terminal', async () => {
    localStorage.setItem('ferry-tracker-last-route', JSON.stringify({ terminalId: 3, destinationId: 7 }));
    mockRoute();

    render(<ThemeProvider><App /></ThemeProvider>);
    expect(await screen.findByRole('heading', { name: 'Bainbridge Island' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Terminal' })).toHaveTextContent('Bainbridge Island');
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Seattle');
  });

  it('stores the route whenever the selection changes', async () => {
    mockRoute();

    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('ferry-tracker-last-route') ?? 'null')).toEqual({ terminalId: 7, destinationId: 3 }));

    await user.click(screen.getByRole('button', { name: 'Reverse route' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('ferry-tracker-last-route') ?? 'null')).toEqual({ terminalId: 3, destinationId: 7 }));
  });

  it('falls back to the first terminal when the stored one is gone', async () => {
    localStorage.setItem('ferry-tracker-last-route', JSON.stringify({ terminalId: 999, destinationId: 998 }));
    mockRoute();

    render(<ThemeProvider><App /></ThemeProvider>);
    expect(await screen.findByRole('heading', { name: 'Seattle' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Bainbridge Island');
  });

  it('ignores a corrupt stored route', async () => {
    localStorage.setItem('ferry-tracker-last-route', '{not json');
    mockRoute();

    render(<ThemeProvider><App /></ThemeProvider>);
    expect(await screen.findByRole('heading', { name: 'Seattle' })).toBeInTheDocument();
  });
});

describe('Sailings only', () => {
  function mockRoute() {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
      ]);
      return json([]);
    });
  }

  it('collapses the routes grid to the schedule and stores the choice', async () => {
    mockRoute();

    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    const toggle = screen.getByRole('button', { name: 'Sailings only' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.relationship-grid')).not.toHaveClass('is-sailings-only');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.relationship-grid')).toHaveClass('is-sailings-only');
    expect(document.querySelector('.selection-band')).toHaveClass('is-sailings-only');
    expect(localStorage.getItem('ferry-tracker-sailings-only')).toBe('true');

    await user.click(toggle);
    expect(document.querySelector('.relationship-grid')).not.toHaveClass('is-sailings-only');
    expect(document.querySelector('.selection-band')).not.toHaveClass('is-sailings-only');
    expect(localStorage.getItem('ferry-tracker-sailings-only')).toBe('false');
  });

  it('reopens collapsed when the choice was stored', async () => {
    localStorage.setItem('ferry-tracker-sailings-only', 'true');
    mockRoute();

    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    expect(screen.getByRole('button', { name: 'Sailings only' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.relationship-grid')).toHaveClass('is-sailings-only');
  });

  it('leaves the other tabs alone', async () => {
    localStorage.setItem('ferry-tracker-sailings-only', 'true');
    mockRoute();

    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await user.click(screen.getByRole('tab', { name: 'Terminals' }));
    expect(screen.queryByRole('button', { name: 'Sailings only' })).not.toBeInTheDocument();
    expect(document.querySelector('.selection-band')).not.toHaveClass('is-sailings-only');
  });
});

describe('Capacity pill', () => {
  const sailing = { spaceAvailable: true, maxSpaceCount: 200, driveUpSpaceCount: null, reservableSpaceCount: null };

  it('returns null when the percentage cannot be derived', () => {
    expect(openSpacePercent(sailing)).toBeNull();
    expect(openSpacePercent({ ...sailing, driveUpSpaceCount: 50, spaceAvailable: false })).toBeNull();
    expect(openSpacePercent({ ...sailing, driveUpSpaceCount: 50, maxSpaceCount: null })).toBeNull();
  });

  it('sums drive-up and reservable against the whole boat', () => {
    expect(openSpacePercent({ ...sailing, driveUpSpaceCount: 60, reservableSpaceCount: 40 })).toBe(50);
    expect(openSpacePercent({ ...sailing, driveUpSpaceCount: 96, reservableSpaceCount: null })).toBe(48);
    expect(openSpacePercent({ ...sailing, driveUpSpaceCount: 0, reservableSpaceCount: 0 })).toBe(0);
    expect(openSpacePercent({ ...sailing, driveUpSpaceCount: 500, reservableSpaceCount: null })).toBe(100);
  });

  it('picks the level at each threshold boundary', () => {
    expect(capacityLevel(0)).toBe('full');
    expect(capacityLevel(10)).toBe('full');
    expect(capacityLevel(11)).toBe('tight');
    expect(capacityLevel(30)).toBe('tight');
    expect(capacityLevel(31)).toBe('open');
    expect(capacityLevel(99)).toBe('open');
  });

  it('renders a labelled pill and hides it at full availability', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([
        { vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 40, reservableSpaceCount: null, maxSpaceCount: 200, spaceAvailable: true, raw: {} },
        { vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T18:00:00.000Z', arrivingTime: '2026-09-01T18:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 200, reservableSpaceCount: null, maxSpaceCount: 200, spaceAvailable: true, raw: {} },
      ]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    const pills = await screen.findAllByLabelText('20% of 200 vehicle spaces open');
    expect(pills[0]).toHaveClass('capacity-pill', 'tight');
    expect(screen.queryByLabelText('100% of 200 vehicle spaces open')).not.toBeInTheDocument();
  });
});

describe('Recorded vehicle space', () => {
  const observedAt = '2026-09-01T17:57:00.000Z';
  const at = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(observedAt));

  it('says nothing for live or absent space', () => {
    expect(recordedSpaceLabel({ spaceSource: 'live', spaceObservedAt: null, spaceLeadSeconds: null })).toBeNull();
    expect(recordedSpaceLabel({ spaceSource: null, spaceObservedAt: null, spaceLeadSeconds: null })).toBeNull();
    expect(recordedSpaceLabel({ spaceSource: 'recorded', spaceObservedAt: null, spaceLeadSeconds: 60 })).toBeNull();
  });

  it('reports lead time in seconds under 90 and minutes above it', () => {
    expect(recordedSpaceLabel({ spaceSource: 'recorded', spaceObservedAt: observedAt, spaceLeadSeconds: 45 }))
      .toBe(`Last recorded at ${at}, 45 sec before departure`);
    expect(recordedSpaceLabel({ spaceSource: 'recorded', spaceObservedAt: observedAt, spaceLeadSeconds: 180 }))
      .toBe(`Last recorded at ${at}, 3 min before departure`);
    expect(recordedSpaceLabel({ spaceSource: 'recorded', spaceObservedAt: observedAt, spaceLeadSeconds: null }))
      .toBe(`Last recorded at ${at}`);
  });

  it('marks a backfilled sailing and leaves a live one plain', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([
        { vesselId: 1, vesselName: 'Wenatchee', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 9, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, spaceSource: 'recorded', spaceObservedAt: observedAt, spaceLeadSeconds: 180, raw: {} },
        { vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T18:00:00.000Z', arrivingTime: '2026-09-01T18:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 40, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, spaceSource: 'live', spaceObservedAt: null, spaceLeadSeconds: null, raw: {} },
      ]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    const marks = await screen.findAllByLabelText(`Last recorded at ${at}, 3 min before departure`);
    expect(marks[0]).toHaveClass('recorded-mark');
    expect(document.querySelectorAll('.space-count.is-recorded')).toHaveLength(1);
    expect(await screen.findByText(/40 drive-up \/ 202/)).toBeInTheDocument();
  });
});

describe('Departure delay', () => {
  const left = '2026-09-01T17:06:00.000Z';
  const at = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(left));

  it('says nothing until the boat has actually left', () => {
    expect(departureDelayLabel({ actualDeparture: null })).toBeNull();
    expect(departureDelayMinutes({ actualDeparture: null, departureDelayMinutes: 6 })).toBeNull();
  });

  it('names the departure without grading it', () => {
    expect(departureDelayLabel({ actualDeparture: left })).toBe(`Left ${at}`);
  });

  it('pills a delay of two whole minutes or more', () => {
    expect(departureDelayMinutes({ actualDeparture: left, departureDelayMinutes: 6 })).toBe(6);
    expect(departureDelayMinutes({ actualDeparture: left, departureDelayMinutes: 2.9 })).toBe(2);
    expect(departureDelayMinutes({ actualDeparture: left, departureDelayMinutes: 1.9 })).toBeNull();
    expect(departureDelayMinutes({ actualDeparture: left, departureDelayMinutes: null })).toBeNull();
  });

  it('never claims a boat left early', () => {
    expect(departureDelayMinutes({ actualDeparture: left, departureDelayMinutes: -9 })).toBeNull();
  });

  it('renders the delay beside the sailing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 40, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, spaceSource: 'live', spaceObservedAt: null, spaceLeadSeconds: null, actualDeparture: left, departureDelayMinutes: 6, raw: {} }]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    const pill = await screen.findByTitle('Left 6 minutes after the scheduled departure');
    expect(pill).toHaveTextContent('6 min');
    expect(pill.parentElement).toHaveClass('departure-delay');
    expect(pill.parentElement?.textContent).toBe(`Left ${at}6 min`);
  });

  it('stays quiet about a sailing that left on time', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 40, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, spaceSource: 'live', spaceObservedAt: null, spaceLeadSeconds: null, actualDeparture: left, departureDelayMinutes: 0.4, raw: {} }]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    expect(await screen.findByText(/40 drive-up/)).toBeInTheDocument();
    expect(screen.queryByText(`Left ${at}`)).not.toBeInTheDocument();
    expect(document.querySelector('.departure-delay')).toBeNull();
  });
});

describe('Unreported vehicle space', () => {
  it('drops the whole line when the boat reports no space', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([
        { vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 40, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, spaceSource: 'live', spaceObservedAt: null, spaceLeadSeconds: null, raw: {} },
        { vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-02T04:00:00.000Z', arrivingTime: '2026-09-02T04:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: null, reservableSpaceCount: null, maxSpaceCount: null, spaceAvailable: false, spaceSource: 'live', spaceObservedAt: null, spaceLeadSeconds: null, raw: {} },
      ]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    expect(await screen.findByText(/40 drive-up/)).toBeInTheDocument();
    expect(document.querySelectorAll('.sailing-list li')).toHaveLength(2);
    expect(document.querySelectorAll('.sailing-list .space-count')).toHaveLength(1);
  });
});

describe('Card navigation', () => {
  const returning = {
    ...vessels[0], id: 2, name: 'Wenatchee', departingTerminalId: 3, arrivingTerminalId: 7,
    departingTerminalName: 'Bainbridge Island', arrivingTerminalName: 'Seattle',
  };

  function mockOverview() {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json([...vessels, returning]);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
        { departingTerminalId: 3, departingTerminalName: 'Bainbridge Island', arrivingTerminalId: 7, arrivingTerminalName: 'Seattle' },
      ]);
      if (url.includes('/api/history')) return json([]);
      return json([]);
    });
  }

  it('opens the routes view on the terminal that was clicked', async () => {
    mockOverview();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await userEvent.click(screen.getByRole('tab', { name: 'Terminals' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Bainbridge Island' }));

    expect(screen.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Terminal' })).toHaveTextContent('Bainbridge Island'));
  });

  it('opens the routes view on the route the clicked vessel is running', async () => {
    mockOverview();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await userEvent.click(screen.getByRole('tab', { name: 'Vessels' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Wenatchee' }));

    expect(screen.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Terminal' })).toHaveTextContent('Bainbridge Island'));
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Seattle');
  });

  it('opens the routes view from a vessel in the sailings table', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json([...vessels, returning]);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
        { departingTerminalId: 3, departingTerminalName: 'Bainbridge Island', arrivingTerminalId: 7, arrivingTerminalName: 'Seattle' },
      ]);
      if (url.includes('/api/history')) return json([]);
      return json([{ vesselId: 2, vesselName: 'Wenatchee', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, spaceSource: 'live', spaceObservedAt: null, spaceLeadSeconds: null, actualDeparture: null, departureDelayMinutes: null, raw: {} }]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await userEvent.click(screen.getByRole('tab', { name: 'Sailings' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Wenatchee' }));

    expect(screen.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Terminal' })).toHaveTextContent('Bainbridge Island'));
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Seattle');
  });
});

describe('Recorded day browser', () => {
  function mockDay(dates: string[]) {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history/dates')) return json(dates);
      if (url.includes('/api/history/sailings')) return json([{ vesselId: 1, vesselName: 'Yakima', departingTime: '2026-08-30T17:00:00.000Z', arrivingTime: null, departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 3, reservableSpaceCount: null, maxSpaceCount: 139, spaceAvailable: true, spaceSource: 'recorded', spaceObservedAt: '2026-08-30T16:58:00.000Z', spaceLeadSeconds: 120, actualDeparture: null, departureDelayMinutes: null, raw: {} }]);
      return json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, spaceSource: 'live', spaceObservedAt: null, spaceLeadSeconds: null, actualDeparture: null, departureDelayMinutes: null, raw: {} }]);
    });
  }

  it('names the day in the local calendar', () => {
    const expected = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(2026, 7, 30));
    expect(serviceDayLabel('2026-08-30')).toBe(expected);
    expect(serviceDayLabel('not-a-date')).toBe('not-a-date');
  });

  it('swaps to recorded sailings when a past day is chosen', async () => {
    mockDay(['2026-08-30']);
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    expect(await screen.findByText(/176 drive-up \/ 202/)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Day' }));
    await user.click(screen.getByRole('option', { name: serviceDayLabel('2026-08-30') }));

    expect(await screen.findByText(/3 drive-up \/ 139/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Day' }).querySelector('.recorded-mark')).toBeInTheDocument();
    expect(document.querySelector('.vessel-stack.is-dimmed')).toBeInTheDocument();
  });

  it('offers only today when nothing was recorded', async () => {
    mockDay([]);
    render(<ThemeProvider><App /></ThemeProvider>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Day' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Day' })).toHaveTextContent('Today, live');
  });
});

describe('Vessel lateness', () => {
  const underway = { id: 18, eta: '2026-09-02T00:29:00.000Z', leftDock: '2026-09-01T23:56:00.000Z', scheduledDeparture: '2026-09-01T23:45:00.000Z' };

  it('measures the delay from the scheduled departure', () => {
    expect(vesselDelayMinutes(underway)).toBe(11);
    expect(vesselDelayMinutes({ leftDock: null, scheduledDeparture: '2026-09-01T23:45:00.000Z' })).toBeNull();
    expect(vesselDelayMinutes({ leftDock: 'nonsense', scheduledDeparture: '2026-09-01T23:45:00.000Z' })).toBeNull();
  });

  it('pushes the estimate out by the minutes lost at the dock', () => {
    expect(vesselEta(underway)).toBe('2026-09-02T00:40:00.000Z');
  });

  it('leaves the estimate alone for a boat barely behind its slot', () => {
    expect(vesselEta({ ...underway, leftDock: '2026-09-01T23:46:50.000Z' })).toBeNull();
  });

  it('leaves the estimate alone when WSDOT publishes none', () => {
    expect(vesselEta({ ...underway, eta: null })).toBeNull();
  });
});

describe('Sailing arrival', () => {
  const sailing = { actualArrival: null, arrivingTime: null, vesselId: 18, departingTime: '2026-09-01T23:45:00.000Z' };
  const boat = { id: 18, atDock: false, eta: '2026-09-02T00:29:00.000Z', leftDock: '2026-09-01T23:46:00.000Z', scheduledDeparture: '2026-09-01T23:45:00.000Z' };

  it('prefers the observed dock arrival over the published schedule', () => {
    expect(sailingArrival({ ...sailing, actualArrival: '2026-09-02T00:21:00.000Z', arrivingTime: '2026-09-02T00:20:00.000Z' }, []))
      .toEqual({ at: '2026-09-02T00:21:00.000Z', estimated: false });
  });

  it('falls back to the published schedule when nothing was observed', () => {
    expect(sailingArrival({ ...sailing, arrivingTime: '2026-09-02T00:20:00.000Z' }, [])).toEqual({ at: '2026-09-02T00:20:00.000Z', estimated: false });
  });

  it('estimates from the live ETA of the boat making the crossing', () => {
    expect(sailingArrival(sailing, [boat])).toEqual({ at: '2026-09-02T00:29:00.000Z', estimated: true });
  });

  it('adds the departure delay back onto the live ETA', () => {
    expect(sailingArrival(sailing, [{ ...boat, leftDock: '2026-09-01T23:56:00.000Z' }])).toEqual({ at: '2026-09-02T00:40:00.000Z', estimated: true });
  });

  it('gives no arrival for a boat still at the dock or on another slot', () => {
    expect(sailingArrival(sailing, [{ ...boat, atDock: true }])).toBeNull();
    expect(sailingArrival(sailing, [{ ...boat, scheduledDeparture: '2026-09-02T00:45:00.000Z' }])).toBeNull();
    expect(sailingArrival(sailing, [{ ...boat, eta: null }])).toBeNull();
  });
});

describe('Sailing time', () => {
  const sailing = { actualArrival: null, arrivingTime: null, actualDeparture: null, vesselId: 18, departingTime: '2026-09-01T23:45:00.000Z' };

  it('measures from the actual departure to the observed arrival', () => {
    expect(sailingTimeMinutes({ ...sailing, actualDeparture: '2026-09-01T23:56:00.000Z', actualArrival: '2026-09-02T00:31:00.000Z' }, []))
      .toEqual({ minutes: 35, estimated: false });
  });

  it('falls back to the scheduled departure when the boat has not sailed', () => {
    expect(sailingTimeMinutes({ ...sailing, arrivingTime: '2026-09-02T00:20:00.000Z' }, [])).toEqual({ minutes: 35, estimated: false });
  });

  it('marks a crossing built on the live ETA as estimated', () => {
    const boat = { id: 18, atDock: false, eta: '2026-09-02T00:29:00.000Z', leftDock: '2026-09-01T23:46:00.000Z', scheduledDeparture: '2026-09-01T23:45:00.000Z' };
    expect(sailingTimeMinutes(sailing, [boat])).toEqual({ minutes: 44, estimated: true });
  });

  it('gives nothing when either end is missing or the pair is out of order', () => {
    expect(sailingTimeMinutes(sailing, [])).toBeNull();
    expect(sailingTimeMinutes({ ...sailing, actualArrival: '2026-09-01T23:40:00.000Z' }, [])).toBeNull();
  });
});

describe('Associated vessel order', () => {  it('ranks the selected route ahead of its reverse, departures, then arrivals', () => {
    const rank = (departingTerminalId: number, arrivingTerminalId: number) =>
      vesselRouteRank({ departingTerminalId, arrivingTerminalId }, 7, 3);
    expect(rank(7, 3)).toBe(0);
    expect(rank(3, 7)).toBe(1);
    expect(rank(7, 9)).toBe(2);
    expect(rank(9, 7)).toBe(3);
  });

  it('falls back to departures first when no destination is chosen', () => {
    expect(vesselRouteRank({ departingTerminalId: 7, arrivingTerminalId: 3 }, 7, null)).toBe(2);
    expect(vesselRouteRank({ departingTerminalId: 3, arrivingTerminalId: 7 }, 7, null)).toBe(3);
  });
});