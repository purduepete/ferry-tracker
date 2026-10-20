import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    shutdown: undefined as (() => Promise<void>) | undefined,
    closeServer: undefined as (() => void) | undefined,
    listening: undefined as (() => void) | undefined,
    finishCapture: undefined as (() => void) | undefined,
    startCapture: vi.fn(),
    closeDatabase: vi.fn(),
    stopCapture: vi.fn(),
}));
vi.mock('../src/config.js', () => ({
    getConfig: () => ({ capture: { enabled: true }, port: 8787, host: '127.0.0.1' }),
}));
vi.mock('../src/db/database.js', () => ({ openConfiguredDatabase: async () => ({ close: state.closeDatabase }) }));
vi.mock('../src/wsdotClient.js', () => ({ WsdotClient: class {} }));
vi.mock('../src/history/sailingHistory.js', () => ({ DatabaseSailingHistory: class {} }));
vi.mock('../src/capture/captureService.js', () => ({
    CaptureService: class {
        start() {
            state.startCapture();
        }
        stop() {
            state.stopCapture();
            return new Promise<void>((resolve) => {
                state.finishCapture = resolve;
            });
        }
    },
}));
vi.mock('../src/shutdown.js', () => ({
    installShutdown: (shutdown: () => Promise<void>) => {
        state.shutdown = shutdown;
    },
}));
vi.mock('../src/app.js', () => ({
    createApp: () => ({
        listen: (_port: number, _host: string, callback: () => void) => {
            state.listening = callback;
            return {
                close: (callback: () => void) => {
                    state.closeServer = callback;
                },
                closeIdleConnections: vi.fn(),
            };
        },
    }),
}));

it('closes the database only after capture writes and HTTP requests finish', async () => {
    await import('../src/index.js');
    const pending = state.shutdown!();
    expect(state.stopCapture).toHaveBeenCalledTimes(1);
    state.listening!();
    expect(state.startCapture).not.toHaveBeenCalled();
    state.closeServer!();
    await Promise.resolve();
    expect(state.closeDatabase).not.toHaveBeenCalled();
    state.finishCapture!();
    await pending;
    expect(state.closeDatabase).toHaveBeenCalledTimes(1);
});
