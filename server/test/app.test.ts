import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { isScheduleVisible } from '../src/ferryDataService';

const fixtureNow = Date.parse('2026-09-01T18:30:00.000Z');
const app = createApp({ host: '127.0.0.1', port: 8787, dataSource: 'fixture', rawInspector: true }, () => fixtureNow);

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
    const privateApp = createApp({ host: '127.0.0.1', port: 8787, dataSource: 'fixture', rawInspector: false });
    const response = await request(privateApp).get('/api/terminals').expect(200);
    expect(response.body.raw).toBeNull();
  });
});