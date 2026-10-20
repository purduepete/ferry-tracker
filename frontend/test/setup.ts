import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// The deploy box runs the suite while it is also building, and the 1s default lets a first
// render lose the race on hardware that is merely slow.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no scrollIntoView; the sailing-row -> Vessels highlight effect calls it.
if (typeof window !== 'undefined' && !window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = () => {};
}

// jsdom's window.scrollTo exists but logs a "Not implemented" jsdomError; the tab-change
// effect calls it on every render, so stub it to a no-op rather than let every test log it.
if (typeof window !== 'undefined') {
    window.scrollTo = () => {};
}

if (typeof window !== 'undefined') {
    beforeEach(() => {
        const storage = new Map<string, string>();
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                clear: () => storage.clear(),
                getItem: (key: string) => storage.get(key) ?? null,
                removeItem: (key: string) => storage.delete(key),
                setItem: (key: string, value: string) => storage.set(key, value),
            },
        });
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            writable: true,
            value: vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
        });
    });

    afterEach(() => {
        cleanup();
        globalThis.localStorage?.clear();
        vi.restoreAllMocks();
    });
}
