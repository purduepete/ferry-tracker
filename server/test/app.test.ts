import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { isScheduleVisible } from '../src/ferryDataService';

const fixtureNow = Date.parse('2026-09-01T18:30:00.000Z');

function testConfig(rawInspector: boolean, catchToken?: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    dataSource: 'fixture',
    catchToken,
    secrets: catchToken ? [catchToken] : [],
    rawInspector,
    capture: {
      enabled: false,
      allowFixtureSource: false,
      dbPath: ':memory:',
      rawArchiveDir: '',
      vesselIntervalMs: 30_000,
      spaceIntervalMs: 60_000,
      referenceIntervalMs: 21_600_000,
      scheduleIntervalMs: 21_600_000,
      rollupIntervalMs: 900_000,
      retentionDays: null,
      dwellCeilingMinutes: 120,
      dockDebounceSeconds: 120,
      minFreeDiskMb: 512,
      statusEnabled: true,
    },
  };
}

const app = createApp(testConfig(true), () => fixtureNow);

describe('Ferry Tracker API', () => {
  it('keeps schedules from the past two hours through the next twelve hours', () => {
    expect(isScheduleVisible('2026-09-01T16:30:00.000Z', fixtureNow)).toBe(true);
    expect(isScheduleVisible('2026-09-01T16:29:59.999Z', fixtureNow)).toBe(false);
    expect(isScheduleVisible('2026-09-02T06:30:00.000Z', fixtureNow)).toBe(true);
    expect(isScheduleVisible('2026-09-02T06:30:00.001Z', fixtureNow)).toBe(false);
    expect(isScheduleVisible(null, fixtureNow)).toBe(true);
  });

  it('returns joined terminals and source structure', async () => {
    const response = await request(app).get('/api/terminals').expect(200);
    expect(response.body.source).toBe('fixture');
    expect(response.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 7, name: 'Seattle', city: 'Seattle' }),
    ]));
    expect(response.body.raw.basics[0]).toHaveProperty('TerminalID');
  });

  it('links vessel locations to terminal identifiers', async () => {
    const response = await request(app).get('/api/vessels').expect(200);
    expect(response.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 1,
        departingTerminalId: 7,
        arrivingTerminalId: 3,
        leftDock: '2026-09-01T16:35:00.000Z',
        eta: '2026-09-01T17:15:00.000Z',
        etaBasis: 'Automated',
      }),
    ]));
  });

  it('returns valid directional schedule terminal mates', async () => {
    const response = await request(app).get('/api/terminal-mates').expect(200);
    expect(response.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ departingTerminalId: 7, arrivingTerminalId: 3 }),
    ]));
  });

  it('returns published vehicle space for a terminal pair', async () => {
    const response = await request(app)
      .get('/api/sailing-spaces?departingTerminalId=7&arrivingTerminalId=3')
      .expect(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({
        vesselId: 1,
        driveUpSpaceCount: 176,
        reservableSpaceCount: null,
        maxSpaceCount: 202,
      }),
    ]);
  });

  it('finds sailings nested in a schedule response', async () => {
    const response = await request(app)
      .get('/api/schedule?departingTerminalId=7&arrivingTerminalId=3&onlyRemaining=false')
      .expect(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0]).toEqual(expect.objectContaining({
      vesselId: 1,
      departingTerminalId: 7,
      arrivingTerminalId: 3,
      driveUpSpaceCount: 176,
      reservableSpaceCount: null,
      maxSpaceCount: 202,
      spaceAvailable: true,
    }));
  });

  it('rejects malformed or identical terminal identifiers', async () => {
    await request(app).get('/api/schedule?departingTerminalId=x&arrivingTerminalId=3').expect(400);
    await request(app).get('/api/schedule?departingTerminalId=3&arrivingTerminalId=3').expect(400);
  });

  it('can disable raw source responses', async () => {
    const privateApp = createApp(testConfig(false));
    const response = await request(privateApp).get('/api/terminals').expect(200);
    expect(response.body.raw).toBeNull();
  });
});

