// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const terminals = [
  { id: 7, name: 'Seattle', subjectName: 'seattle', latitude: 47.6, longitude: -122.3, city: 'Seattle', raw: [] },
  { id: 3, name: 'Bainbridge Island', subjectName: 'bainbridge', latitude: 47.62, longitude: -122.5, city: 'Bainbridge Island', raw: [] },
];
const vessels = [{
  id: 1, name: 'Tacoma', vesselClass: 'Jumbo Mark II', departingTerminalId: 7, arrivingTerminalId: 3,
  departingTerminalName: 'Seattle', arrivingTerminalName: 'Bainbridge Island', latitude: 47.61, longitude: -122.4,
  speed: 15, heading: 278, inService: true, atDock: false, scheduledDeparture: null, updatedAt: null, raw: [],
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
      scheduleCalls += 1;
      return json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
  expect(screen.getByRole('status', { name: 'Loading ferry data' })).toBeInTheDocument();
  expect(document.querySelector('.spin')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Seattle' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tacoma' })).toBeInTheDocument();
    expect(screen.getByText(/Seattle to Bainbridge Island/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/VesselID 1/)).toBeInTheDocument());
    expect(await screen.findByText(/176 drive-up of 202 spaces/)).toBeInTheDocument();
    expect(screen.getByText('Past 2 hours · Next 12 hours')).toBeInTheDocument();
    expect(screen.queryByText('Current vehicle-space reports')).not.toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-09-01T16:00:00.000Z"]')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Reverse route' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Terminal' })).toHaveTextContent('Bainbridge Island · 3'));
    expect(screen.getByRole('button', { name: 'Associated destination' })).toHaveTextContent('Seattle · 7');
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false'));

    const callsBeforeRefresh = scheduleCalls;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh data' }));
    await waitFor(() => expect(scheduleCalls).toBeGreaterThan(callsBeforeRefresh));

    await userEvent.click(screen.getByRole('tab', { name: 'Raw JSON' }));
    expect(screen.getByText('WSDOT response JSON')).toBeInTheDocument();
  });

  it('moves and selects tabs with arrow keys', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/terminals')) return json(terminals);
      if (url.includes('/api/vessels')) return json(vessels);
      if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
      return json([]);
    });

    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);
    const relationship = await screen.findByRole('tab', { name: 'Relationship' });
    relationship.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Terminals' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Terminals' })).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Raw JSON' })).toHaveFocus();
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
      scheduleCalls += 1;
      if (scheduleCalls > 1) return changedRouteResponse;
      return json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]);
    });

    render(<ThemeProvider><App /></ThemeProvider>);
    expect(await screen.findByText(/176 drive-up of 202 spaces/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reverse route' }));

    expect(screen.getByText(/176 drive-up of 202 spaces/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading updated ferry data' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'true');

    resolveChangedRoute(await json([{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T18:00:00.000Z', arrivingTime: '2026-09-01T18:35:00.000Z', departingTerminalId: 3, arrivingTerminalId: 7, isCancelled: false, driveUpSpaceCount: 95, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }]));
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByText(/95 drive-up of 202 spaces/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading updated ferry data' })).not.toBeInTheDocument());
  });
});