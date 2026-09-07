// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { DEFAULT_SETTINGS, disruptionWaves } from '../src/format';

const now = Date.parse('2026-09-07T17:00:00.000Z');
const schedule = [{ vesselId: null, vesselName: null, actualArrival: null, departingTime: '2026-09-07T17:20:00.000Z', arrivingTime: null, departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false }];

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => vi.restoreAllMocks());

function mockFeed(failSchedule = false, sailings = schedule) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/api/schedule') && failSchedule) throw new Error('Unavailable');
    const data = url.includes('/api/terminals')
      ? [{ id: 7, name: 'Seattle', raw: [] }, { id: 3, name: 'Bainbridge Island', raw: [] }]
      : url.includes('/api/terminal-mates')
        ? [{ departingTerminalId: 7, arrivingTerminalId: 3 }]
        : url.includes('/api/schedule') ? sailings : [];
    return new Response(JSON.stringify({ data, source: 'fixture', fetchedAt: new Date(now).toISOString() }), { status: 200 });
  });
}

it('shows a labelled scheduled countdown without any live vessels', async () => {
  mockFeed();
  render(<ThemeProvider><App /></ThemeProvider>);
  await screen.findByRole('tab', { name: 'Disruption' });
  fireEvent.click(screen.getByRole('tab', { name: 'Disruption' }));
  expect(await screen.findByText('Scheduled estimate')).toBeInTheDocument();
  expect(document.querySelector('.countdown-value')).toHaveTextContent('65 min');
  expect(screen.getByText('Ferry')).toBeInTheDocument();
  expect(document.querySelector('.countdown-detail .capacity-pill')).toBeNull();
});

it('reports schedule failure and recovers on refresh', async () => {
  mockFeed(true);
  render(<ThemeProvider><App /></ThemeProvider>);
  await screen.findByRole('tab', { name: 'Disruption' });
  fireEvent.click(screen.getByRole('tab', { name: 'Disruption' }));
  expect(await screen.findByText('Schedule unavailable. Retrying on the next refresh.')).toBeInTheDocument();
  mockFeed();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh data' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }));
  expect(await screen.findByText('Scheduled estimate')).toBeInTheDocument();
  expect(screen.queryByText('Schedule unavailable. Retrying on the next refresh.')).not.toBeInTheDocument();
});

const at = (time: string) => `2026-09-07T${time}-07:00`;
const sailing = {
  vesselId: 18, vesselName: 'Tacoma', actualArrival: null,
  departingTime: at('10:20:00'), arrivingTime: null,
  departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false,
};
const vessel = {
  id: 18, name: 'Tacoma', departingTerminalId: 7, arrivingTerminalId: 3, atDock: false,
  eta: at('11:10:00'), leftDock: null, scheduledDeparture: sailing.departingTime,
};

