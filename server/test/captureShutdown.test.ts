import { afterEach, expect, it, vi } from 'vitest';
import { CaptureService, type TaskOutcome } from '../src/capture/captureService.js';
import type { AppConfig } from '../src/config.js';
import type { Db } from '../src/db/database.js';
import type { WsdotClient } from '../src/wsdotClient.js';

afterEach(() => vi.useRealTimers());

it('drains every in-flight capture before stop completes and never reschedules it', async () => {
    vi.useFakeTimers();
    const prepare = vi.fn(() => {
        throw new Error('Unexpected database access');
    });
    const service = new CaptureService(
        { prepare } as unknown as Db,
        {} as WsdotClient,
        {
            dataSource: 'live',
            secrets: [],
            capture: {
                rawArchiveDir: 'unused',
                minFreeDiskMb: 1,
                vesselIntervalMs: 1000,
                spaceIntervalMs: 1000,
                referenceIntervalMs: 1000,
                scheduleIntervalMs: 1000,
                rollupIntervalMs: 1000,
            },
        } as AppConfig
    );
    const finishes: Array<(outcome: TaskOutcome) => void> = [];
    const tasks = (
        service as unknown as {
            tasks: Array<{ definition: { run: () => Promise<TaskOutcome> } }>;
        }
    ).tasks;
    for (const task of tasks) {
        task.definition.run = vi.fn(
            () =>
                new Promise((resolve) => {
                    finishes.push(resolve);
                })
        );
    }
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(finishes).toHaveLength(5);
    let stopped = false;
    const pending = service.stop().then(() => {
        stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(false);
    for (const finish of finishes) finish({ rowsWritten: 0, rowsSkipped: 0 });
    await pending;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.getTimerCount()).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
});