describe('the watch catch endpoint', () => {
  const token = 'a'.repeat(64);
  const query = 'departingTerminalId=7&arrivingTerminalId=3&traffic=15&queue=15';
  // An hour before the fixture's first Seattle departure, so there is something left to catch.
  const beforeDeparture = Date.parse('2026-09-01T16:00:00.000Z');
  const gated = createApp(testConfig(false, token), () => beforeDeparture);

  it('stays off the app entirely when no token is configured', async () => {
    await request(createApp(testConfig(false), () => beforeDeparture)).get(`/api/catch?${query}`).expect(404);
  });

  it('refuses a missing or wrong token', async () => {
    await request(gated).get(`/api/catch?${query}`).expect(401);
    await request(gated).get(`/api/catch?${query}`).set('X-Ferry-Token', 'b'.repeat(64)).expect(401);
  });

  it('rejects a malformed terminal pair', async () => {
    await request(gated).get('/api/catch?departingTerminalId=x&arrivingTerminalId=3').set('X-Ferry-Token', token).expect(400);
    await request(gated).get('/api/catch?departingTerminalId=3&arrivingTerminalId=3').set('X-Ferry-Token', token).expect(400);
  });

  it('answers with a one-line summary and the windows behind it', async () => {
    const response = await request(gated).get(`/api/catch?${query}`).set('X-Ferry-Token', token).expect(200);
    expect(response.body.data.summary).toBe('Leave by 09:30 for the 10:00 Tacoma, 30 min');
    expect(response.body.data.windows[0]).toEqual(expect.objectContaining({
      departureAt: '2026-09-01T17:00:00.000Z',
      leaveByAt: '2026-09-01T16:30:00.000Z',
      minutesAway: 30,
      vesselName: 'Tacoma',
    }));
    // The payload crosses a path Cloudflare Access does not guard, so raw never rides along.
    expect(response.body.raw).toBeNull();
  });

  it('pads by the traffic and queue minutes the caller asked for', async () => {
    const short = 'departingTerminalId=7&arrivingTerminalId=3&traffic=5&queue=5';
    const response = await request(gated).get(`/api/catch?${short}`).set('X-Ferry-Token', token).expect(200);
    expect(response.body.data.summary).toBe('Leave by 09:50 for the 10:00 Tacoma, 50 min');
    expect(response.body.data.windows[0]).toEqual(expect.objectContaining({
      leaveByAt: '2026-09-01T16:50:00.000Z',
      minutesAway: 50,
    }));
  });

  it('falls back to the defaults when the padding is absent or junk', async () => {
    const pair = 'departingTerminalId=7&arrivingTerminalId=3';
    for (const suffix of ['', '&traffic=abc&queue=-4', '&traffic=15&queue=15']) {
      const response = await request(gated).get(`/api/catch?${pair}${suffix}`).set('X-Ferry-Token', token).expect(200);
      expect(response.body.data.summary).toBe('Leave by 09:30 for the 10:00 Tacoma, 30 min');
    }
  });

  it('reads pad as the whole budget, and lets traffic or queue override it', async () => {
    const pair = 'departingTerminalId=7&arrivingTerminalId=3';
    const padded = await request(gated).get(`/api/catch?${pair}&pad=20`).set('X-Ferry-Token', token).expect(200);
    expect(padded.body.data.summary).toBe('Leave by 09:40 for the 10:00 Tacoma, 40 min');
    expect(padded.body.data.windows[0].queueMinutesRemaining).toBeNull();

    const mixed = await request(gated).get(`/api/catch?${pair}&pad=20&queue=10`).set('X-Ferry-Token', token).expect(200);
    expect(mixed.body.data.summary).toBe('Leave by 09:30 for the 10:00 Tacoma, 30 min');
  });

  it('says so when every sailing has sailed', async () => {
    const tooLate = createApp(testConfig(false, token), () => fixtureNow);
    const response = await request(tooLate).get(`/api/catch?${query}`).set('X-Ferry-Token', token).expect(200);
    expect(response.body.data.summary).toBe('No sailings you can still catch.');
    expect(response.body.data.windows).toEqual([]);
  });
});

describe('static asset caching', () => {
  const distIndex = path.resolve(process.cwd(), 'frontend/dist/index.html');

  it.skipIf(!existsSync(distIndex))('lets the shell revalidate so a new build is picked up', async () => {
    const response = await request(app).get('/').expect(200);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it.skipIf(!existsSync(distIndex))('pins fingerprinted assets', async () => {
    const asset = /\/assets\/[A-Za-z0-9._-]+/.exec(readFileSync(distIndex, 'utf8'))?.[0];
    expect(asset, 'no fingerprinted asset found in the built index.html').toBeDefined();

    const response = await request(app).get(asset!).expect(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });
});