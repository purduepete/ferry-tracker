// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const terminals = [
  { id: 7, name: 'Seattle', subjectName: 'seattle', latitude: 47.6, longitude: -122.3, city: 'Seattle', cameras: [], alerts: [], raw: [] },
  { id: 3, name: 'Bainbridge Island', subjectName: 'bainbridge', latitude: 47.62, longitude: -122.5, city: 'Bainbridge Island', cameras: [], alerts: [], raw: [] },
];
const vessels = [{
  id: 1, name: 'Tacoma', vesselClass: 'Jumbo Mark II', departingTerminalId: 7, arrivingTerminalId: 3,
  departingTerminalName: 'Seattle', arrivingTerminalName: 'Bainbridge Island', latitude: 47.61, longitude: -122.4,
  speed: 15, heading: 278, inService: true, atDock: false, scheduledDeparture: null, updatedAt: '2026-09-01T16:30:00.000Z', raw: [],
}];
const sailings = [{ vesselId: 1, vesselName: 'Tacoma', departingTime: '2026-09-01T17:00:00.000Z', arrivingTime: '2026-09-01T17:35:00.000Z', departingTerminalId: 7, arrivingTerminalId: 3, isCancelled: false, driveUpSpaceCount: 176, reservableSpaceCount: null, maxSpaceCount: 202, spaceAvailable: true, raw: {} }];

function json(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, fetchedAt: '2026-09-01T16:00:00.000Z', source: 'fixture', raw: data })));
}

// jsdom serves document.hidden from the prototype, so an own property shadows it until deleted.
let hidden = false;
async function setHidden(value: boolean) {
  hidden = value;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

// Two scopes on purpose: the second lets the schedule's minimum-skeleton timer settle and
// commit, so the next interval does not find the in-flight guard still raised.
async function advanceOnePoll() {
  await advance(60_000);
  await advance(2_000);
}

// Returns the number of completed overview fetches, which is what the header timestamp tracks.
function mockFerryApi(options: { failAfterFirstLoad?: boolean } = {}) {
  const counts = { overview: 0 };
  let loaded = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (options.failAfterFirstLoad && loaded) return Promise.reject(new Error('offline'));
    if (url.includes('/api/terminals')) {
      counts.overview += 1;
      return json(terminals);
    }
    if (url.includes('/api/vessels')) return json(vessels);
    if (url.includes('/api/terminal-mates')) return json([
      { departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' },
      { departingTerminalId: 3, departingTerminalName: 'Bainbridge Island', arrivingTerminalId: 7, arrivingTerminalName: 'Seattle' },
    ]);
    if (url.includes('/api/history')) return json([]);
    loaded = true;
    return json(sailings);
  });
  return counts;
}

async function renderLoaded(options?: { failAfterFirstLoad?: boolean }) {
  const counts = mockFerryApi(options);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<ThemeProvider><App /></ThemeProvider>);
  await waitFor(() => expect(document.querySelector('.refresh-time')).not.toBeNull());
  // The schedule holds a minimum-skeleton timer; let it settle so the in-flight guard clears.
  await advance(2_000);
  return counts;
}

afterEach(() => {
  vi.useRealTimers();
  hidden = false;
  delete (document as Partial<Document>).hidden;
});

describe('Background refresh', () => {
  it('refetches the overview every minute while Sailings is open', async () => {
    const counts = await renderLoaded();
    expect(counts.overview).toBe(1);

    await advanceOnePoll();
    expect(counts.overview).toBe(2);

    await advanceOnePoll();
    expect(counts.overview).toBe(3);
  });

  it('stops polling while the tab is hidden and refreshes once on return', async () => {
    const counts = await renderLoaded();
    const atHide = counts.overview;

    await setHidden(true);
    await advance(180_000);
    expect(counts.overview).toBe(atHide);

    await setHidden(false);
    await waitFor(() => expect(counts.overview).toBe(atHide + 1));
  });

  it('ignores a hide and show bounce that lands on data seconds old', async () => {
    const counts = await renderLoaded();
    const atHide = counts.overview;

    await setHidden(true);
    await advance(3_000);
    await setHidden(false);
    await advance(1_000);
    expect(counts.overview).toBe(atHide);
  });
});

describe('Stale refresh cue', () => {
  it('leaves the timestamp unmarked right after a successful load', async () => {
    await renderLoaded();
    expect(document.querySelector('.refresh-time')).not.toHaveClass('is-stale');
  });

  it('marks the timestamp once five minutes pass with no successful refresh', async () => {
    await renderLoaded({ failAfterFirstLoad: true });
    expect(document.querySelector('.refresh-time')).not.toHaveClass('is-stale');

    // The cue rides a 30s ticker, so it lands on the first tick past the five-minute mark.
    await advance(360_000);
    await waitFor(() => expect(document.querySelector('.refresh-time')).toHaveClass('is-stale'));
    expect(screen.getByTitle(/Data may be out of date/)).toBeInTheDocument();
  });
});
