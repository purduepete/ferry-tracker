import { createApp } from './app.js';
import { CaptureService } from './capture/captureService.js';
import { getConfig } from './config.js';
import { openConfiguredDatabase } from './db/database.js';
import { DatabaseSailingHistory } from './history/sailingHistory.js';
import { installShutdown } from './shutdown.js';
import { WsdotClient } from './wsdotClient.js';

const config = getConfig();
const fixtureNow = config.fixtureNow ? Date.parse(config.fixtureNow) : Number.NaN;
const now = Number.isNaN(fixtureNow) ? Date.now : () => fixtureNow;

const db = config.capture.enabled ? await openConfiguredDatabase(config.capture.dbPath) : null;
const capture = db ? new CaptureService(db, new WsdotClient(config), config) : undefined;
const history = db ? new DatabaseSailingHistory(db) : undefined;
let stopping = false;

const server = createApp(config, now, capture, history).listen(config.port, config.host, () => {
  console.log(`Ferry Tracker is listening on ${config.host}:${config.port}`);
  if (!stopping) capture?.start();
});

installShutdown(async () => {
  stopping = true;
  const captureStopped = capture?.stop();
  const serverStopped = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
  await Promise.all([captureStopped, serverStopped]);
  await db?.close();
});
