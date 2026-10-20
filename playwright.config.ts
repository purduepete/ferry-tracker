import { defineConfig, devices } from '@playwright/test';

const port = process.env.E2E_PORT ?? '8787';

export default defineConfig({
    testDir: './e2e',
    outputDir: './test-results',
    use: {
        baseURL: `http://127.0.0.1:${port}`,
        channel: process.env.PLAYWRIGHT_CHANNEL,
        trace: 'retain-on-failure',
    },
    projects: [
        { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
        { name: 'mobile', use: { ...devices['Pixel 7'] } },
    ],
    webServer: {
        command: 'npm start',
        url: `http://127.0.0.1:${port}/api/health`,
        reuseExistingServer: false,
        env: {
            ...process.env,
            PORT: port,
            DATA_SOURCE: 'fixture',
            CAPTURE_ENABLED: 'false',
            FIXTURE_NOW: '2026-09-01T18:30:00.000Z',
        },
    },
});
