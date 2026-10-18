import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('keeps the release stateless and preserves both catch aliases and source tasks', () => {
  const manifest = JSON.parse(readFileSync(path.resolve('deploy', 'application.json'), 'utf8'));
  expect(manifest.id).toBe('ferry-tracker');
  expect(manifest.repository).toBe('https://github.com/purduepete/ferrytracker.git');
  expect(manifest.build.commands).toEqual([
    { tool: 'npm', arguments: ['ci'], workingDirectory: '.' },
    { tool: 'npm', arguments: ['run', 'build'], workingDirectory: '.' },
  ]);
  expect(manifest.source.root).toBe('C:\\Files\\Dev\\main\\ferry_tracker');
  expect(manifest.launch).toMatchObject({
    entrypoint: 'server\\dist\\index.js', port: 8787, secretFile: 'app.env',
    stopFileEnvironment: 'SOLUTIONDEPLOY_STOP_FILE',
    environment: {
      HOST: '127.0.0.1', PORT: '8787', DATA_SOURCE: 'live', CAPTURE_ENABLED: 'true',
      CAPTURE_DB_PATH: '{data}\\ferry-capture.db', CAPTURE_ARCHIVE_DIR: '{data}\\raw',
      BACKUP_DIR: '{backups}', SOLUTIONDEPLOY_STOP_FILE: '{run}\\stop.request',
      STORAGE_BACKEND: 'postgresql',
    },
  });
  expect(manifest.database).toMatchObject({ engine: 'postgresql', name: 'ferry_tracker', schemaVersion: 1 });
  expect(manifest.managedState).toEqual([
    { source: 'data\\raw', target: 'data\\raw', kind: 'directory', required: true },
  ]);
  expect(manifest.launch.environment.DATABASE_URL).toBeUndefined();
  expect(manifest.routes).toEqual([
    { hostname: 'ferry-tracker.jimlertech.com', catchPath: '/api/catch' },
    { hostname: 'ferry.jimlertech.com', catchPath: '/api/catch' },
  ]);
  expect(manifest.source.tasks).toEqual(['FerryTracker', 'FerryTracker-Watchdog', 'FerryTracker-Backup']);
  expect(manifest.state).toContainEqual(expect.objectContaining({ source: '.env.local', target: 'secrets\\source\\app.env', required: true }));
  expect(manifest.state).toContainEqual(expect.objectContaining({ source: '.env', target: 'secrets\\source\\fallback.env' }));
  expect(manifest.launch.environment.FERRY_ENV_FALLBACK_FILE).toBeUndefined();
  expect(manifest.state.some((item: { target: string }) => item.target === 'secrets\\app.env')).toBe(false);
  for (const item of manifest.state) {
    expect(item.target).toMatch(/^(?:data|secrets|logs|backups)\\/);
    expect(item.source).not.toMatch(/\.(?:lock|pid)$/);
  }
});
