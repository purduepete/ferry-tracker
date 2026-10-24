import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
});

it('starts notifications without awaiting capture and drains both before closing shared storage', async () => {
    let shutdown!: () => Promise<void>;
    let captureDrain!: () => void;
    let notificationDrain!: () => void;
    const capturePending = new Promise<void>((resolve) => {
        captureDrain = resolve;
    });
    const notificationPending = new Promise<void>((resolve) => {
        notificationDrain = resolve;
    });
    const capture = { start: vi.fn(() => capturePending), stop: vi.fn(() => capturePending) };
    const monitor = { start: vi.fn(), stop: vi.fn(() => notificationPending) };
    const db = { close: vi.fn(async () => undefined) };
    const service = {};
    vi.doMock('../src/config.js', () => ({
        getConfig: () => ({
            capture: { enabled: true, dbPath: ':memory:' },
            dataSource: 'fixture',
            notifications: { appToken: 'test-token', userKey: 'test-user' },
            host: '127.0.0.1',
            port: 0,
        }),
    }));
    vi.doMock('../src/db/database.js', () => ({ openConfiguredDatabase: async () => db }));
    vi.doMock('../src/capture/captureService.js', () => ({
        CaptureService: class {
            constructor() {
                return capture;
            }
        },
    }));
    vi.doMock('../src/history/sailingHistory.js', () => ({ DatabaseSailingHistory: class {} }));
    vi.doMock('../src/wsdotClient.js', () => ({ WsdotClient: class {} }));
    vi.doMock('../src/ferryDataService.js', () => ({
        FerryDataService: class {
            constructor() {
                return service;
            }
        },
    }));
    vi.doMock('../src/notifications/api.js', () => ({ notificationsConfigured: () => true }));
    vi.doMock('../src/notifications/store.js', () => ({ NotificationStore: class {} }));
    vi.doMock('../src/notifications/pushover.js', () => ({ PushoverSender: class {} }));
    vi.doMock('../src/notifications/monitor.js', () => ({
        NotificationMonitor: class {
            constructor() {
                return monitor;
            }
        },
    }));
    const createApp = vi.fn(() => ({
        listen: (_port: number, _host: string, ready: () => void) => {
            ready();
            return { close: (done: () => void) => done(), closeIdleConnections: vi.fn() };
        },
    }));
    vi.doMock('../src/app.js', () => ({ createApp }));
    vi.doMock('../src/shutdown.js', () => ({
        installShutdown: (handler: () => Promise<void>) => {
            shutdown = handler;
        },
    }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await import('../src/index.js');
    expect(capture.start).toHaveBeenCalledOnce();
    expect(monitor.start).toHaveBeenCalledOnce();
    expect(createApp.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ service })]));
    const stopped = shutdown();
    await Promise.resolve();
    expect(db.close).not.toHaveBeenCalled();
    captureDrain();
    await Promise.resolve();
    expect(db.close).not.toHaveBeenCalled();
    notificationDrain();
    await stopped;
    expect(db.close).toHaveBeenCalledOnce();
});
