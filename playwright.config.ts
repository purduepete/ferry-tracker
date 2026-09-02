import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  use: {
    baseURL: 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:8787/api/health',
    reuseExistingServer: false,
    env: {
      ...process.env,
      DATA_SOURCE: 'fixture',
      FIXTURE_NOW: '2026-09-01T18:30:00.000Z',
    },
  },
});