describe('Disruption schedule fallback', () => {
  it.each([null, 19])('replaces a unique scheduled slot assigned to %s with its live vessel', (vesselId) => {
    const waves = disruptionWaves([vessel], now, DEFAULT_SETTINGS, [{ ...sailing, vesselId }]);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toMatchObject({ source: 'live', vesselId: 18, minutesAway: 80, ongoing: false });
  });

  it('keeps a nearby distinct slot despite a matching vessel or unassigned schedule', () => {
    for (const vesselId of [18, null, 19]) {
      const later = { ...sailing, vesselId, departingTime: at('10:30:00') };
      const waves = disruptionWaves([vessel], now, DEFAULT_SETTINGS, [sailing, later]);
      expect(waves).toHaveLength(2);
      expect(waves.filter((wave) => wave.source === 'schedule')[0].landingAt).toBe(new Date(at('11:05:00')).toISOString());
    }
  });

  it('does not infer a substitution without a matching origin or a unique slot', () => {
    const unassigned = { ...sailing, vesselId: null };
    for (const departingTerminalId of [undefined, 99]) {
      expect(disruptionWaves([{ ...vessel, departingTerminalId }], now, DEFAULT_SETTINGS, [unassigned])).toHaveLength(2);
    }
    const ambiguous = [unassigned, { ...sailing, vesselId: 19 }];
    expect(disruptionWaves([vessel], now, DEFAULT_SETTINGS, ambiguous).filter((wave) => wave.source === 'schedule')).toHaveLength(2);
  });

  it('does not replace an unassigned slot using proximity when the live departure is missing', () => {
    expect(disruptionWaves([{ ...vessel, scheduledDeparture: null }], now, DEFAULT_SETTINGS, [{ ...sailing, vesselId: null }])).toHaveLength(2);
  });

  it('uses departure plus 35 minutes when no boat is sailing and arrival is unpublished', () => {
    expect(disruptionWaves([], now, DEFAULT_SETTINGS, [sailing])[0]).toMatchObject({
      source: 'schedule', landingAt: new Date(at('10:55:00')).toISOString(), minutesAway: 65,
    });
    expect(disruptionWaves([{ ...vessel, atDock: true }], now, DEFAULT_SETTINGS, [sailing])).toHaveLength(1);
  });

  it('prefers a published arrival and respects lead and duration settings', () => {
    const settings = { ...DEFAULT_SETTINGS, disruptionLeadMinutes: 5, disruptionDurationMinutes: 20 };
    expect(disruptionWaves([], now, settings, [{ ...sailing, arrivingTime: at('11:00:00') }])[0]).toMatchObject({
      landingAt: new Date(at('11:00:00')).toISOString(), disruptionAt: new Date(at('11:05:00')).toISOString(),
      clearsAt: new Date(at('11:25:00')).toISOString(),
    });
  });

  it('uses live ETA for its own slot without hiding a later trip by the same vessel', () => {
    const later = { ...sailing, departingTime: at('12:00:00') };
    const waves = disruptionWaves([vessel], now, DEFAULT_SETTINGS, [sailing, later]);
    expect(waves.map((wave) => wave.source)).toEqual(['live', 'schedule']);
    expect(waves[0].landingAt).toBe(new Date(vessel.eta).toISOString());
  });

  it('prefers observed arrival and never revives its cleared scheduled wave', () => {
    const landed = { ...sailing, actualArrival: at('09:50:00') };
    expect(disruptionWaves([], now, DEFAULT_SETTINGS, [landed])[0]).toMatchObject({ source: 'observed', active: true });
    expect(disruptionWaves([], Date.parse(at('10:15:00')), DEFAULT_SETTINGS, [landed])).toEqual([]);
  });

  it('skips cancelled, wrong-route and invalid departures but allows unassigned vessels', () => {
    expect(disruptionWaves([], now, DEFAULT_SETTINGS, [
      { ...sailing, isCancelled: true }, { ...sailing, arrivingTerminalId: 7 },
      { ...sailing, departingTime: 'invalid' },
    ])).toEqual([]);
    expect(disruptionWaves([], now, DEFAULT_SETTINGS, [{ ...sailing, vesselId: null, vesselName: null }])[0])
      .toMatchObject({ vesselId: null, vesselName: 'Ferry', source: 'schedule' });
  });

  it('advances to the next scheduled disruption at the exact clearing time', () => {
    const later = { ...sailing, departingTime: at('12:00:00') };
    const clears = Date.parse(at('11:20:00'));
    expect(disruptionWaves([], clears - 1, DEFAULT_SETTINGS, [sailing, later])).toHaveLength(2);
    expect(disruptionWaves([], clears, DEFAULT_SETTINGS, [sailing, later])).toHaveLength(1);
  });

  it('uses a next-day sailing across midnight without repeating yesterday', () => {
    const tomorrow = { ...sailing, departingTime: '2026-09-08T05:30:00-07:00' };
    expect(disruptionWaves([], Date.parse(at('23:50:43')), DEFAULT_SETTINGS, [sailing, tomorrow])[0]).toMatchObject({
      source: 'schedule', minutesAway: 385, landingAt: '2026-09-08T13:05:00.000Z',
    });
  });
});

it('shows only the first four later disruptions in chronological order', async () => {
  const sailings = Array.from({ length: 7 }, (_, index) => ({
    ...schedule[0], departingTime: new Date(Date.parse(schedule[0].departingTime) + index * 3600000).toISOString(),
  })).reverse();
  mockFeed(false, sailings);
  render(<ThemeProvider><App /></ThemeProvider>);
  fireEvent.click(await screen.findByRole('tab', { name: 'Disruption' }));
  await screen.findByText('Scheduled estimate');
  const later = document.querySelectorAll('.countdown-later li');
  expect(later).toHaveLength(4);
  expect([...later].map((entry) => entry.querySelector('.capacity-pill')?.textContent))
    .toEqual(['125 min', '185 min', '245 min', '305 min']);
});