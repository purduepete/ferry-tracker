import { createApp } from './app.js';
import { CaptureService } from './capture/captureService.js';
import { getConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { WsdotClient } from './wsdotClient.js';

const config = getConfig();
const fixtureNow = config.fixtureNow ? Date.parse(config.fixtureNow) : Number.NaN;
const now = Number.isNaN(fixtureNow) ? Date.now : () => fixtureNow;

const db = config.capture.enabled ? openDatabase(config.capture.dbPath) : null;
const capture = db ? new CaptureService(db, new WsdotClient(config), config) : undefined;

const server = createApp(config, now, capture).listen(config.port, config.host, () => {
  console.log(`Ferry Tracker is listening on ${config.host}:${config.port}`);
  capture?.start();
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    capture?.stop();
    server.close(() => {
      db?.close();
      process.exit(0);
    });
  });
}
