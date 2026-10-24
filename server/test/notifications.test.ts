import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SailingView, NotificationScope } from '@ferry-tracker/shared';
import { openDatabase, type Db } from '../src/db/database.js';
import { NotificationStore } from '../src/notifications/store.js';
import { NotificationMonitor, mergeConstituents } from '../src/notifications/monitor.js';
import { PushoverSender } from '../src/notifications/pushover.js';
import { notificationRouter, notificationUpdateSchema } from '../src/notifications/api.js';
import type { FerryDataService } from '../src/ferryDataService.js';
import type { AppConfig } from '../src/config.js';

const base = Date.parse('2026-10-24T18:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const settings = { trafficMinutes: 15, queueMinutes: 15 };
function sailing(departure = base + 31 * 60_000): SailingView {
    return {
        vesselId: 1,
        vesselName: 'Tacoma',
        departingTime: iso(departure),
        arrivingTime: iso(departure + 35 * 60_000),
        departingTerminalId: 3,
        arrivingTerminalId: 7,
        isCancelled: false,
        driveUpSpaceCount: 20,
        reservableSpaceCount: null,
        maxSpaceCount: 100,
        spaceAvailable: true,
        spaceSource: 'live',
        spaceObservedAt: null,
        spaceLeadSeconds: null,
        actualDeparture: null,
        actualArrival: null,
        departureDelayMinutes: null,
        raw: {},
    };
}
type Snapshot = Awaited<ReturnType<FerryDataService['notificationSnapshot']>>;
describe('durable notifications (database access requires SQL review before running)', () => {
    let db: Db;
    let store: NotificationStore;
    let now: number;
    let data: Snapshot;
    const sender = { send: vi.fn(async () => ({ status: 'accepted' as const })) };
    let service: { notificationSnapshot: ReturnType<typeof vi.fn<() => Promise<Snapshot>>> };
    beforeEach(() => {
        db = openDatabase(':memory:');
        store = new NotificationStore(db);
        now = base;
        data = { sailings: [sailing()], vessels: [], crossings: new Map() };
        service = { notificationSnapshot: vi.fn(async () => data) };
        sender.send.mockClear();
    });
    afterEach(async () => {
        await db.close();
    });
    const scope: NotificationScope = 'catch:3:7';
    function monitor() {
        return new NotificationMonitor(store, service, sender, () => now);
    }

    it('claims each event atomically and rejects stale subscription state writes', async () => {
        const row = await store.put(scope, true, settings, now);
        expect(await store.claim(row, 'one', now)).toBe(true);
        expect(await store.claim(row, 'one', now)).toBe(false);
        const stale = structuredClone(row);
        await store.put(scope, false, settings, now);
        expect(await store.save(stale, now)).toBe(false);
        expect(await store.claim(stale, 'two', now)).toBe(false);
    });
    it('fires with the page closed, retains a missing raw sailing, and never duplicates after restart', async () => {
        await store.put(scope, true, settings, now);
        const first = monitor();
        await first.tick();
        expect((await store.get(scope))?.state.catches[0].wasFuture).toBe(true);
        data.sailings = [];
        now += 60_000;
        await first.tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
        expect(service.notificationSnapshot).toHaveBeenCalledTimes(2);
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
    });
    it('revises an armed target into the past on settings change, while still actionable', async () => {
        await store.put(scope, true, settings, now);
        const runner = monitor();
        await runner.tick();
        await store.put(scope, true, { trafficMinutes: 17, queueMinutes: 15 }, now);
        await runner.tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
    });
    it('does not send retroactively on first opt-in and marks a restart beyond grace missed', async () => {
        data.sailings = [sailing(base + 29 * 60_000)];
        await store.put(scope, true, settings, now);
        await monitor().tick();
        expect(sender.send).not.toHaveBeenCalled();
        await store.put(scope, false, settings, now);
        data.sailings = [sailing()];
        await store.put(scope, true, settings, now);
        await monitor().tick();
        now += 4 * 60_000;
        await monitor().tick();
        expect(sender.send).not.toHaveBeenCalled();
        expect((await store.get(scope))?.state.status).toBe('missed');
    });
    it.each(['cancelled', 'departed', 'full'])('disarms explicit fresh %s evidence', async (reason) => {
        await store.put(scope, true, settings, now);
        await monitor().tick();
        if (reason === 'cancelled') data.sailings[0].isCancelled = true;
        if (reason === 'departed') data.sailings[0].actualDeparture = iso(now);
        if (reason === 'full') data.sailings[0].driveUpSpaceCount = 0;
        now += 60_000;
        await monitor().tick();
        expect(sender.send).not.toHaveBeenCalled();
    });
    it('never resends a crash-left claimed event and reports uncertainty', async () => {
        await store.put(scope, true, settings, now);
        await monitor().tick();
        const row = (await store.get(scope))!;
        await store.claim(row, row.state.catches[0].key, now);
        now += 60_000;
        await monitor().tick();
        expect(sender.send).not.toHaveBeenCalled();
        expect((await store.get(scope))?.state.status).toBe('uncertain');
    });
    it('two instances produce at most one external send', async () => {
        await store.put(scope, true, settings, now);
        const first = monitor();
        const second = monitor();
        await Promise.all([first.tick(), second.tick()]);
        now += 60_000;
        await Promise.all([first.tick(), second.tick()]);
        expect(sender.send).toHaveBeenCalledTimes(1);
    });
    it('retries a confirmed 429 once on a later tick, never by sleeping', async () => {
        const send = vi
            .fn<PushoverSender['send']>()
            .mockResolvedValueOnce({ status: 'failed', retryAfterMs: 30_000 })
            .mockResolvedValue({ status: 'accepted' });
        const runner = new NotificationMonitor(store, service, { send }, () => now);
        await store.put(scope, true, settings, now);
        await runner.tick();
        now += 60_000;
        await runner.tick();
        expect(send).toHaveBeenCalledTimes(1);
        now += 15_000;
        await runner.tick();
        expect(send).toHaveBeenCalledTimes(1);
        now += 15_000;
        await runner.tick();
        expect(send).toHaveBeenCalledTimes(2);
        await runner.tick();
        expect(send).toHaveBeenCalledTimes(2);
        expect((await store.get(scope))?.state.status).toBe('accepted');
    });
    it('persists ambiguous delivery without automatically retrying it', async () => {
        const send = vi.fn<PushoverSender['send']>().mockResolvedValue({ status: 'uncertain' });
        const runner = new NotificationMonitor(store, service, { send }, () => now);
        await store.put(scope, true, settings, now);
        await runner.tick();
        now += 60_000;
        await runner.tick();
        await monitor().tick();
        expect(send).toHaveBeenCalledTimes(1);
        expect(sender.send).not.toHaveBeenCalled();
        expect((await store.get(scope))?.state.status).toBe('uncertain');
    });
    it('retains the last ETA target when a candidate disappears before its deadline', async () => {
        data.vessels = [
            {
                id: 1,
                name: 'Tacoma',
                atDock: false,
                arrivingTerminalId: 3,
                departingTerminalId: 7,
                eta: iso(base + 35 * 60_000),
                scheduledDeparture: iso(base - 10 * 60_000),
                leftDock: null,
                updatedAt: iso(now),
            } as Snapshot['vessels'][number],
        ];
        await store.put(scope, true, settings, now);
        const runner = monitor();
        await runner.tick();
        const before = (await store.get(scope))!.state.catches[0].target;
        expect(before).toBe(base + 5 * 60_000);
        data.sailings = [];
        data.vessels = [];
        now += 60_000;
        await runner.tick();
        expect((await store.get(scope))!.state.catches[0].target).toBe(before);
        expect(sender.send).not.toHaveBeenCalled();
    });
    it('sends when a fresh ETA revision moves an armed target into the past', async () => {
        data.vessels = [
            {
                id: 1,
                name: 'Tacoma',
                atDock: false,
                arrivingTerminalId: 3,
                departingTerminalId: 7,
                eta: iso(base + 35 * 60_000),
                scheduledDeparture: iso(base - 10 * 60_000),
                leftDock: null,
                updatedAt: iso(now),
            } as Snapshot['vessels'][number],
        ];
        await store.put(scope, true, settings, now);
        const runner = monitor();
        await runner.tick();
        now += 2 * 60_000;
        data.vessels[0].eta = iso(base + 28 * 60_000);
        data.vessels[0].updatedAt = iso(now);
        await runner.tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
    });
    it('merges overlapping waves, keeps the episode identity through restart, and clears only once', async () => {
        data.sailings = [
            { ...sailing(base - 34 * 60_000), departingTerminalId: 7, arrivingTerminalId: 3 },
            { ...sailing(base - 24 * 60_000), departingTerminalId: 7, arrivingTerminalId: 3, vesselId: 2 },
        ];
        await store.put('disruption', true, { disruptionLeadMinutes: 0, disruptionDurationMinutes: 15 }, now);
        await monitor().tick();
        const id = (await store.get('disruption'))!.state.episodes[0].id;
        now += 60_000;
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
        now += 10 * 60_000;
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
        expect((await store.get('disruption'))!.state.episodes[0].id).toBe(id);
        now += 15 * 60_000;
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(2);
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(2);
    });
    it('catches up an armed leave-by after restart inside the two-minute grace', async () => {
        await store.put(scope, true, settings, now);
        await monitor().tick();
        now += 2 * 60_000;
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
        expect((await store.get(scope))?.state.status).toBe('accepted');
    });
    it('a monitor losing CAS to a disable while fetching cannot claim or send', async () => {
        await store.put(scope, true, settings, now);
        await monitor().tick();
        now += 60_000;
        service.notificationSnapshot.mockImplementationOnce(async () => {
            await store.put(scope, false, settings, now);
            return data;
        });
        await monitor().tick();
        expect(sender.send).not.toHaveBeenCalled();
        expect((await store.get(scope))?.enabled).toBe(false);
        expect(await store.event(`${scope}:${data.sailings[0].departingTime}`)).toBeUndefined();
    });
    it('keeps exact touching waves active until the final endpoint and requires fresh clear reconciliation', async () => {
        data.sailings = [
            { ...sailing(base - 34 * 60_000), departingTerminalId: 7, arrivingTerminalId: 3 },
            { ...sailing(base - 19 * 60_000), departingTerminalId: 7, arrivingTerminalId: 3, vesselId: 2 },
        ];
        await store.put('disruption', true, { disruptionLeadMinutes: 0, disruptionDurationMinutes: 15 }, now);
        await monitor().tick();
        now += 60_000;
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
        now += 15 * 60_000;
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
        now += 15 * 60_000;
        service.notificationSnapshot.mockRejectedValueOnce(new Error('upstream unavailable'));
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
        expect((await store.get('disruption'))!.state.episodes[0].cleared).toBeFalsy();
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(2);
        expect((await store.get('disruption'))!.state.episodes[0].cleared).toBe(true);
    });
    it('first opt-in during an active episode sends neither a retroactive start nor unmatched clear', async () => {
        data.sailings = [{ ...sailing(base - 40 * 60_000), departingTerminalId: 7, arrivingTerminalId: 3 }];
        await store.put('disruption', true, { disruptionLeadMinutes: 0, disruptionDurationMinutes: 15 }, now);
        await monitor().tick();
        expect(sender.send).not.toHaveBeenCalled();
        now += 10 * 60_000;
        await monitor().tick();
        expect(sender.send).not.toHaveBeenCalled();
        expect((await store.get('disruption'))!.state.episodes[0].cleared).toBe(true);
    });
    it('a fresh overlapping extension keeps identity and postpones the final clear', async () => {
        data.sailings = [{ ...sailing(base - 34 * 60_000), departingTerminalId: 7, arrivingTerminalId: 3 }];
        await store.put('disruption', true, { disruptionLeadMinutes: 0, disruptionDurationMinutes: 15 }, now);
        await monitor().tick();
        const id = (await store.get('disruption'))!.state.episodes[0].id;
        now += 60_000;
        await monitor().tick();
        data.sailings.push({
            ...sailing(base - 24 * 60_000),
            departingTerminalId: 7,
            arrivingTerminalId: 3,
            vesselId: 2,
        });
        now += 15 * 60_000;
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(1);
        expect((await store.get('disruption'))!.state.episodes[0].id).toBe(id);
        now += 10 * 60_000;
        await monitor().tick();
        expect(sender.send).toHaveBeenCalledTimes(2);
    });
});

describe('notification request validation and Pushover transport without database access', () => {
    it('strictly binds settings to the scope with bounded finite values', () => {
        expect(notificationUpdateSchema.safeParse({ scope: 'catch:3:7', enabled: true, settings }).success).toBe(true);
        for (const payload of [
            { scope: 'catch:3:3', enabled: true, settings },
            { scope: 'catch:3:7', enabled: true, settings: { ...settings, trafficMinutes: 181 } },
            { scope: 'disruption', enabled: true, settings },
            { scope: 'catch:3:7', enabled: true, settings, token: 'secret' },
        ])
            expect(notificationUpdateSchema.safeParse(payload).success).toBe(false);
    });
    it('merges exact touching intervals without hysteresis', () => {
        expect(
            mergeConstituents([
                { key: 'b', start: 10, end: 20 },
                { key: 'a', start: 0, end: 10 },
                { key: 'c', start: 21, end: 30 },
            ])
        ).toEqual([
            { keys: ['a', 'b'], start: 0, end: 20 },
            { keys: ['c'], start: 21, end: 30 },
        ]);
    });
    it('returns generic unavailable status and rejects cross-site/oversized mutations', async () => {
        const config = { dataSource: 'fixture' } as AppConfig;
        const app = express().use('/api/notifications', notificationRouter(config));
        const result = await request(app).get('/api/notifications?scope=catch:3:7').expect(200);
        expect(result.body.data).toEqual({ available: false, subscription: null });
        await request(app)
            .put('/api/notifications')
            .set('Origin', 'https://evil.example')
            .send({ scope: 'catch:3:7', enabled: true, settings })
            .expect(403);
        await request(app)
            .put('/api/notifications')
            .set('Host', 'localhost:5173')
            .set('Origin', 'http://localhost:5173')
            .send({ scope: 'catch:3:7', enabled: true, settings })
            .expect(200);
        await request(app)
            .put('/api/notifications')
            .set('Host', 'localhost')
            .set('Origin', 'http://localhost')
            .send({ text: 'x'.repeat(3000) })
            .expect(400);
    });
    it('requires both HTTP and JSON success and caps outgoing fields', async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 1 }), { status: 200 }));
        const sender = new PushoverSender('app-secret', 'user-secret', fetcher);
        expect(await sender.send('t'.repeat(500), 'm'.repeat(2000))).toEqual({ status: 'accepted' });
        const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(call[0]).toBe('https://api.pushover.net/1/messages.json');
        const body = call[1].body as URLSearchParams;
        expect(body.get('title')).toHaveLength(250);
        expect(body.get('message')).toHaveLength(1024);
    });
    it('keeps ambiguous errors secret-free and retries only an explicit 429 rejection', async () => {
        const failure = new PushoverSender(
            'app-secret',
            'user-secret',
            vi.fn(async () => {
                throw new Error('app-secret user-secret');
            })
        );
        expect(await failure.send('title', 'message')).toEqual({ status: 'uncertain' });
        const serverError = new PushoverSender(
            'a',
            'b',
            vi.fn(async () => new Response(JSON.stringify({ status: 0 }), { status: 503 }))
        );
        expect(await serverError.send('t', 'm')).toEqual({ status: 'uncertain' });
        const throttled = new PushoverSender(
            'a',
            'b',
            vi.fn(
                async () =>
                    new Response(JSON.stringify({ status: 0 }), { status: 429, headers: { 'retry-after': '30' } })
            )
        );
        expect(await throttled.send('t', 'm')).toEqual({ status: 'failed', retryAfterMs: 30_000 });
    });
});
