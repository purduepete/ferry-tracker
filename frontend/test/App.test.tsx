// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { App } from '../src/App';
import { addFavoriteRoute, capacityLevel, CATCH_DEFAULT_PAD_MINUTES, catchLevel, catchTiming, catchWindowLevel, catchWindows, clearCatchOverride, DEFAULT_FAVORITE_ROUTES, DEFAULT_SETTINGS, departureDelayLabel, departureDelayMinutes, disruptionLevel, disruptionLoad, disruptionWaves, getCurrentSailing, isCurrentSailing, isPublishedRoute, loadCatchOverrides, loadFavoriteRoutes, loadSettings, normalizeCatchOverrides, normalizeFavoriteRoutes, normalizeSettings, openSpacePercent, orderTerminals, recordedSpaceLabel, removeFavoriteRoute, renameFavoriteRoute, reorderFavoriteRoutes, reorderFavoriteTerminals, routeKey, routeName, routePairName, sailingArrival, sailingDeparture, sailingTimeMinutes, serviceDayLabel, setCatchOverride, toggleFavoriteTerminalId, vesselDelayMinutes, vesselEta, vesselRouteRank } from '../src/format';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const terminals = [
  { id: 7, name: 'Seattle', subjectName: 'seattle', latitude: 47.6, longitude: -122.3, city: 'Seattle', cameras: [], raw: [] },
  { id: 3, name: 'Bainbridge Island', subjectName: 'bainbridge', latitude: 47.62, longitude: -122.5, city: 'Bainbridge Island', cameras: [], raw: [] },
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
    expect(await screen.findByText(/176 drv \/ 202/)).toBeInTheDocument();
    expect(screen.queryByText('Current vehicle-space reports')).not.toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-09-01T16:00:00.000Z"]')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Reverse route' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Origin' })).toHaveTextContent('Bainbridge Island'));
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
    expect(screen.getByRole('tab', { name: 'Catch' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Catch' })).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveFocus();
  });

  it('switches tabs from a bare letter key pressed anywhere on the page', async () => {
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
    await screen.findByRole('heading', { name: 'Seattle' });
    // Focus lands on the body, not a tab button, to prove the shortcut is not tab-bar-scoped.
    document.body.focus();

    await user.keyboard('c');
    expect(screen.getByRole('tab', { name: 'Catch' })).toHaveAttribute('aria-selected', 'true');
    // The shortcut only switches the view; it must not steal DOM focus and show a stray ring.
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    await user.keyboard('d');
    expect(screen.getByRole('tab', { name: 'Disruption' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('s');
    expect(screen.getByRole('tab', { name: 'Sailings' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('v');
    expect(screen.getByRole('tab', { name: 'Vessels' })).toHaveAttribute('aria-selected', 'true');
    // Settings takes its 2nd letter since Sailings already claims "s".
    await user.keyboard('a');
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('r');
    expect(screen.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
  });

  it('leaves typing in the favorite-route label alone even though it contains shortcut letters', async () => {
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

    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: /Favorite routes/ }));
    const label = screen.getByRole('textbox', { name: 'Label for Seattle to Bainbridge Island' });
    await user.clear(label);
    await user.type(label, 'sacred commute');

    expect(label).toHaveValue('sacred commute');
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
  });

  it('leaves an open dropdown alone when a shortcut letter is pressed', async () => {
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
    await screen.findByRole('heading', { name: 'Seattle' });

    const origin = screen.getByRole('button', { name: 'Origin' });
    await user.click(origin);
    expect(origin).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('c');
    expect(origin).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
  });

  it('returns to the routes tab from the brand', async () => {
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
    await screen.findByRole('tab', { name: 'Routes' });
    await user.click(screen.getByRole('tab', { name: 'Vessels' }));
    expect(screen.getByRole('tab', { name: 'Vessels' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('button', { name: /Ferry Tracker/ }));
    expect(screen.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
  });

  it('lists persisted favorites first in the saved order and manages them from Settings', async () => {
    const favoriteTerminals = [
      terminals[0],
      terminals[1],
      { id: 1, name: 'Anacortes', subjectName: 'anacortes', latitude: 48.5, longitude: -122.6, city: 'Anacortes', cameras: [], raw: [] },
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
    const terminalTrigger = await screen.findByRole('button', { name: 'Origin' });
    await user.click(terminalTrigger);
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-label') ?? option.textContent?.trim())).toEqual([
      'Seattle',
      'Anacortes',
      'Bainbridge Island',
    ]);
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: /Favorite terminals/ }));
    await user.click(screen.getByRole('button', { name: 'Add Bainbridge Island to favorites' }));
    expect(JSON.parse(localStorage.getItem('ferry-tracker-favorite-terminals') ?? '[]')).toEqual([7, 1, 999, 3]);

    // The stale 999 sits between Anacortes and Bainbridge Island, so the move has to skip it.
    screen.getByRole('button', { name: 'Reorder Bainbridge Island' }).focus();
    await user.keyboard('{ArrowUp}');
    expect(JSON.parse(localStorage.getItem('ferry-tracker-favorite-terminals') ?? '[]')).toEqual([7, 3, 999, 1]);
    await user.keyboard('{ArrowUp}');
    expect(JSON.parse(localStorage.getItem('ferry-tracker-favorite-terminals') ?? '[]')).toEqual([3, 7, 999, 1]);
    await user.keyboard('{ArrowUp}');
    expect(JSON.parse(localStorage.getItem('ferry-tracker-favorite-terminals') ?? '[]')).toEqual([3, 7, 999, 1]);

    await user.click(screen.getByRole('tab', { name: 'Routes' }));
    await user.click(screen.getByRole('button', { name: 'Origin' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent?.trim())).toEqual([
      'Bainbridge Island',
      'Seattle',
      'Anacortes',
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
    expect(await screen.findByText(/176 drv \/ 202/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reverse route' }));

    expect(screen.getByText(/176 drv \/ 202/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading updated ferry data' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'true');

    resolveChangedRoute(await json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T18:00:00.000Z', arrivingTime: '2026-09-01T18:35:00.000Z', departingTerminalId: 3, arrivingTerminalId: 7, isCancelled: false, driveUpSpaceCount: 95, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]));
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByText(/95 drv \/ 202/)).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Origin' })).toHaveTextContent('Bainbridge Island');
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

    await user.click(screen.getByRole('tab', { name: 'Vessels' }));
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
    const pills = await screen.findAllByLabelText('80% of 200 vehicle spaces taken');
    expect(pills[0]).toHaveClass('capacity-pill', 'tight');
    expect(screen.queryByLabelText('0% of 200 vehicle spaces taken')).not.toBeInTheDocument();
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
    expect(await screen.findByText(/40 drv \/ 202/)).toBeInTheDocument();
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

  describe('sailingDeparture', () => {
    const sailing = { actualDeparture: null, departureDelayMinutes: null, vesselId: 1, departingTime: '2026-09-01T17:00:00.000Z' };
    const boat = { id: 1, atDock: false, speed: 14, leftDock: left, scheduledDeparture: '2026-09-01T17:00:00.000Z' };

    it('prefers the recorded leg once the crossing has closed', () => {
      expect(sailingDeparture({ ...sailing, actualDeparture: left, departureDelayMinutes: 6 }, [])).toEqual({ at: left, delayMinutes: 6 });
    });

    it('falls back to the live feed while the boat is still underway', () => {
      expect(sailingDeparture(sailing, [boat])).toEqual({ at: left, delayMinutes: 6 });
    });

    it('counts a boat under two minutes late as on time, the same as vesselEta does', () => {
      expect(sailingDeparture(sailing, [{ ...boat, leftDock: '2026-09-01T17:01:00.000Z' }]))
        .toEqual({ at: '2026-09-01T17:00:00.000Z', delayMinutes: null });
    });

    it('ignores a boat sitting in a different slot', () => {
      expect(sailingDeparture(sailing, [{ ...boat, scheduledDeparture: '2026-09-01T17:35:00.000Z' }])).toBeNull();
      expect(sailingDeparture(sailing, [{ ...boat, id: 2 }])).toBeNull();
      expect(sailingDeparture(sailing, [{ ...boat, leftDock: null }])).toBeNull();
    });

    it('never pairs a slotless sailing with a slotless vessel', () => {
      expect(sailingDeparture({ ...sailing, departingTime: null }, [{ ...boat, scheduledDeparture: null }])).toBeNull();
    });

    it('waits for movement, since AtDock flapping drags LeftDock with it', () => {
      expect(sailingDeparture(sailing, [{ ...boat, speed: 0.2 }])).toBeNull();
      expect(sailingDeparture(sailing, [{ ...boat, atDock: true }])).toBeNull();
      expect(sailingDeparture(sailing, [{ ...boat, speed: null }])).toEqual({ at: left, delayMinutes: 6 });
    });

    it('rejects a left-dock time before the slot, which pairs the wrong crossing', () => {
      expect(sailingDeparture(sailing, [{ ...boat, leftDock: '2026-09-01T16:45:00.000Z' }])).toBeNull();
    });
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
    expect(await screen.findByText(/40 drv/)).toBeInTheDocument();
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
    expect(await screen.findByText(/40 drv/)).toBeInTheDocument();
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

  it('changes the route in place when the vessel card on Routes is clicked', async () => {
    mockOverview();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    // The whole card is the click target, not just the vessel name.
    await userEvent.click(await screen.findByRole('button', { name: "Show Wenatchee's route in the routes view" }));

    expect(screen.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Origin' })).toHaveTextContent('Bainbridge Island'));
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Seattle');
  });

  it('leaves the vessel card inert when its terminal is not yet published', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json([{ ...returning, departingTerminalId: null, arrivingTerminalId: 7 }]);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
      ]);
      if (url.includes('/api/history')) return json([]);
      return json([]);
    });
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    expect(screen.queryByRole('button', { name: /Show Wenatchee's route/ })).not.toBeInTheDocument();
    expect(screen.getByText('Wenatchee')).toBeInTheDocument();
  });

  it('opens the routes view on the route the clicked vessel is running', async () => {
    mockOverview();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await userEvent.click(screen.getByRole('tab', { name: 'Vessels' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Wenatchee' }));

    expect(screen.getByRole('tab', { name: 'Routes' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Origin' })).toHaveTextContent('Bainbridge Island'));
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Origin' })).toHaveTextContent('Bainbridge Island'));
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Seattle');
  });

  function mockSchedule(sailings: unknown[]) {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json([...vessels, returning]);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
        { departingTerminalId: 3, departingTerminalName: 'Bainbridge Island', arrivingTerminalId: 7, arrivingTerminalName: 'Seattle' },
      ]);
      if (url.includes('/api/history')) return json([]);
      return json(sailings);
    });
  }

  it('switches to the Vessels tab and highlights the vessel when a sailing row is clicked', async () => {
    mockSchedule([{ vesselId: 2, vesselName: 'Wenatchee', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]);
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await userEvent.click(screen.getByRole('tab', { name: 'Sailings' }));
    const row = (await screen.findByRole('button', { name: 'Wenatchee' })).closest('tr');
    if (!row) throw new Error('expected the vessel link to sit inside a table row');
    await userEvent.click(row);

    expect(screen.getByRole('tab', { name: 'Vessels' })).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('.data-card.is-highlighted')).not.toBeNull();
  });

  it('leaves a sailing row inert when its vessel is not currently live', async () => {
    mockSchedule([{ vesselId: 99, vesselName: 'Ghost', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]);
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await userEvent.click(screen.getByRole('tab', { name: 'Sailings' }));
    const row = (await screen.findByText('Ghost')).closest('tr');
    if (!row) throw new Error('expected a table row');
    await userEvent.click(row);

    expect(screen.getByRole('tab', { name: 'Sailings' })).toHaveAttribute('aria-selected', 'true');
  });

  it('activates a linked sailing row from the keyboard without also firing the nested vessel link', async () => {
    mockSchedule([{ vesselId: 2, vesselName: 'Wenatchee', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]);
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await userEvent.click(screen.getByRole('tab', { name: 'Sailings' }));

    const vesselLink = await screen.findByRole('button', { name: 'Wenatchee' });
    const row = vesselLink.closest('tr');
    if (!row) throw new Error('expected the vessel link to sit inside a table row');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'Vessels' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('tab', { name: 'Sailings' }));
    vesselLink.focus();
    await userEvent.keyboard('{Enter}');
    // Enter on the nested link must not bubble up and also switch to Vessels.
    expect(screen.getByRole('tab', { name: 'Sailings' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Vessels' })).toHaveAttribute('aria-selected', 'false');
  });

  it('switches to the Vessels tab from the compact schedule list on Routes', async () => {
    mockSchedule([{ vesselId: 2, vesselName: 'Wenatchee', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]);
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    // 'Wenatchee' also names a vessel-node card on this tab, so scope the lookup to the list.
    const list = await waitFor(() => {
      const element = document.querySelector('.sailing-list');
      if (!element) throw new Error('compact sailing list has not rendered yet');
      return element as HTMLElement;
    });
    const item = within(list).getByText('Wenatchee').closest('li');
    if (!item) throw new Error('expected the sailing to sit inside a list item');
    await userEvent.click(item);

    expect(screen.getByRole('tab', { name: 'Vessels' })).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('.data-card.is-highlighted')).not.toBeNull();
  });

  it('opens the Sailings tab from the schedule card header on Routes', async () => {
    mockSchedule([{ vesselId: 2, vesselName: 'Wenatchee', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]);
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await userEvent.click(screen.getByRole('button', { name: /Sailings schedule/ }));

    expect(screen.getByRole('tab', { name: 'Sailings' })).toHaveAttribute('aria-selected', 'true');
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
    expect(await screen.findByText(/176 drv \/ 202/)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Day' }));
    await user.click(screen.getByRole('option', { name: serviceDayLabel('2026-08-30') }));

    expect(await screen.findByText(/3 drv \/ 139/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Day' }).querySelector('.recorded-mark')).toBeInTheDocument();
    expect(document.querySelector('.vessel-stack.is-dimmed')).toBeInTheDocument();
    expect(document.querySelector('.app-header.is-recorded')).toBeInTheDocument();

    // Catch is always live, so the day it is browsing must not colour the header.
    await user.click(screen.getByRole('tab', { name: 'Catch' }));
    await waitFor(() => expect(document.querySelector('.app-header.is-recorded')).not.toBeInTheDocument());
  });

  it('offers only today when nothing was recorded', async () => {
    mockDay([]);
    render(<ThemeProvider><App /></ThemeProvider>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Day' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Day' })).toHaveTextContent('Today, live');
  });

  it('jumps to the most recent recorded day when opening Sailings, and back to live when leaving it', async () => {
    mockDay(['2026-08-30', '2026-08-29']);
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByText(/176 drv \/ 202/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Day' })).not.toBeDisabled());

    await user.click(screen.getByRole('tab', { name: 'Sailings' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Day' })).toHaveTextContent(serviceDayLabel('2026-08-30')));
    expect(document.querySelector('.app-header.is-recorded')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Routes' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Day' })).toHaveTextContent('Today, live'));
    expect(document.querySelector('.app-header.is-recorded')).not.toBeInTheDocument();
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

  it('measures a late crossing from the live departure, so the delay never inflates it', () => {
    const boat = { id: 18, atDock: false, speed: 14, eta: '2026-09-02T00:29:00.000Z', leftDock: '2026-09-01T23:56:00.000Z', scheduledDeparture: '2026-09-01T23:45:00.000Z' };
    expect(sailingTimeMinutes(sailing, [boat])).toEqual({ minutes: 44, estimated: true });
  });

  it('gives nothing when either end is missing or the pair is out of order', () => {
    expect(sailingTimeMinutes(sailing, [])).toBeNull();
    expect(sailingTimeMinutes({ ...sailing, actualArrival: '2026-09-01T23:40:00.000Z' }, [])).toBeNull();
  });
});

describe('Current sailing', () => {
  const at = (time: string) => `2026-09-01T${time}:00.000Z`;
  const now = Date.parse(at('18:51'));
  const schedule = [
    { departingTime: at('17:35'), actualDeparture: at('17:45'), vesselId: 2 },
    { departingTime: at('18:40'), actualDeparture: null, vesselId: 1 },
    { departingTime: at('19:20'), actualDeparture: null, vesselId: 2 },
    { departingTime: at('20:20'), actualDeparture: null, vesselId: 1 },
  ];
  const underway = [{ id: 1, atDock: false, scheduledDeparture: at('18:40') }];

  it('moves on once the live feed shows the boat away from the dock', () => {
    expect(getCurrentSailing(schedule, underway, now)?.departingTime).toBe(at('19:20'));
  });

  it('moves on once a departure has been recorded', () => {
    const recorded = schedule.map((sailing) => (sailing.vesselId === 1 && sailing.departingTime === at('18:40')
      ? { ...sailing, actualDeparture: at('18:46') }
      : sailing));
    expect(getCurrentSailing(recorded, [], now)?.departingTime).toBe(at('19:20'));
  });

  it('holds a late boat that is still at the dock', () => {
    expect(getCurrentSailing(schedule, [{ id: 1, atDock: true, scheduledDeparture: at('18:40') }], now)?.departingTime).toBe(at('18:40'));
  });

  it('will not lend another boat departure to the row', () => {
    const wrongBoat = [{ id: 9, atDock: false, scheduledDeparture: at('18:40') }];
    expect(getCurrentSailing(schedule, wrongBoat, now)?.departingTime).toBe(at('18:40'));
  });

  it('drops a boat more than fifteen minutes past its slot with nothing observed', () => {
    expect(getCurrentSailing(schedule, [], Date.parse(at('18:56')))?.departingTime).toBe(at('19:20'));
  });

  it('gives nothing once every sailing has gone', () => {
    expect(getCurrentSailing(schedule.slice(0, 2), underway, now)).toBeNull();
  });

  it('matches a row by its scheduled departure', () => {
    expect(isCurrentSailing(schedule[2], schedule[2])).toBe(true);
    expect(isCurrentSailing(schedule[1], schedule[2])).toBe(false);
    expect(isCurrentSailing(schedule[1], null)).toBe(false);
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

describe('Favorite terminal order', () => {
  const catalog = [
    { id: 7, name: 'Seattle' },
    { id: 3, name: 'Bainbridge Island' },
    { id: 1, name: 'Anacortes' },
  ];

  it('keeps favorites in the saved order and sorts the rest alphabetically', () => {
    expect(orderTerminals(catalog, [7, 3]).map(({ terminal, favorite }) => [terminal.name, favorite])).toEqual([
      ['Seattle', true],
      ['Bainbridge Island', true],
      ['Anacortes', false],
    ]);
  });

  it('drops favorites for terminals WSDOT no longer publishes', () => {
    expect(orderTerminals(catalog, [999, 3]).map(({ terminal }) => terminal.name)).toEqual([
      'Bainbridge Island',
      'Anacortes',
      'Seattle',
    ]);
  });

  it('adds a new favorite at the end and removes it again', () => {
    expect(toggleFavoriteTerminalId([7], 3)).toEqual([7, 3]);
    expect(toggleFavoriteTerminalId([7, 3], 7)).toEqual([3]);
  });

  it('swaps a favorite with its visible neighbour, skipping unpublished ones', () => {
    expect(reorderFavoriteTerminals([7, 999, 3], [7, 3], 3, 7)).toEqual([3, 999, 7]);
    expect(reorderFavoriteTerminals([7, 3], [7, 3], 7, 3)).toEqual([3, 7]);
  });

  it('drops a favorite onto a target further down the list', () => {
    expect(reorderFavoriteTerminals([7, 3, 1], [7, 3, 1], 7, 1)).toEqual([3, 1, 7]);
    expect(reorderFavoriteTerminals([7, 3, 1], [7, 3, 1], 1, 7)).toEqual([1, 7, 3]);
  });

  it('leaves the order alone when the drop goes nowhere', () => {
    expect(reorderFavoriteTerminals([7, 3], [7, 3], 7, 7)).toEqual([7, 3]);
    expect(reorderFavoriteTerminals([7, 3], [7, 3], 999, 7)).toEqual([7, 3]);
  });
});

describe('Favorite routes', () => {
  const catalog = [
    { id: 7, name: 'Seattle' },
    { id: 3, name: 'Bainbridge Island' },
    { id: 1, name: 'Anacortes' },
  ];
  const bi = { originId: 3, destinationId: 7, label: 'BI → SEA' };
  const sea = { originId: 7, destinationId: 3, label: '' };

  it('names a route by its label, falling back to the terminal pair', () => {
    expect(routeKey(bi)).toBe('3-7');
    expect(routeName(bi, catalog)).toBe('BI → SEA');
    expect(routeName(sea, catalog)).toBe('Seattle to Bainbridge Island');
    expect(routePairName({ originId: 3, destinationId: 999 }, catalog)).toBe('Bainbridge Island to Unknown');
  });

  it('keeps a stored route, drops junk, and never stores the same pair twice', () => {
    expect(normalizeFavoriteRoutes([bi, { ...bi, label: 'again' }])).toEqual([bi]);
    expect(normalizeFavoriteRoutes([{ originId: 3, destinationId: 3, label: 'nowhere' }])).toEqual([]);
    expect(normalizeFavoriteRoutes([{ originId: '3', destinationId: 7, label: 'text ids' }])).toEqual([]);
    expect(normalizeFavoriteRoutes([{ originId: 3, destinationId: 7 }])).toEqual([{ originId: 3, destinationId: 7, label: '' }]);
    expect(normalizeFavoriteRoutes('nonsense')).toEqual([]);
  });

  it('seeds the Bainbridge pair only when nothing was ever saved', () => {
    expect(loadFavoriteRoutes()).toEqual(DEFAULT_FAVORITE_ROUTES);
    localStorage.setItem('ferry-tracker-favorite-routes', JSON.stringify([]));
    expect(loadFavoriteRoutes()).toEqual([]);
    localStorage.setItem('ferry-tracker-favorite-routes', JSON.stringify([bi]));
    expect(loadFavoriteRoutes()).toEqual([bi]);
  });

  it('adds a route at the end and refuses a duplicate or a round trip to nowhere', () => {
    expect(addFavoriteRoute([bi], 7, 3)).toEqual([bi, { originId: 7, destinationId: 3, label: '' }]);
    expect(addFavoriteRoute([bi], 3, 7)).toEqual([bi]);
    expect(addFavoriteRoute([], 3, 3)).toEqual([]);
  });

  it('renames and removes by pair', () => {
    expect(renameFavoriteRoute([bi], '3-7', 'Home')).toEqual([{ ...bi, label: 'Home' }]);
    expect(renameFavoriteRoute([bi], '9-9', 'Home')).toEqual([bi]);
    expect(removeFavoriteRoute([bi, sea], '3-7')).toEqual([sea]);
  });

  it('drops a route onto another and leaves a missing one alone', () => {
    const three = [bi, sea, { originId: 1, destinationId: 7, label: '' }];
    expect(reorderFavoriteRoutes(three, '3-7', '1-7').map(routeKey)).toEqual(['7-3', '1-7', '3-7']);
    expect(reorderFavoriteRoutes(three, '1-7', '3-7').map(routeKey)).toEqual(['1-7', '3-7', '7-3']);
    expect(reorderFavoriteRoutes(three, '3-7', '3-7')).toEqual(three);
    expect(reorderFavoriteRoutes(three, '9-9', '3-7')).toEqual(three);
  });

  it('only counts a route WSDOT still publishes in that direction', () => {
    const mates = [{ departingTerminalId: 3, arrivingTerminalId: 7 }];
    expect(isPublishedRoute(bi, mates)).toBe(true);
    expect(isPublishedRoute(sea, mates)).toBe(false);
  });
});

describe('Favorite routes in the app', () => {
  const bothWays = [
    { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
    { departingTerminalId: 3, departingTerminalName: 'Bainbridge Island', arrivingTerminalId: 7, arrivingTerminalName: 'Seattle' },
  ];
  const scheduleUrls: string[] = [];

  function mockApp() {
    scheduleUrls.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json(bothWays);
      if (url.includes('/api/history')) return json([]);
      if (url.includes('/api/schedule')) scheduleUrls.push(url);
      return json([]);
    });
  }

  async function openFavoriteRoutes(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: /Favorite routes/ }));
  }

  it('seeds both Bainbridge directions and offers them as quick picks', async () => {
    mockApp();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    expect([...document.querySelectorAll('.route-chip')].map((chip) => chip.textContent)).toEqual(['BI → SEA', 'SEA → BI']);
  });

  it('jumps the selectors to a favorite route', async () => {
    mockApp();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await user.click(screen.getByRole('button', { name: 'BI → SEA' }));
    expect(screen.getByRole('button', { name: 'Origin' })).toHaveTextContent('Bainbridge Island');
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Seattle');
    expect(screen.getByRole('button', { name: 'BI → SEA' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('stays on the Sailings tab when a favorite route is picked there', async () => {
    mockApp();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await user.click(screen.getByRole('tab', { name: 'Sailings' }));
    await user.click(screen.getByRole('button', { name: 'BI → SEA' }));

    expect(screen.getByRole('tab', { name: 'Sailings' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Origin' })).toHaveTextContent('Bainbridge Island');
  });

  it('adds a route, labels it, and stores the pair once', async () => {
    localStorage.setItem('ferry-tracker-favorite-routes', JSON.stringify([]));
    mockApp();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await openFavoriteRoutes(user);

    const add = screen.getByRole('button', { name: 'Add route' });
    expect(add).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'New route origin' }));
    await user.click(screen.getByRole('option', { name: 'Bainbridge Island' }));
    expect(add).toBeEnabled();
    await user.click(add);

    expect(JSON.parse(localStorage.getItem('ferry-tracker-favorite-routes') ?? '[]')).toEqual([{ originId: 3, destinationId: 7, label: '' }]);
    expect(screen.getByRole('button', { name: 'Add route' })).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Label for Bainbridge Island to Seattle' }), 'Commute');
    expect(JSON.parse(localStorage.getItem('ferry-tracker-favorite-routes') ?? '[]')).toEqual([{ originId: 3, destinationId: 7, label: 'Commute' }]);
  });

  it('reorders with the keyboard and removes a route', async () => {
    mockApp();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await openFavoriteRoutes(user);

    screen.getByRole('button', { name: 'Reorder Seattle to Bainbridge Island' }).focus();
    await user.keyboard('{ArrowUp}');
    expect(JSON.parse(localStorage.getItem('ferry-tracker-favorite-routes') ?? '[]').map(routeKey)).toEqual(['7-3', '3-7']);

    await user.click(screen.getByRole('button', { name: 'Remove Seattle to Bainbridge Island from favorite routes' }));
    expect(JSON.parse(localStorage.getItem('ferry-tracker-favorite-routes') ?? '[]').map(routeKey)).toEqual(['3-7']);
  });

  it('fetches the schedule for the route the Catch tab is switched to', async () => {
    mockApp();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await user.click(screen.getByRole('tab', { name: 'Catch' }));
    expect(await screen.findByRole('heading', { name: 'BI → SEA' })).toBeInTheDocument();
    await waitFor(() => expect(scheduleUrls.some((url) => url.includes('departingTerminalId=3&arrivingTerminalId=7'))).toBe(true));

    await user.click(within(screen.getByRole('group', { name: 'Catch route' })).getByRole('button', { name: 'SEA → BI' }));
    expect(await screen.findByRole('heading', { name: 'SEA → BI' })).toBeInTheDocument();
    await waitFor(() => expect(scheduleUrls.some((url) => url.includes('departingTerminalId=7&arrivingTerminalId=3'))).toBe(true));
    expect(localStorage.getItem('ferry-tracker-catch-route')).toBe('7-3');
  });

  it('asks for a favorite route when there are none', async () => {
    localStorage.setItem('ferry-tracker-favorite-routes', JSON.stringify([]));
    mockApp();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });

    await user.click(screen.getByRole('tab', { name: 'Catch' }));
    expect(await screen.findByText('Add a favorite route in Settings to see when to leave.')).toBeInTheDocument();
    expect(document.querySelector('.route-chip')).toBeNull();
  });
});

describe('Bainbridge disruption', () => {
  const now = Date.parse('2026-09-01T17:00:00.000Z');
  const inbound = {
    id: 1, name: 'Tacoma', arrivingTerminalId: 3, atDock: false,
    eta: '2026-09-01T17:20:00.000Z', leftDock: null, scheduledDeparture: null,
  };

  it('colors the countdown at each threshold', () => {
    expect(disruptionLevel(0)).toBe('imminent');
    expect(disruptionLevel(4)).toBe('imminent');
    expect(disruptionLevel(5)).toBe('soon');
    expect(disruptionLevel(14)).toBe('soon');
    expect(disruptionLevel(15)).toBe('clear');
  });

  it('lands the wave ten minutes after the boat docks and holds it for fifteen', () => {
    expect(disruptionWaves([inbound], now)).toEqual([{
      vesselId: 1,
      vesselName: 'Tacoma',
      source: 'live',
      landingAt: '2026-09-01T17:20:00.000Z',
      disruptionAt: '2026-09-01T17:30:00.000Z',
      clearsAt: '2026-09-01T17:45:00.000Z',
      minutesAway: 30,
      minutesLeft: 45,
      active: false,
      ongoing: false,
    }]);
  });

  it('keeps a window that is already open and counts down to the end of it', () => {
    const started = disruptionWaves([inbound], Date.parse('2026-09-01T17:36:00.000Z'))[0];
    expect(started).toMatchObject({ active: true, minutesAway: -6, minutesLeft: 9 });
  });

  it('counts whole minutes from the clock minute, not the current second', () => {
    expect(disruptionWaves([inbound], Date.parse('2026-09-01T17:00:43.000Z'))[0])
      .toMatchObject({ minutesAway: 30, minutesLeft: 45 });
  });

  it('drops the wave once the traffic has cleared', () => {
    expect(disruptionWaves([inbound], Date.parse('2026-09-01T17:45:00.000Z'))).toEqual([]);
  });

  it('stretches the window by the configured duration', () => {
    const settings = { ...DEFAULT_SETTINGS, disruptionDurationMinutes: 45 };
    expect(disruptionWaves([inbound], now, settings)[0].clearsAt).toBe('2026-09-01T18:15:00.000Z');
    expect(disruptionWaves([inbound], Date.parse('2026-09-01T17:45:00.000Z'), settings)).toHaveLength(1);
  });

  it('calls the traffic ongoing when the next boat lands inside the window', () => {
    const close = { ...inbound, id: 2, name: 'Wenatchee', eta: '2026-09-01T17:32:00.000Z' };
    const apart = { ...inbound, id: 2, name: 'Wenatchee', eta: '2026-09-01T17:50:00.000Z' };
    expect(disruptionWaves([close, inbound], now).map((wave) => wave.ongoing)).toEqual([true, false]);
    expect(disruptionWaves([apart, inbound], now).map((wave) => wave.ongoing)).toEqual([false, false]);
  });

  describe('the boat that most recently docked', () => {
    const leg = { vesselId: 4, vesselName: 'Chimacum', actualArrival: '2026-09-01T16:45:00.000Z' };

    it('takes its landing from the observed arrival, since a docked boat leaves the vessel feed', () => {
      expect(disruptionWaves([], now, DEFAULT_SETTINGS, [leg])[0]).toMatchObject({
        vesselId: 4, vesselName: 'Chimacum', disruptionAt: '2026-09-01T16:55:00.000Z', active: true, minutesLeft: 10,
      });
    });

    it('ignores a leg that has not arrived or has already cleared', () => {
      expect(disruptionWaves([], now, DEFAULT_SETTINGS, [{ ...leg, actualArrival: null }])).toEqual([]);
      expect(disruptionWaves([], now, DEFAULT_SETTINGS, [{ ...leg, actualArrival: '2026-09-01T16:30:00.000Z' }])).toEqual([]);
    });

    it('does not double up when the vessel feed still reads the same landing as underway', () => {
      const stale = { ...inbound, id: 4, name: 'Chimacum', eta: '2026-09-01T16:56:00.000Z' };
      expect(disruptionWaves([stale], now, DEFAULT_SETTINGS, [leg])).toHaveLength(1);
    });
  });

  it('pushes the wave out by the delay the boat is already carrying', () => {
    const late = { ...inbound, leftDock: '2026-09-01T16:56:00.000Z', scheduledDeparture: '2026-09-01T16:45:00.000Z' };
    expect(disruptionWaves([late], now)[0]).toMatchObject({ landingAt: '2026-09-01T17:31:00.000Z', disruptionAt: '2026-09-01T17:41:00.000Z', minutesAway: 41 });
  });

  it('ignores boats that are docked, bound elsewhere, or already past', () => {
    expect(disruptionWaves([{ ...inbound, atDock: true }], now)).toEqual([]);
    expect(disruptionWaves([{ ...inbound, arrivingTerminalId: 7 }], now)).toEqual([]);
    expect(disruptionWaves([{ ...inbound, eta: null }], now)).toEqual([]);
    expect(disruptionWaves([inbound], Date.parse('2026-09-01T17:46:00.000Z'))).toEqual([]);
  });

  it('orders several inbound boats by when their traffic arrives', () => {
    const later = { ...inbound, id: 2, name: 'Wenatchee', eta: '2026-09-01T18:20:00.000Z' };
    expect(disruptionWaves([later, inbound], now).map((wave) => wave.vesselName)).toEqual(['Tacoma', 'Wenatchee']);
  });

  describe('how full the arriving boat was', () => {
    const leg = {
      vesselId: 1, departingTime: '2026-09-01T16:45:00.000Z', spaceAvailable: true,
      driveUpSpaceCount: 29, reservableSpaceCount: null, maxSpaceCount: 197,
      spaceObservedAt: '2026-09-01T16:44:33.000Z',
    };

    it('reads the leg the boat is on right now', () => {
      expect(disruptionLoad([leg], 1, '2026-09-01T17:20:00.000Z')).toEqual({
        percentFull: 85, openPercent: 15, openCount: 29, totalSpace: 197,
        observedAt: '2026-09-01T16:44:33.000Z',
      });
    });

    it('takes the latest leg that had already sailed by the landing', () => {
      const earlier = { ...leg, departingTime: '2026-09-01T15:50:00.000Z', driveUpSpaceCount: 180 };
      const next = { ...leg, departingTime: '2026-09-01T17:40:00.000Z', driveUpSpaceCount: 197 };
      expect(disruptionLoad([next, leg, earlier], 1, '2026-09-01T17:20:00.000Z')?.percentFull).toBe(85);
    });

    it('gives nothing when the counts are missing or the vessel does not match', () => {
      expect(disruptionLoad([leg], 2, '2026-09-01T17:20:00.000Z')).toBeNull();
      expect(disruptionLoad([{ ...leg, maxSpaceCount: null }], 1, '2026-09-01T17:20:00.000Z')).toBeNull();
      expect(disruptionLoad([{ ...leg, spaceAvailable: false }], 1, '2026-09-01T17:20:00.000Z')).toBeNull();
      expect(disruptionLoad([], 1, '2026-09-01T17:20:00.000Z')).toBeNull();
    });
  });

  it('shows the countdown and the boats behind it', async () => {
    // Relative to the real clock so the countdown does not need fake timers, which would
    // deadlock userEvent.
    const soon = new Date(Date.now() + 20 * 60000).toISOString();
    const later = { ...vessels[0], id: 2, name: 'Wenatchee', eta: new Date(Date.now() + 80 * 60000).toISOString(), leftDock: null };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json([{ ...vessels[0], eta: soon, leftDock: null }, later]);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await userEvent.click(screen.getByRole('tab', { name: 'Disruption' }));

    expect(screen.getByRole('tabpanel', { name: 'Disruption' })).toBeInTheDocument();
    expect(document.querySelector('.countdown-value')).toHaveTextContent('30 min');
    expect(document.querySelector('.countdown-headline')).toHaveClass('is-clear');
    expect(screen.getByText('Tacoma')).toBeInTheDocument();
    expect(document.querySelectorAll('.countdown-later .sailing-list li')).toHaveLength(1);
  });

  it('shows how full the arriving boat was', async () => {
    const soon = new Date(Date.now() + 20 * 60000).toISOString();
    const sailed = new Date(Date.now() - 15 * 60000).toISOString();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json([{ ...vessels[0], eta: soon, leftDock: null }]);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      if (url.includes('departingTerminalId=7&arrivingTerminalId=3')) {
        return json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: sailed, arrivingTime: null, departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 29, reservableSpaceCount: null, maxSpaceCount: 197, spaceAvailable: true, spaceSource: 'recorded', spaceObservedAt: sailed, raw: {} }]);
      }
      return json([]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await userEvent.click(screen.getByRole('tab', { name: 'Disruption' }));

    const capacity = await screen.findByTitle('85% of 197 vehicle spaces taken');
    expect(capacity.closest('.field')?.querySelector('dt')).toHaveTextContent('Capacity');
    expect(capacity).toHaveTextContent('85%');
  });

  it('leaves the capacity out when the inbound leg has no counts', async () => {
    const soon = new Date(Date.now() + 20 * 60000).toISOString();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json([{ ...vessels[0], eta: soon, leftDock: null }]);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await userEvent.click(screen.getByRole('tab', { name: 'Disruption' }));

    const capacity = await screen.findByText('Capacity');
    expect(capacity.closest('.field')?.querySelector('dd')).toHaveTextContent('—');
  });

  it('says so when nothing is inbound', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json([{ ...vessels[0], arrivingTerminalId: 7, eta: null }]);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await userEvent.click(screen.getByRole('tab', { name: 'Disruption' }));

    expect(await screen.findByText('No upcoming arrival is available in the current schedule.')).toBeInTheDocument();
  });
});

describe('Catching a ferry', () => {
  const now = Date.parse('2026-09-01T17:00:00.000Z');
  const sailing = {
    departingTime: '2026-09-01T18:00:00.000Z', departingTerminalId: 3, vesselId: 18, vesselName: 'Tacoma', isCancelled: false,
    spaceAvailable: true, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202,
  };
  const boat = {
    id: 18, atDock: true, speed: 0, leftDock: null, eta: null,
    scheduledDeparture: '2026-09-01T18:00:00.000Z', arrivingTerminalId: null, updatedAt: null,
  };

  it('colors the countdown at each threshold', () => {
    expect(catchLevel(0)).toBe('soon');
    expect(catchLevel(4)).toBe('soon');
    expect(catchLevel(5)).toBe('soon');
    expect(catchLevel(9)).toBe('soon');
    expect(catchLevel(10)).toBe('clear');
  });

  it('takes the worse of time left and space left', () => {
    expect(catchWindowLevel({ minutesAway: 60, spacePercent: 50 })).toBe('clear');
    expect(catchWindowLevel({ minutesAway: 60, spacePercent: 49 })).toBe('soon');
    expect(catchWindowLevel({ minutesAway: 60, spacePercent: 24 })).toBe('imminent');
    expect(catchWindowLevel({ minutesAway: 3, spacePercent: 100 })).toBe('soon');
    expect(catchWindowLevel({ minutesAway: 7, spacePercent: 20 })).toBe('imminent');
    expect(catchWindowLevel({ minutesAway: 60, spacePercent: null })).toBe('clear');
  });

  it('pads the default half hour off the departure', () => {
    expect(CATCH_DEFAULT_PAD_MINUTES).toBe(30);
    expect(catchWindows([sailing], now)).toEqual([{
      departureAt: '2026-09-01T18:00:00.000Z',
      expectedDepartureAt: null,
      delayMinutes: null,
      delaySource: null,
      leaveByAt: '2026-09-01T17:30:00.000Z',
      minutesAway: 30,
      queueMinutesRemaining: null,
      estimatedLeaveByAt: null,
      estimatedMinutesAway: null,
      estimatedQueueMinutesRemaining: null,
      dimScheduled: false,
      vesselId: 18,
      vesselName: 'Tacoma',
      spaceLabel: '176 drive-up / 202',
      spacePercent: 87,
      spaceTotal: 202,
    }]);
  });

  it('honors a chosen pad', () => {
    expect(catchWindows([sailing], now, { trafficMinutes: 30, queueMinutes: 15 })[0]).toMatchObject({ leaveByAt: '2026-09-01T17:15:00.000Z', minutesAway: 15 });
    expect(catchWindows([sailing], now, { trafficMinutes: 0, queueMinutes: 0 })[0]).toMatchObject({ leaveByAt: '2026-09-01T18:00:00.000Z', minutesAway: 60 });
    expect(catchWindows([sailing], now, { trafficMinutes: 45, queueMinutes: 30 })[0]).toMatchObject({ leaveByAt: '2026-09-01T16:45:00.000Z', minutesAway: -15 });
  });

  it('counts whole minutes from the clock minute, not the current second', () => {
    expect(catchWindows([sailing], Date.parse('2026-09-01T17:00:43.000Z'))[0]).toMatchObject({ minutesAway: 30 });
    expect(catchWindows([sailing], Date.parse('2026-09-01T17:29:59.000Z'))[0]).toMatchObject({ minutesAway: 1 });
  });

  it('keeps a boat that has not sailed, and drops cancelled ones', () => {
    expect(catchWindows([sailing], Date.parse('2026-09-01T17:45:00.000Z'))[0]).toMatchObject({ minutesAway: -15 });
    expect(catchWindows([sailing], Date.parse('2026-09-01T18:00:00.000Z'))).toEqual([]);
    expect(catchWindows([{ ...sailing, isCancelled: true }], now)).toEqual([]);
    expect(catchWindows([{ ...sailing, departingTime: null }], now)).toEqual([]);
  });

  it('drops a boat you are over a quarter hour late for, or that has no room left', () => {
    expect(catchWindows([sailing], Date.parse('2026-09-01T17:46:00.000Z'))).toEqual([]);
    expect(catchWindows([{ ...sailing, driveUpSpaceCount: 0, reservableSpaceCount: 0 }], now)).toEqual([]);
    expect(catchWindows([{ ...sailing, driveUpSpaceCount: 1, reservableSpaceCount: null }], now)).toHaveLength(1);
  });

  it('keeps a delayed docked boat only when no driving time remains', () => {
    const late = Date.parse('2026-09-01T18:06:00.000Z');
    const atTerminal = { trafficMinutes: 0, queueMinutes: 15 };
    expect(catchWindows([sailing], late, undefined, [boat])).toEqual([]);
    expect(catchWindows([sailing], late, atTerminal, [boat])[0]).toMatchObject({
      delayMinutes: 6,
      delaySource: 'observed',
      expectedDepartureAt: '2026-09-01T18:06:00.000Z',
      leaveByAt: '2026-09-01T17:45:00.000Z',
      minutesAway: -21,
      estimatedMinutesAway: -15,
    });
    // Under two minutes is inside the reporting noise, so nothing is claimed.
    expect(catchWindows([sailing], Date.parse('2026-09-01T18:01:00.000Z'), atTerminal, [boat])).toEqual([]);
    // A boat really can sit there for half an hour, and how late it is says nothing about whether
    // the reading can be trusted. Only a feed that stopped refreshing is stale.
    expect(catchWindows([sailing], Date.parse('2026-09-01T18:35:00.000Z'), atTerminal, [boat])[0])
      .toMatchObject({ delayMinutes: 35, delaySource: 'observed' });
  });

  it('claims nothing off a vessel feed that has gone quiet', () => {
    const late = Date.parse('2026-09-01T18:35:00.000Z');
    const atTerminal = { trafficMinutes: 0, queueMinutes: 15 };
    expect(catchWindows([sailing], late, atTerminal, [{ ...boat, updatedAt: '2026-09-01T18:29:00.000Z' }])).toEqual([]);
    expect(catchWindows([sailing], late, atTerminal, [{ ...boat, updatedAt: '2026-09-01T18:30:00.000Z' }])[0])
      .toMatchObject({ delayMinutes: 35, delaySource: 'observed' });
    // An unparseable or absent stamp is a fixture, not a boat nobody has heard from.
    expect(catchWindows([sailing], late, atTerminal, [{ ...boat, updatedAt: 'not a date' }])[0])
      .toMatchObject({ delayMinutes: 35 });
  });

  it('will not retire a sailing on a flapping AtDock alone', () => {
    const flap = { ...boat, atDock: false, speed: 0.2 };
    expect(catchWindows([sailing], now, undefined, [flap])).toHaveLength(1);
    expect(catchWindows([sailing], now, undefined, [{ ...flap, speed: null }])).toHaveLength(1);
    expect(catchWindows([sailing], now, undefined, [{ ...flap, speed: null, leftDock: '2026-09-01T17:59:00.000Z' }])).toHaveLength(1);
  });

  it('retires a sailing once its boat is confirmed under way', () => {
    expect(catchWindows([sailing], now, undefined, [{ ...boat, atDock: false, speed: 15.2 }])).toEqual([]);
    expect(catchWindows([sailing], now, undefined, [{ ...boat, atDock: false, speed: null, leftDock: '2026-09-01T18:00:30.000Z' }])).toEqual([]);
  });

  it('reads a delay off the boat that is still crossing the other way', () => {
    const inbound = { ...boat, atDock: false, speed: 14, scheduledDeparture: '2026-09-01T17:20:00.000Z', arrivingTerminalId: 3, eta: '2026-09-01T18:12:00.000Z', updatedAt: new Date(now).toISOString() };
    expect(catchWindows([sailing], now, undefined, [inbound])[0]).toMatchObject({
      delayMinutes: 12,
      delaySource: 'projected',
      expectedDepartureAt: '2026-09-01T18:12:00.000Z',
      leaveByAt: '2026-09-01T17:30:00.000Z',
      minutesAway: 30,
      estimatedLeaveByAt: '2026-09-01T17:42:00.000Z',
      estimatedMinutesAway: 42,
    });
    // Its own late departure is added back on to WSDOT's estimate.
    expect(catchWindows([sailing], now, undefined, [{ ...inbound, leftDock: '2026-09-01T17:26:00.000Z', eta: '2026-09-01T18:05:00.000Z' }])[0])
      .toMatchObject({ delayMinutes: 11, expectedDepartureAt: '2026-09-01T18:11:00.000Z' });
    expect(catchWindows([sailing], now, undefined, [{ ...inbound, eta: '2026-09-01T18:01:00.000Z' }])[0])
      .toMatchObject({ delayMinutes: null, delaySource: null });
    expect(catchWindows([sailing], now, undefined, [{ ...inbound, arrivingTerminalId: null }])[0])
      .toMatchObject({ delayMinutes: null });
    expect(catchWindows([sailing], now, undefined, [{ ...inbound, eta: 'not a date' }])[0])
      .toMatchObject({ delayMinutes: null });
    // Past the cap the boat is running a LATER slot, so it lends this one nothing...
    expect(catchWindows([sailing], now, undefined, [{ ...inbound, eta: '2026-09-01T18:20:00.000Z' }])[0])
      .toMatchObject({ delayMinutes: 20, delaySource: 'projected' });
    expect(catchWindows([sailing], now, undefined, [{ ...inbound, eta: '2026-09-01T18:21:00.000Z' }])[0])
      .toMatchObject({ delayMinutes: null, delaySource: null });
    // ...and so cannot keep an hours-dead slot alive on the card.
    expect(catchWindows([sailing], Date.parse('2026-09-01T20:00:00.000Z'), undefined, [{ ...inbound, eta: '2026-09-01T20:30:00.000Z', updatedAt: '2026-09-01T20:00:00.000Z' }])).toEqual([]);
  });

  it('leaves the space label off a boat with no published count', () => {
    expect(catchWindows([{ ...sailing, spaceAvailable: false }], now)[0]).toMatchObject({ spaceLabel: null, spacePercent: null });
  });

  it('opens on the default pad rather than reading an absent key as zero', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    expect(await screen.findByRole('button', { name: 'Catch traffic default' })).toHaveTextContent('15 min');
  });

  it('counts down to the next Bainbridge departure and remembers a changed pad', async () => {
    const departure = (mins: number) => ({
      vesselId: 1, vesselName: 'Tacoma', departingTime: new Date(Date.now() + mins * 60000).toISOString(), arrivingTime: null,
      departingTerminalId: 3, arrivingTerminalId: 7, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null,
      maxSpaceCount: 202, spaceAvailable: true, actualDeparture: null, departureDelayMinutes: null, raw: {},
    });
    let catchRoute = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      if (url.includes('departingTerminalId=3&arrivingTerminalId=7')) {
        catchRoute = url;
        return json([departure(50), departure(110)]);
      }
      return json([]);
    });

    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await user.click(screen.getByRole('tab', { name: 'Catch' }));

    // The seeded favorite route wins even though the selectors sit on Seattle.
    await waitFor(() => expect(catchRoute).toContain('departingTerminalId=3&arrivingTerminalId=7'));
    await waitFor(() => expect(document.querySelector('.countdown-value')).toHaveTextContent('20 min'));
    expect(document.querySelector('.countdown-headline')).toHaveClass('is-clear');
    expect(screen.getByText('176 drive-up / 202', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getAllByTitle('13% of 202 vehicle spaces taken').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.countdown-later .sailing-list li')).toHaveLength(1);

    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Catch traffic default' }));
    await user.click(screen.getByRole('option', { name: '30 min' }));
    await user.click(screen.getByRole('tab', { name: 'Catch' }));
    expect(document.querySelector('.countdown-value')).toHaveTextContent('5 min');
    expect(document.querySelector('.countdown-headline')).toHaveClass('is-soon');
    expect(JSON.parse(localStorage.getItem('ferry-tracker-settings') ?? '{}').catchTrafficMinutes).toBe(30);
  });

  it('flags a boat still sitting at the dock past its departure', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-06T18:06:20.000Z'));
    localStorage.setItem('ferry-tracker-catch-overrides', JSON.stringify({ '3-7': { trafficMinutes: 0, queueMinutes: 15 } }));
    const overdueAt = new Date(Date.now() - 6 * 60000 - 20000).toISOString();
    const tiedUp = [{ ...vessels[0], atDock: true, speed: 0, arrivingTerminalId: 7, scheduledDeparture: overdueAt, updatedAt: new Date(Date.now()).toISOString() }];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(tiedUp);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      if (url.includes('departingTerminalId=3&arrivingTerminalId=7')) {
        return json([{
          vesselId: 1, vesselName: 'Tacoma', departingTime: overdueAt, arrivingTime: null,
          departingTerminalId: 3, arrivingTerminalId: 7, isCancelled: false, driveUpSpaceCount: 176,
          reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, actualDeparture: null,
          departureDelayMinutes: null, raw: {},
        }]);
      }
      return json([]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await userEvent.click(screen.getByRole('tab', { name: 'Catch' }));

    const pill = await waitFor(() => {
      const found = document.querySelector('.countdown-at .delay-pill');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(pill).toHaveTextContent('6 min');
    expect(pill).toHaveAttribute('title', 'Still at the dock 6 minutes after the scheduled departure');
    expect(document.querySelectorAll('.countdown-detail .delay-pill')).toHaveLength(1);
    const scheduled = screen.getByRole('group', { name: 'Scheduled leave by' });
    const estimated = screen.getByRole('group', { name: 'Estimated leave by' });
    expect(scheduled).toHaveClass('is-muted');
    expect(scheduled).toHaveTextContent('0 min');
    expect(scheduled).toHaveTextContent('Queue remaining');
    expect(estimated).toHaveTextContent('0 min');
    expect(estimated).toHaveTextContent('Queue remaining');
    expect(estimated).toHaveClass('is-imminent');
    expect(estimated).toHaveTextContent('Estimated (delay so far)');
    expect(estimated).not.toHaveClass('is-muted');
  });

  it('says so when nothing is catchable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      if (url.includes('/api/history')) return json([]);
      return json([]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await userEvent.click(screen.getByRole('tab', { name: 'Catch' }));

    expect(await screen.findByText('No sailing left today that you can still make.')).toBeInTheDocument();
  });
});

describe('Catch padding overrides', () => {
  const overviewFetch = (departures: (mins: number, from: number, to: number) => unknown) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([
        { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
        { departingTerminalId: 3, departingTerminalName: 'Bainbridge Island', arrivingTerminalId: 7, arrivingTerminalName: 'Seattle' },
      ]);
      if (url.includes('/api/history')) return json([]);
      if (url.includes('departingTerminalId=3&arrivingTerminalId=7')) return json([departures(50, 3, 7)]);
      if (url.includes('departingTerminalId=7&arrivingTerminalId=3')) return json([departures(50, 7, 3)]);
      return json([]);
    });
  };
  const departure = (mins: number, from: number, to: number) => ({
    vesselId: 1, vesselName: 'Tacoma', departingTime: new Date(Date.now() + mins * 60000).toISOString(), arrivingTime: null,
    departingTerminalId: from, arrivingTerminalId: to, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null,
    maxSpaceCount: 202, spaceAvailable: true, actualDeparture: null, departureDelayMinutes: null, raw: {},
  });

  it('falls back to the settings for whichever half is not overridden', () => {
    expect(catchTiming(DEFAULT_SETTINGS)).toEqual({ trafficMinutes: 15, queueMinutes: 15, padMinutes: 30, overridden: false });
    expect(catchTiming(DEFAULT_SETTINGS, { trafficMinutes: null, queueMinutes: null }))
      .toEqual({ trafficMinutes: 15, queueMinutes: 15, padMinutes: 30, overridden: false });
    expect(catchTiming(DEFAULT_SETTINGS, { trafficMinutes: 40, queueMinutes: null }))
      .toEqual({ trafficMinutes: 40, queueMinutes: 15, padMinutes: 55, overridden: true });
    expect(catchTiming(DEFAULT_SETTINGS, { trafficMinutes: null, queueMinutes: 0 }))
      .toEqual({ trafficMinutes: 15, queueMinutes: 0, padMinutes: 15, overridden: true });
  });

  it('stores an override per route and drops it once nothing is overridden', () => {
    const one = setCatchOverride({}, '3-7', { trafficMinutes: 30 });
    expect(one).toEqual({ '3-7': { trafficMinutes: 30, queueMinutes: null } });
    const two = setCatchOverride(one, '7-3', { queueMinutes: 5 });
    expect(two['3-7']).toEqual({ trafficMinutes: 30, queueMinutes: null });
    expect(two['7-3']).toEqual({ trafficMinutes: null, queueMinutes: 5 });
    expect(setCatchOverride(two, '3-7', { trafficMinutes: null })).toEqual({ '7-3': { trafficMinutes: null, queueMinutes: 5 } });
    expect(clearCatchOverride(two, '7-3')).toEqual({ '3-7': { trafficMinutes: 30, queueMinutes: null } });
    expect(clearCatchOverride({}, '3-7')).toEqual({});
  });

  it('drops junk and unlisted minute values when reading storage', () => {
    expect(normalizeCatchOverrides({ '3-7': { trafficMinutes: 7, queueMinutes: 'x' } })).toEqual({});
    expect(normalizeCatchOverrides({ '3-7': { trafficMinutes: 40, queueMinutes: 7 } }))
      .toEqual({ '3-7': { trafficMinutes: 40, queueMinutes: null } });
    expect(normalizeCatchOverrides({ '3-7': null })).toEqual({});
    expect(normalizeCatchOverrides('nope')).toEqual({});
    localStorage.setItem('ferry-tracker-catch-overrides', '{oops');
    expect(loadCatchOverrides()).toEqual({});
  });

  it('overrides the padding from the Catch tab and puts it back on reset', async () => {
    overviewFetch(departure);
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await user.click(screen.getByRole('tab', { name: 'Catch' }));
    await waitFor(() => expect(document.querySelector('.countdown-value')).toHaveTextContent('20 min'));
    expect(screen.queryByRole('button', { name: 'Use settings' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Padding/ }));
    await user.click(screen.getByRole('button', { name: 'Catch traffic' }));
    await user.click(screen.getByRole('option', { name: '30 min' }));

    expect(document.querySelector('.countdown-value')).toHaveTextContent('5 min');
    expect(screen.getByRole('button', { name: /Padding/ })).toHaveTextContent('45 min');
    expect(document.querySelector('.catch-timing-total')).toBeNull();
    expect(within(document.querySelector('.catch-timing') as HTMLElement).getAllByText('45 min')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('ferry-tracker-catch-overrides') ?? '{}'))
      .toEqual({ '3-7': { trafficMinutes: 30, queueMinutes: null } });

    await user.click(screen.getByRole('button', { name: 'Use settings' }));

    expect(document.querySelector('.countdown-value')).toHaveTextContent('20 min');
    expect(screen.getByRole('button', { name: /Padding/ })).toHaveTextContent('30 min');
    expect(within(document.querySelector('.catch-timing') as HTMLElement).getAllByText('30 min')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('ferry-tracker-catch-overrides') ?? '{}')).toEqual({});
  });

  it('collapses the padding controls and flags a route that overrides them', async () => {
    overviewFetch(departure);
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await user.click(screen.getByRole('tab', { name: 'Catch' }));
    await waitFor(() => expect(document.querySelector('.countdown-value')).toHaveTextContent('20 min'));

    const disclosure = screen.getByRole('button', { name: /Padding/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(disclosure).toHaveTextContent('30 min');
    expect(screen.queryByRole('button', { name: 'Catch traffic' })).not.toBeInTheDocument();
    expect(document.querySelector('.catch-timing-custom')).toBeNull();

    await user.click(disclosure);
    expect(localStorage.getItem('ferry-tracker-catch-padding-open')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Catch traffic' }));
    await user.click(screen.getByRole('option', { name: '30 min' }));

    await user.click(disclosure);
    expect(screen.queryByRole('button', { name: 'Catch traffic' })).not.toBeInTheDocument();
    expect(disclosure).toHaveTextContent('45 min');
    expect(document.querySelector('.catch-timing-custom')).toHaveTextContent('Custom');
  });

  it('keeps each favorite route on its own padding', async () => {
    localStorage.setItem('ferry-tracker-catch-overrides', JSON.stringify({ '3-7': { trafficMinutes: 0, queueMinutes: 0 } }));
    overviewFetch(departure);
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    await screen.findByRole('heading', { name: 'Seattle' });
    await user.click(screen.getByRole('tab', { name: 'Catch' }));
    await waitFor(() => expect(document.querySelector('.countdown-value')).toHaveTextContent('50 min'));

    await user.click(within(screen.getByRole('group', { name: 'Catch route' })).getByRole('button', { name: 'SEA → BI' }));

    await waitFor(() => expect(document.querySelector('.countdown-value')).toHaveTextContent('20 min'));
    await user.click(screen.getByRole('button', { name: /Padding/ }));
    expect(screen.getByRole('button', { name: 'Catch traffic' })).toHaveTextContent('15 min');
    expect(screen.queryByRole('button', { name: 'Use settings' })).not.toBeInTheDocument();
  });
});

describe('Routeless tabs', () => {
  it('flags the selection band on every tab that steers no route, so the layout can drop it', async () => {
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
    await screen.findByRole('heading', { name: 'Seattle' });
    expect(document.querySelector('.selection-band')).not.toHaveClass('is-routeless');

    await user.click(screen.getByRole('tab', { name: 'Catch' }));
    expect(document.querySelector('.selection-band')).toHaveClass('is-routeless');

    await user.click(screen.getByRole('tab', { name: 'Disruption' }));
    expect(document.querySelector('.selection-band')).toHaveClass('is-routeless');

    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(document.querySelector('.selection-band')).toHaveClass('is-routeless');

    // Vessels lists everything, so its band goes at every width, not just on a phone.
    await user.click(screen.getByRole('tab', { name: 'Vessels' }));
    expect(document.querySelector('.selection-band')).toHaveClass('is-routeless');

    await user.click(screen.getByRole('tab', { name: 'Sailings' }));
    expect(document.querySelector('.selection-band')).not.toHaveClass('is-routeless');
  });
});

describe('Settings', () => {
  it('keeps a stored value, rejects junk, and never lets red be looser than yellow', () => {
    expect(normalizeSettings({ spaceSoonPercent: 25, spaceImminentPercent: 50 })).toMatchObject({ spaceSoonPercent: 25, spaceImminentPercent: 25 });
    const legacy = normalizeSettings({ catchSoonMinutes: 3, catchImminentMinutes: 10 });
    expect(legacy).toMatchObject({ catchSoonMinutes: 3 });
    expect(legacy).not.toHaveProperty('catchImminentMinutes');
    expect(normalizeSettings({ catchTrafficMinutes: 7 })).toMatchObject({ catchTrafficMinutes: DEFAULT_SETTINGS.catchTrafficMinutes });
    expect(normalizeSettings({ catchTrafficMinutes: '45' })).toMatchObject({ catchTrafficMinutes: DEFAULT_SETTINGS.catchTrafficMinutes });
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ disruptionLeadMinutes: 20 })).toMatchObject({ disruptionLeadMinutes: 20 });
  });

  it('splits an old single pad into traffic with nothing queued', () => {
    expect(normalizeSettings({ catchPadMinutes: 45 })).toMatchObject({ catchTrafficMinutes: 45, catchQueueMinutes: 0 });
    expect(normalizeSettings({ catchPadMinutes: 7 })).toMatchObject(DEFAULT_SETTINGS);
    expect(normalizeSettings({ catchPadMinutes: 45, catchTrafficMinutes: 20, catchQueueMinutes: 10 }))
      .toMatchObject({ catchTrafficMinutes: 20, catchQueueMinutes: 10 });
  });

  it('carries the pad over from the key it used to live in', () => {
    localStorage.setItem('ferry-tracker-catch-pad', '45');
    expect(loadSettings()).toMatchObject({ catchTrafficMinutes: 45, catchQueueMinutes: 0 });
    localStorage.setItem('ferry-tracker-settings', JSON.stringify({ ...DEFAULT_SETTINGS, catchTrafficMinutes: 20 }));
    expect(loadSettings().catchTrafficMinutes).toBe(20);
  });

  it('changes the pad and the space threshold, and persists both', async () => {
    localStorage.setItem('ferry-tracker-settings', JSON.stringify({ catchSoonMinutes: 7, catchImminentMinutes: 5 }));
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
    await screen.findByRole('heading', { name: 'Seattle' });
    await user.click(screen.getByRole('tab', { name: 'Settings' }));

    await user.click(await screen.findByRole('button', { name: 'Catch traffic default' }));
    await user.click(screen.getByRole('option', { name: '45 min' }));
    expect(screen.queryByRole('button', { name: 'Catch red under' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Catch yellow under' })).toHaveTextContent('7 min');
    expect(screen.getByRole('button', { name: 'Space red under' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disruption red under' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Catch yellow under' }));
    await user.click(screen.getByRole('option', { name: '3 min' }));
    await user.click(screen.getByRole('button', { name: 'Space yellow under' }));
    await user.click(screen.getByRole('option', { name: '45%' }));

    const stored = JSON.parse(localStorage.getItem('ferry-tracker-settings') ?? '{}');
    expect(stored).toMatchObject({ catchTrafficMinutes: 45, spaceSoonPercent: 45, catchSoonMinutes: 3 });
    expect(stored).not.toHaveProperty('catchImminentMinutes');
  });

  it('resets every value back to the defaults', async () => {
    localStorage.setItem('ferry-tracker-settings', JSON.stringify({ ...DEFAULT_SETTINGS, catchTrafficMinutes: 60, disruptionLeadMinutes: 25 }));
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
    await screen.findByRole('heading', { name: 'Seattle' });
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByRole('button', { name: 'Catch traffic default' })).toHaveTextContent('60 min');

    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    expect(screen.getByRole('button', { name: 'Catch traffic default' })).toHaveTextContent('15 min');
    expect(JSON.parse(localStorage.getItem('ferry-tracker-settings') ?? '{}')).toEqual(DEFAULT_SETTINGS);
  });
});