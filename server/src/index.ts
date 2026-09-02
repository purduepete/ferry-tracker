import { createApp } from './app.js';
import { getConfig } from './config.js';

const config = getConfig();
const fixtureNow = config.fixtureNow ? Date.parse(config.fixtureNow) : Number.NaN;
const now = Number.isNaN(fixtureNow) ? Date.now : () => fixtureNow;
createApp(config, now).listen(config.port, '127.0.0.1', () => {
  console.log(`Ferry Tracker is available at http://127.0.0.1:${config.port}`);
});