import { createApp } from './app.js';
import { CaptureService } from './capture/captureService.js';
import { getConfig } from './config.js';
import { openConfiguredDatabase } from './db/database.js';
import { DatabaseSailingHistory } from './history/sailingHistory.js';
import { installShutdown } from './shutdown.js';
import { WsdotClient } from './wsdotClient.js';
import { FerryDataService } from './ferryDataService.js';
import { notificationsConfigured } from './notifications/api.js';
import { NotificationStore } from './notifications/store.js';
import { NotificationMonitor } from './notifications/monitor.js';
import { PushoverSender } from './notifications/pushover.js';

const config = getConfig();
const fixtureNow = config.fixtureNow ? Date.parse(config.fixtureNow) : Number.NaN;
const now = Number.isNaN(fixtureNow) ? Date.now : () => fixtureNow;

const notify = notificationsConfigured(config);
if (notify && config.dataSource === 'live' && process.env.STORAGE_BACKEND !== 'postgresql') {
    throw new Error('Live notifications require explicitly configured PostgreSQL storage.');
}
const db = config.capture.enabled || notify ? await openConfiguredDatabase(config.capture.dbPath) : null;
const capture = db && config.capture.enabled ? new CaptureService(db, new WsdotClient(config), config) : undefined;
const history = db ? new DatabaseSailingHistory(db) : undefined;
const service = new FerryDataService(new WsdotClient(config), now, history);
const notifications = db && notify ? new NotificationStore(db) : undefined;
const monitor = notifications
    ? new NotificationMonitor(
          notifications,
          service,
          new PushoverSender(config.notifications!.appToken!, config.notifications!.userKey!),
          now
      )
    : undefined;
let stopping = false;

const server = createApp(config, now, capture, history, { service, notifications }).listen(
    config.port,
    config.host,
    () => {
        console.log(`Ferry Tracker is listening on ${config.host}:${config.port}`);
        if (!stopping) {
            capture?.start();
            monitor?.start();
        }
    }
);

installShutdown(async () => {
    stopping = true;
    const captureStopped = capture?.stop();
    const serverStopped = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
    });
    await Promise.all([captureStopped, serverStopped, monitor?.stop()]);
    await db?.close();
});
