// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { LoadingSpinner } from '../src/components/LoadingSpinner';
import { ThemeProvider } from '../src/theme/ThemeProvider';

afterEach(() => vi.useRealTimers());

async function advance(ms: number) {
    await act(async () => vi.advanceTimersByTimeAsync(ms));
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify({ data, fetchedAt: '2026-09-01T16:00:00.000Z', source: 'fixture', raw: data }), {
        status,
    });
}

const terminals = [7, 3].map((id) => ({
    id,
    name: id === 7 ? 'Seattle' : 'Bainbridge Island',
    subjectName: 'terminal',
    latitude: 47.6,
    longitude: -122.3,
    city: 'Seattle',
    cameras: [],
    alerts: [],
    raw: [],
}));
const mates = [
    { departingTerminalId: 7, arrivingTerminalId: 3 },
    { departingTerminalId: 3, arrivingTerminalId: 7 },
];

function mockApi(
    options: {
        overview?: () => Promise<Response>;
        schedule?: (url: string) => Promise<Response>;
        historyDates?: string[];
        empty?: boolean;
    } = {}
) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = String(input);
        if (url === '/api/terminals')
            return options.overview?.() ?? Promise.resolve(json(options.empty ? [] : terminals));
        if (url === '/api/vessels') return Promise.resolve(json([]));
        if (url === '/api/terminal-mates') return Promise.resolve(json(options.empty ? [] : mates));
        if (url.startsWith('/api/schedule') || url.startsWith('/api/history/sailings'))
            return options.schedule?.(url) ?? Promise.resolve(json([]));
        if (url.startsWith('/api/history/dates')) return Promise.resolve(json(options.historyDates ?? []));
        if (url.startsWith('/api/notifications'))
            return Promise.resolve(json({ available: false, subscription: null }));
        return Promise.resolve(json([]));
    });
}

function renderApp() {
    return render(
        <ThemeProvider>
            <App />
        </ThemeProvider>
    );
}

