import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationScope, NotificationSettings, NotificationStatus } from '@ferry-tracker/shared';
import { ferryApi } from './api';

const STATUS_REFRESH_MS = 30_000;

export function useNotifications(scope: NotificationScope | null, settings: NotificationSettings) {
    const settingsJson = JSON.stringify(settings);
    const [result, setResult] = useState<{ scope: string; data: NotificationStatus } | null>(null);
    const [error, setError] = useState<{ scope: string; message: string; kind: 'load' | 'save' } | null>(null);
    const [busyScope, setBusyScope] = useState<string | null>(null);
    const currentScope = useRef(scope);
    const requestVersion = useRef(0);
    const pending = useRef(false);
    const previousSettings = useRef({ scope, json: settingsJson });
    const latestSettings = useRef(settings);
    const dirtySettings = useRef(false);
    currentScope.current = scope;
    latestSettings.current = settings;

    const save = useCallback(
        async (enabled: boolean) => {
            if (scope === null || pending.current) return;
            pending.current = true;
            const version = ++requestVersion.current;
            setBusyScope(scope);
            try {
                const response = await ferryApi.updateNotifications({
                    scope,
                    enabled,
                    settings: latestSettings.current,
                });
                if (currentScope.current !== scope || requestVersion.current !== version) return;
                dirtySettings.current = previousSettings.current.json !== settingsJson;
                setResult({ scope, data: response.data });
                setError(null);
            } catch (cause) {
                if (currentScope.current === scope) {
                    dirtySettings.current = false;
                    setError({
                        scope,
                        kind: 'save',
                        message: cause instanceof Error ? cause.message : 'Unable to save notification preferences.',
                    });
                }
            } finally {
                pending.current = false;
                setBusyScope(null);
            }
        },
        [scope, settingsJson]
    );

    useEffect(() => {
        if (scope === null) return;
        const controller = new AbortController();
        let active = true;
        const load = async () => {
            if (pending.current) return;
            const version = requestVersion.current;
            try {
                const response = await ferryApi.notifications(scope, controller.signal);
                if (!active || pending.current || version !== requestVersion.current) return;
                setResult({ scope, data: response.data });
                setError((current) => (current?.scope === scope && current.kind === 'save' ? current : null));
            } catch (cause) {
                if (!active) return;
                setError({
                    scope,
                    kind: 'load',
                    message: cause instanceof Error ? cause.message : 'Unable to load notification preferences.',
                });
            }
        };
        void load();
        const timer = window.setInterval(() => void load(), STATUS_REFRESH_MS);
        return () => {
            active = false;
            controller.abort();
            window.clearInterval(timer);
        };
    }, [scope, busyScope]);

    const data = result?.scope === scope ? result.data : null;
    const enabled = data?.subscription?.enabled === true;
    const busy = busyScope !== null;

    useEffect(() => {
        const previous = previousSettings.current;
        if (previous.scope !== scope) {
            dirtySettings.current = false;
        } else if (previous.json !== settingsJson) {
            dirtySettings.current = true;
        }
        previousSettings.current = { scope, json: settingsJson };
        if (dirtySettings.current && enabled && !busy) void save(true);
    }, [scope, settingsJson, enabled, busy, save]);

    return {
        enabled,
        disabled: scope === null || !data?.available || busy,
        loading: scope !== null && data === null && error?.scope !== scope,
        busy,
        available: data?.available === true,
        error: error?.scope === scope ? error.message : (data?.subscription?.lastError ?? null),
        uncertain: data?.subscription?.status === 'uncertain',
        setEnabled: (value: boolean) => void save(value),
    };
}
