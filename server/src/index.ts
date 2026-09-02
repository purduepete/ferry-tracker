import { createApp } from './app.js';
import { getConfig } from './config.js';

const config = getConfig();
const fixtureNow = config.fixtureNow ? Date.parse(config.fixtureNow) : Number.NaN;
const now = Number.isNaN(fixtureNow) ? Date.now : () => fixtureNow;
createApp(config, now).listen(config.port, config.host, () => {
  console.log(`Ferry Tracker is listening on ${config.host}:${config.port}`);
});
