import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config';

describe('server host configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('listens on all interfaces by default', () => {
    vi.stubEnv('HOST', '');
    expect(getConfig().host).toBe('0.0.0.0');
  });

  it('accepts an explicit host override', () => {
    vi.stubEnv('HOST', '192.168.1.20');
    expect(getConfig().host).toBe('192.168.1.20');
  });
});