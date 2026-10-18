import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdown } from '../src/shutdown.js';

describe('private runtime shutdown', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the same shutdown for a stop file and signals, and waits for completion', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let requested = false;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const exists = vi.fn(() => requested);
    const stop = installShutdown(shutdown, 'private\\run\\stop.request', exists);
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(shutdown).not.toHaveBeenCalled();
      requested = true;
      await vi.advanceTimersByTimeAsync(250);
      expect(exists).toHaveBeenCalledWith('private\\run\\stop.request');
      expect(shutdown).toHaveBeenCalledTimes(1);
      let finished = false;
      const pending = stop().then(() => { finished = true; });
      expect(stop()).toBe(stop());
      await vi.advanceTimersByTimeAsync(1000);
      expect(finished).toBe(false);
      process.emit('SIGTERM');
      await Promise.resolve();
      expect(shutdown).toHaveBeenCalledTimes(1);
      finish();
      await pending;
      expect(finished).toBe(true);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { finish?.(); await stop(); }
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('handles %s without a stop-file configuration', async (signal) => {
    const shutdown = vi.fn(async () => undefined);
    const stop = installShutdown(shutdown, '');
    process.emit(signal);
    await stop();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