describe('Delayed spinner', () => {
    it('appears at 250ms and disappears immediately even during its entrance', async () => {
        vi.useFakeTimers();
        const { rerender } = render(<LoadingSpinner isLoading />);
        expect(screen.queryByRole('status')).toBeNull();
        await advance(249);
        expect(screen.queryByRole('status')).toBeNull();
        await advance(1);
        vi.useRealTimers();
        expect(await screen.findByRole('status', { name: 'Loading ferry data' })).toBeInTheDocument();
        rerender(<LoadingSpinner isLoading={false} />);
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('does not flash for fast loads and resets the delay for a new attempt', async () => {
        vi.useFakeTimers();
        const { rerender } = render(<LoadingSpinner isLoading />);
        await advance(200);
        rerender(<LoadingSpinner isLoading={false} />);
        await advance(100);
        expect(screen.queryByRole('status')).toBeNull();
        rerender(<LoadingSpinner isLoading />);
        await advance(249);
        expect(screen.queryByRole('status')).toBeNull();
        await advance(1);
        vi.useRealTimers();
        expect(await screen.findByRole('status')).toBeInTheDocument();
    });

    it('cleans up timers on unmount and tolerates Strict Mode effect replay', async () => {
        vi.useFakeTimers();
        const { unmount } = render(
            <StrictMode>
                <LoadingSpinner isLoading />
            </StrictMode>
        );
        expect(vi.getTimerCount()).toBe(1);
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('Initial ferry loading', () => {
    it('shows fast results without a spinner or initial skeleton', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        mockApi();
        renderApp();
        await waitFor(() => expect(document.querySelector('.view-content')).not.toBeNull());
        expect(screen.queryByRole('status', { name: 'Loading ferry data' })).toBeNull();
        expect(document.querySelector('.initial-loading-cover, .view-loading-cover')).toBeNull();
        expect(document.querySelector('.view-panel')).toHaveClass('is-first-panel');
    });

    it('keeps the threshold continuous across overview and schedule, then removes the spinner immediately', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const overview = deferred<Response>();
        const schedule = deferred<Response>();
        mockApi({ overview: () => overview.promise, schedule: () => schedule.promise });
        renderApp();
        const navigation = screen.getByRole('tablist');
        await advance(200);
        await act(async () => overview.resolve(json(terminals)));
        await advance(50);
        const spinner = await screen.findByRole('status', { name: 'Loading ferry data' });
        expect(document.querySelector('.view-content')).toBeNull();
        await act(async () => schedule.resolve(json([])));
        await waitFor(() => expect(document.querySelector('.view-content')).not.toBeNull());
        expect(spinner).not.toBeInTheDocument();
        expect(screen.getByRole('tablist')).toBe(navigation);
        expect(document.querySelector('.view-loading-cover')).toBeNull();
    });

    it('stops on overview failure and preserves the initial entrance for a slow refresh-button retry', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const retry = deferred<Response>();
        let attempts = 0;
        mockApi({ overview: () => (++attempts === 1 ? Promise.reject(new Error('offline')) : retry.promise) });
        renderApp();
        expect(await screen.findByRole('alert')).toHaveTextContent('offline');
        expect(screen.queryByRole('status', { name: 'Loading ferry data' })).toBeNull();
        expect(document.querySelector('.view-content')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }));
        await advance(250);
        expect(await screen.findByRole('status', { name: 'Loading ferry data' })).toBeInTheDocument();
        await act(async () => retry.resolve(json(terminals)));
        await waitFor(() => expect(document.querySelector('.view-content')).not.toBeNull());
        expect(document.querySelector('.view-panel')).toHaveClass('is-first-panel');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('reveals usable overview data on schedule failure and does not replay the entrance on retry or tab changes', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let attempts = 0;
        mockApi({
            schedule: () =>
                ++attempts === 1 ? Promise.reject(new Error('schedule offline')) : Promise.resolve(json([])),
        });
        renderApp();
        expect(await screen.findByRole('alert')).toHaveTextContent('schedule offline');
        await waitFor(() => expect(document.querySelector('.view-content')).not.toBeNull());
        const content = document.querySelector('.view-content');
        fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }));
        await advance(600);
        expect(document.querySelector('.view-content')).toBe(content);
        expect(screen.queryByRole('status', { name: 'Loading ferry data' })).toBeNull();
        fireEvent.click(screen.getByRole('tab', { name: 'Vessels' }));
        expect(document.querySelector('.view-panel')).not.toHaveClass('is-first-panel');
        fireEvent.click(screen.getByRole('tab', { name: 'Sailings' }));
        expect(document.querySelector('.view-content')).toBe(content);
        expect(document.querySelector('.view-panel')).not.toHaveClass('is-first-panel');
    });

    it('reveals an empty overview without waiting for a schedule', async () => {
        mockApi({ empty: true });
        renderApp();
        await waitFor(() => expect(document.querySelector('.view-content')).not.toBeNull());
        expect(screen.queryByRole('status', { name: 'Loading ferry data' })).toBeNull();
    });

    it('ignores a superseded initial route response until the current route settles', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const first = deferred<Response>();
        const second = deferred<Response>();
        const fetch = mockApi({
            schedule: (url) => (url.includes('departingTerminalId=7') ? first.promise : second.promise),
        });
        renderApp();
        await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/schedule'))).toBe(true));
        fireEvent.click(screen.getByRole('button', { name: 'Reverse route' }));
        await act(async () => first.resolve(json([])));
        await advance(250);
        expect(await screen.findByRole('status', { name: 'Loading ferry data' })).toBeInTheDocument();
        expect(document.querySelector('.view-content')).toBeNull();
        await act(async () => second.resolve(json([])));
        await waitFor(() => expect(document.querySelector('.view-content')).not.toBeNull());
        expect(document.querySelector('.schedule-node h2')).toHaveTextContent('Bainbridge Island to Seattle');
    });

    it('waits for the selected date when Historical is opened before the first schedule settles', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const live = deferred<Response>();
        const recorded = deferred<Response>();
        const fetch = mockApi({
            historyDates: ['2026-08-31'],
            schedule: (url) => (url.startsWith('/api/history/sailings') ? recorded.promise : live.promise),
        });
        renderApp();
        await waitFor(() =>
            expect(fetch.mock.calls.some(([url]) => String(url).startsWith('/api/history/dates'))).toBe(true)
        );
        await advance(0);
        fireEvent.click(screen.getByRole('tab', { name: 'Historical' }));
        await waitFor(() =>
            expect(fetch.mock.calls.some(([url]) => String(url).includes('serviceDate=2026-08-31'))).toBe(true)
        );
        await act(async () => live.resolve(json([])));
        await advance(250);
        expect(await screen.findByRole('status', { name: 'Loading ferry data' })).toBeInTheDocument();
        expect(document.querySelector('.view-content')).toBeNull();
        await act(async () => recorded.resolve(json([])));
        await waitFor(() => expect(document.querySelector('.view-content')).not.toBeNull());
        expect(screen.getByRole('tab', { name: 'Historical' })).toHaveAttribute('aria-selected', 'true');
    });
});
