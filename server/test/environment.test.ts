import { afterEach, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => vi.fn());
vi.mock('dotenv', () => ({ default: { config } }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); config.mockClear(); });

it('loads preserved fallback settings without enabling dotenv override', async () => {
  vi.stubEnv('FERRY_ENV_FALLBACK_FILE', 'private\\secrets\\fallback.env');
  vi.stubEnv('HOST', '127.0.0.1');
  vi.stubEnv('PORT', '8787');
  vi.stubEnv('DATA_SOURCE', 'live');
  vi.stubEnv('CAPTURE_DATA_DIR', 'private\\data');
  vi.stubEnv('CAPTURE_DB_PATH', 'private\\data\\ferry-capture.db');
  const { getConfig } = await import('../src/config.js');
  expect(config.mock.calls.map(([options]) => options)).toEqual([
    { path: expect.stringMatching(/\.env\.local$/) },
    { path: 'private\\secrets\\fallback.env' },
    { path: expect.stringMatching(/\.env$/) },
  ]);
  expect(getConfig()).toMatchObject({
    host: '127.0.0.1', port: 8787, dataSource: 'live',
    capture: { dbPath: 'private\\data\\ferry-capture.db' },
  });
});
