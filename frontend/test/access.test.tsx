// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reload = vi.fn();
let ferryApi: typeof import('../src/api').ferryApi;

beforeEach(async () => {
  reload.mockClear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
  // The one-shot redirect guard is module state, so each test needs a fresh copy of it.
  vi.resetModules();
  ({ ferryApi } = await import('../src/api'));
});

function respond(body: string, init: ResponseInit) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, init));
}

describe('API client behind Cloudflare Access', () => {
  it('reloads instead of throwing a parse error when Access serves its login page', async () => {
    respond('<!doctype html><title>Sign in</title>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    await expect(ferryApi.terminals()).rejects.toThrow(/session expired/i);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads on a 401 from an expired session', async () => {
    respond('{"error":"unauthorized"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });

    await expect(ferryApi.vessels()).rejects.toThrow(/session expired/i);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at most once so a failed re-auth cannot trap the browser in a loop', async () => {
    respond('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });

    await expect(ferryApi.terminals()).rejects.toThrow();
    await expect(ferryApi.terminals()).rejects.toThrow();
    await expect(ferryApi.terminals()).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('surfaces the API error message on a normal failure without reloading', async () => {
    respond('{"error":"WSDOT is unavailable."}', {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });

    await expect(ferryApi.terminals()).rejects.toThrow('WSDOT is unavailable.');
    expect(reload).not.toHaveBeenCalled();
  });

  it('still returns a normal payload', async () => {
    respond('{"data":[],"fetchedAt":"2026-09-01T16:00:00.000Z","source":"live","raw":null}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await expect(ferryApi.terminals()).resolves.toMatchObject({ source: 'live' });
    expect(reload).not.toHaveBeenCalled();
  });
});
