import type {
    ApiEnvelope,
    CrossingView,
    NotificationScope,
    NotificationStatus,
    NotificationUpdate,
    SailingView,
    TerminalMateView,
    TerminalView,
    VesselView,
} from '@ferry-tracker/shared';

let reauthenticating = false;

/** Access answers an expired session with an HTML login page, so a reload is what actually reaches it. */
function reauthenticate(): never {
    if (!reauthenticating) {
        reauthenticating = true;
        window.location.reload();
    }
    throw new Error('Your session expired. Reloading to sign in again.');
}

async function request<T>(path: string, init: RequestInit): Promise<ApiEnvelope<T>> {
    const response = await fetch(path, init);
    if (response.status === 401 || response.status === 403) reauthenticate();
    if ((response.headers.get('content-type') ?? '').includes('text/html')) reauthenticate();

    let body: ApiEnvelope<T> | { error: string };
    try {
        body = (await response.json()) as ApiEnvelope<T> | { error: string };
    } catch {
        throw new Error(
            response.ok ? 'The server returned an unreadable response.' : `Request failed with HTTP ${response.status}.`
        );
    }
    if (!response.ok) throw new Error('error' in body ? body.error : `Request failed with HTTP ${response.status}.`);
    return body as ApiEnvelope<T>;
}

function get<T>(path: string, signal?: AbortSignal): Promise<ApiEnvelope<T>> {
    return request<T>(path, { signal });
}

export const ferryApi = {
    notifications: (scope: NotificationScope, signal?: AbortSignal) =>
        get<NotificationStatus>(`/api/notifications?scope=${encodeURIComponent(scope)}`, signal),
    updateNotifications: (update: NotificationUpdate) =>
        request<NotificationStatus>('/api/notifications', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(update),
        }),
    terminals: (signal?: AbortSignal) => get<TerminalView[]>('/api/terminals', signal),
    vessels: (signal?: AbortSignal) => get<VesselView[]>('/api/vessels', signal),
    terminalMates: (signal?: AbortSignal) => get<TerminalMateView[]>('/api/terminal-mates', signal),
    crossings: (signal?: AbortSignal) => get<CrossingView[]>('/api/crossings', signal),
    schedule: (departingId: number, arrivingId: number, signal?: AbortSignal) =>
        get<SailingView[]>(
            `/api/schedule?departingTerminalId=${departingId}&arrivingTerminalId=${arrivingId}&onlyRemaining=false`,
            signal
        ),
    historyDates: (departingId: number, arrivingId: number, signal?: AbortSignal) =>
        get<string[]>(`/api/history/dates?departingTerminalId=${departingId}&arrivingTerminalId=${arrivingId}`, signal),
    historySailings: (departingId: number, arrivingId: number, serviceDate: string, signal?: AbortSignal) =>
        get<SailingView[]>(
            `/api/history/sailings?departingTerminalId=${departingId}&arrivingTerminalId=${arrivingId}&serviceDate=${serviceDate}`,
            signal
        ),
};
