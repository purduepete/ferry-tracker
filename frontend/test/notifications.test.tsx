// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    NotificationScope,
    NotificationSettings,
    NotificationStatus,
    NotificationUpdate,
} from '@ferry-tracker/shared';
import { ferryApi } from '../src/api';
import { NotificationControl } from '../src/components/NotificationControl';
import { useNotifications } from '../src/useNotifications';

const timing = { trafficMinutes: 15, queueMinutes: 15 };
const envelope = (data: NotificationStatus) => ({
    data,
    source: 'fixture' as const,
    fetchedAt: '2026-10-24T16:00:00.000Z',
    raw: null,
});
const stored = (
    scope: NotificationScope,
    settings: NotificationSettings = timing,
    enabled = true
): NotificationStatus => ({
    available: true,
    subscription: { scope, enabled, settings, status: 'armed', targetAt: null, lastEventAt: null, lastError: null },
});

function Harness({
    scope = 'catch:3:7',
    settings = timing,
}: {
    scope?: NotificationScope;
    settings?: NotificationSettings;
}) {
    const notifications = useNotifications(scope, settings);
    return <NotificationControl notifications={notifications} kind={scope === 'disruption' ? 'disruption' : 'catch'} />;
}

beforeEach(() => {
    vi.spyOn(ferryApi, 'notifications').mockImplementation(async (scope) => envelope(stored(scope, timing, false)));
    vi.spyOn(ferryApi, 'updateNotifications').mockImplementation(async (update) =>
        envelope(stored(update.scope, update.settings, update.enabled))
    );
});

describe('server-backed Pushover controls', () => {
    it('confirms the opt-in on the server before checking the box', async () => {
        let confirm!: (value: ReturnType<typeof envelope>) => void;
        vi.mocked(ferryApi.updateNotifications).mockImplementation(() => new Promise((resolve) => (confirm = resolve)));
        render(<Harness />);
        const checkbox = await screen.findByRole('checkbox', { name: 'Notify via Pushover' });
        await waitFor(() => expect(checkbox).toBeEnabled());
        fireEvent.click(checkbox);
        expect(checkbox).not.toBeChecked();
        expect(checkbox).toBeDisabled();
        expect(ferryApi.updateNotifications).toHaveBeenCalledWith({
            scope: 'catch:3:7',
            enabled: true,
            settings: timing,
        });
        vi.mocked(ferryApi.notifications).mockResolvedValue(envelope(stored('catch:3:7')));
        await act(async () => confirm(envelope(stored('catch:3:7'))));
        expect(checkbox).toBeChecked();
        expect(screen.getByRole('status')).toHaveTextContent('including when this page is closed');
    });

    it('keeps credentials out of the UI and disables the control when unavailable', async () => {
        vi.mocked(ferryApi.notifications).mockResolvedValue(envelope({ available: false, subscription: null }));
        render(<Harness scope="disruption" />);
        await screen.findByText(/Configure the server credentials/);
        expect(screen.getByRole('checkbox')).toBeDisabled();
        expect(screen.getByText(/traffic starts and clears/)).toBeInTheDocument();
        expect(document.querySelector('input[type="password"], select, datalist')).toBeNull();
    });

    it('shows a save failure without pretending the subscription was enabled', async () => {
        vi.mocked(ferryApi.updateNotifications).mockRejectedValue(
            new Error('Unable to save notification preferences.')
        );
        render(<Harness />);
        const checkbox = screen.getByRole('checkbox');
        await waitFor(() => expect(checkbox).toBeEnabled());
        fireEvent.click(checkbox);
        await screen.findByText('Unable to save notification preferences.');
        expect(checkbox).not.toBeChecked();
        expect(checkbox).toBeEnabled();
    });

    it('keeps each route separate and ignores a late response from the old route', async () => {
        let oldResponse!: (value: ReturnType<typeof envelope>) => void;
        vi.mocked(ferryApi.notifications).mockImplementation((scope) =>
            scope === 'catch:3:7'
                ? new Promise((resolve) => (oldResponse = resolve))
                : Promise.resolve(envelope(stored(scope, timing, false)))
        );
        const { rerender } = render(<Harness />);
        rerender(<Harness scope="catch:7:3" />);
        await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled());
        await act(async () => oldResponse(envelope(stored('catch:3:7'))));
        expect(screen.getByRole('checkbox')).not.toBeChecked();
        fireEvent.click(screen.getByRole('checkbox'));
        await waitFor(() =>
            expect(ferryApi.updateNotifications).toHaveBeenCalledWith({
                scope: 'catch:7:3',
                enabled: true,
                settings: timing,
            })
        );
    });

    it('syncs explicit padding changes while enabled without overwriting saved settings on first load', async () => {
        vi.mocked(ferryApi.notifications).mockResolvedValue(
            envelope(stored('catch:3:7', { trafficMinutes: 30, queueMinutes: 10 }))
        );
        const { rerender } = render(<Harness />);
        await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
        expect(ferryApi.updateNotifications).not.toHaveBeenCalled();
        rerender(<Harness settings={{ trafficMinutes: 20, queueMinutes: 15 }} />);
        await waitFor(() =>
            expect(ferryApi.updateNotifications).toHaveBeenCalledWith({
                scope: 'catch:3:7',
                enabled: true,
                settings: { trafficMinutes: 20, queueMinutes: 15 },
            })
        );
    });

    it('uses the latest padding if it changes during a save', async () => {
        let confirm!: (value: ReturnType<typeof envelope>) => void;
        const updates: NotificationUpdate[] = [];
        vi.mocked(ferryApi.updateNotifications).mockImplementation((update) => {
            updates.push(update);
            if (updates.length === 1) return new Promise((resolve) => (confirm = resolve));
            return Promise.resolve(envelope(stored(update.scope, update.settings, update.enabled)));
        });
        vi.mocked(ferryApi.notifications).mockResolvedValue(envelope(stored('catch:3:7')));
        const { rerender } = render(<Harness />);
        await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
        rerender(<Harness settings={{ trafficMinutes: 20, queueMinutes: 15 }} />);
        await waitFor(() => expect(updates).toHaveLength(1));
        rerender(<Harness settings={{ trafficMinutes: 30, queueMinutes: 15 }} />);
        await act(async () => confirm(envelope(stored('catch:3:7', updates[0].settings))));
        await waitFor(() => expect(updates).toHaveLength(2));
        expect(updates[1].settings).toEqual({ trafficMinutes: 30, queueMinutes: 15 });
    });

    it('refreshes checkbox truth when another browser changes the subscription', async () => {
        vi.useFakeTimers();
        try {
            render(<Harness />);
            await act(async () => {
                await Promise.resolve();
            });
            expect(screen.getByRole('checkbox')).not.toBeChecked();
            vi.mocked(ferryApi.notifications).mockResolvedValue(envelope(stored('catch:3:7')));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(30_000);
            });
            expect(screen.getByRole('checkbox')).toBeChecked();
            expect(ferryApi.updateNotifications).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
