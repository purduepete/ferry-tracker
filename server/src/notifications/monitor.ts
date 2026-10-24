import { randomUUID } from 'node:crypto';
import {
    DEFAULT_SETTINGS,
    catchDeparture,
    disruptionWaves,
    openSpaceCount,
    type CatchNotificationSettings,
    type DisruptionNotificationSettings,
} from '@ferry-tracker/shared';
import type { FerryDataService } from '../ferryDataService.js';
import { NotificationStore, type StoredSubscription, type Constituent, type Episode } from './store.js';
import type { PushoverSender } from './pushover.js';

type Snapshot = Awaited<ReturnType<FerryDataService['notificationSnapshot']>>;
const GRACE_MS = 120_000;
const iso = (time: number) => new Date(time).toISOString();

// Exact overlap and touching endpoints form one road-disruption episode.
export function mergeConstituents(parts: Constituent[]): Array<{ keys: string[]; start: number; end: number }> {
    const merged: Array<{ keys: string[]; start: number; end: number }> = [];
    for (const part of [...parts].sort((a, b) => a.start - b.start)) {
        const last = merged.at(-1);
        if (last && part.start <= last.end) {
            last.keys.push(part.key);
            last.end = Math.max(last.end, part.end);
        } else merged.push({ keys: [part.key], start: part.start, end: part.end });
    }
    return merged;
}

interface Due {
    key: string;
    at: number;
    title: string;
    message: string;
    revised?: boolean;
}

export class NotificationMonitor {
    private timer?: ReturnType<typeof setTimeout>;
    private running?: Promise<void>;
    private stopping = false;
    private readonly snapshots = new Map<string, { at: number; value: Snapshot }>();
    constructor(
        readonly store: NotificationStore,
        private readonly service: Pick<FerryDataService, 'notificationSnapshot'>,
        private readonly sender: Pick<PushoverSender, 'send'>,
        private readonly now: () => number = Date.now
    ) {}

    start(): void {
        if (this.timer || this.running || this.stopping) return;
        const loop = () => {
            if (this.stopping) return;
            this.running = this.tick()
                .catch(() => {
                    console.warn('Notification monitor could not reconcile subscriptions.');
                })
                .finally(() => {
                    this.running = undefined;
                    if (!this.stopping) this.timer = setTimeout(loop, 15_000);
                });
        };
        loop();
    }
    async stop(): Promise<void> {
        this.stopping = true;
        if (this.timer) clearTimeout(this.timer);
        await this.running;
    }
    async tick(): Promise<void> {
        for (const row of await this.store.list()) {
            try {
                await this.reconcile(row);
            } catch {
                // Never include upstream errors, URLs or credential-bearing response bodies.
                row.state.lastError = 'Ferry data is unavailable. Notifications are waiting for a fresh update.';
                await this.store.save(row, this.now());
            }
        }
    }
    private async snapshot(scope: string, force: boolean): Promise<Snapshot> {
        const route = scope === 'disruption' ? 'catch:7:3' : scope;
        const existing = this.snapshots.get(route);
        if (!force && existing && this.now() - existing.at < 60_000) return existing.value;
        const [, from, to] = route.split(':').map(Number);
        const value = await this.service.notificationSnapshot(from, to);
        this.snapshots.set(route, { at: this.now(), value });
        return value;
    }
    private async reconcile(row: StoredSubscription): Promise<void> {
        const now = this.now();
        const dueBefore =
            row.scope === 'disruption'
                ? row.state.episodes.some((e) => !e.cleared && (e.started ? e.end : e.start) <= now)
                : row.state.catches.some((c) => !c.handled && c.target <= now);
        if (row.state.lastError === 'Ferry data is unavailable. Notifications are waiting for a fresh update.')
            row.state.lastError = null;
        let data = await this.snapshot(row.scope, dueBefore);
        let due = row.scope === 'disruption' ? this.disruption(row, data, now) : this.catch(row, data, now);
        // A fresh ETA/settings edit can move a future deadline into this tick.
        const cachedAt = this.snapshots.get(row.scope === 'disruption' ? 'catch:7:3' : row.scope)?.at;
        if (due.length && cachedAt !== now) {
            data = await this.snapshot(row.scope, true);
            due = row.scope === 'disruption' ? this.disruption(row, data, now) : this.catch(row, data, now);
        }
        if (!(await this.store.save(row, now))) return;
        row.revision++;
        for (const event of due) {
            if (this.stopping) return;
            await this.deliver(row, event, now);
        }
        await this.store.save(row, this.now());
    }
    private catch(row: StoredSubscription, data: Snapshot, now: number): Due[] {
        const settings = row.settings as CatchNotificationSettings;
        const state = row.state;
        const pad = (settings.trafficMinutes + settings.queueMinutes) * 60000;
        const traffic = settings.trafficMinutes * 60000;
        for (const sailing of data.sailings) {
            if (!sailing.departingTime) continue;
            const key = `${row.scope}:${sailing.departingTime}`;
            const existing = state.catches.find((c) => c.key === key);
            const departure = catchDeparture(sailing, data.vessels, now, data.crossings);
            const blocked =
                sailing.isCancelled ||
                sailing.actualDeparture !== null ||
                (sailing.spaceSource === 'live' && openSpaceCount(sailing) === 0) ||
                departure?.departed;
            if (blocked) {
                if (existing) existing.handled = true;
                continue;
            }
            if (!departure) continue;
            const tracked = data.vessels.some(
                (v) =>
                    v.id === sailing.vesselId &&
                    v.updatedAt &&
                    Date.parse(v.updatedAt) <= now &&
                    now - Date.parse(v.updatedAt) <= 5 * 60_000
            );
            const effectiveDeparture =
                existing?.estimated && departure.delaySource === null && !tracked
                    ? existing.departure
                    : departure.departsAt;
            const target = effectiveDeparture - pad;
            if (existing) {
                const moved = existing.target !== target;
                existing.revisedDue = existing.revisedDue || (moved && existing.wasFuture && target <= now);
                existing.target = target;
                existing.departure = effectiveDeparture;
                existing.estimated = departure.delaySource !== null || (existing.estimated && !tracked);
                existing.sailing = sailing;
                existing.wasFuture ||= target > now;
            } else {
                state.catches.push({
                    key,
                    sailing,
                    target,
                    departure: departure.departsAt,
                    wasFuture: target > now,
                    handled: target <= now,
                    estimated: departure.delaySource !== null,
                });
            }
        }
        const due: Due[] = [];
        for (const armed of state.catches) {
            if (armed.handled || !armed.wasFuture) continue;
            // Keep the raw sailing when the list stops publishing this slot. A missing
            // slot alone supplies no evidence that the boat was cancelled.
            const departure = catchDeparture(armed.sailing, data.vessels, now, data.crossings);
            if (
                departure?.departed ||
                armed.sailing.actualDeparture !== null ||
                armed.sailing.isCancelled ||
                (armed.sailing.spaceSource === 'live' && openSpaceCount(armed.sailing) === 0)
            ) {
                armed.handled = true;
                continue;
            }
            if (!data.sailings.some((s) => s.departingTime === armed.sailing.departingTime)) {
                // A vanished ETA or schedule slot keeps the last armed deadline. Only
                // affirmative live evidence revises it; padding edits still apply.
                const effectiveDeparture = departure?.delaySource ? departure.departsAt : armed.departure;
                const target = effectiveDeparture - pad;
                armed.revisedDue ||= target !== armed.target && armed.wasFuture && target <= now;
                armed.target = target;
                armed.departure = effectiveDeparture;
            }
            if (armed.target > now) continue;
            if (now > armed.departure - traffic || (now - armed.target > GRACE_MS && !armed.revisedDue)) {
                armed.handled = true;
                state.status = 'missed';
                state.lastError = 'A leave-by notification was missed.';
                continue;
            }
            due.push({
                key: armed.key,
                at: armed.target,
                revised: armed.revisedDue,
                title: 'Ferry Tracker: leave now',
                message: `Leave now for ${armed.sailing.vesselName ?? 'the ferry'} on ${data.route.departingTerminalName} -> ${data.route.arrivingTerminalName}. Drive ${settings.trafficMinutes} min, queue ${settings.queueMinutes} min.`,
            });
        }
        const next = state.catches.filter((c) => !c.handled).sort((a, b) => a.target - b.target)[0];
        state.targetAt = next ? iso(next.target) : null;
        if (next && !['failed', 'uncertain', 'missed'].includes(state.status)) state.status = 'armed';
        // Events remain durable. Only old in-memory planning state is bounded.
        state.catches = state.catches.filter((c) => c.departure > now - 24 * 60 * 60_000);
        return due;
    }
    private disruption(row: StoredSubscription, data: Snapshot, now: number): Due[] {
        const state = row.state;
        const settings = { ...DEFAULT_SETTINGS, ...(row.settings as DisruptionNotificationSettings) };
        const waves = disruptionWaves(data.vessels, now, settings, data.sailings, data.crossings, true);
        for (const wave of waves) {
            const landing = Date.parse(wave.landingAt);
            const candidates = data.sailings.filter(
                (s) =>
                    s.vesselId === wave.vesselId &&
                    s.departingTime &&
                    Math.abs(Date.parse(s.actualArrival ?? s.arrivingTime ?? s.departingTime!) - landing) < 60 * 60_000
            );
            const sailing = candidates.sort(
                (a, b) =>
                    Math.abs(Date.parse(a.actualArrival ?? a.arrivingTime ?? a.departingTime!) - landing) -
                    Math.abs(Date.parse(b.actualArrival ?? b.arrivingTime ?? b.departingTime!) - landing)
            )[0];
            const vessel = data.vessels.find((v) => v.id === wave.vesselId);
            let key =
                wave.source === 'live' && vessel?.scheduledDeparture
                    ? `7:3:${vessel.scheduledDeparture}`
                    : sailing?.departingTime
                      ? `7:3:${sailing.departingTime}`
                      : vessel?.scheduledDeparture
                        ? `7:3:${vessel.scheduledDeparture}`
                        : '';
            if (!key) {
                const prior = state.constituents.find(
                    (c) =>
                        c.key.startsWith(`vessel:${wave.vesselId}:`) &&
                        Math.abs(c.start - Date.parse(wave.disruptionAt)) < 30 * 60_000
                );
                key = prior?.key ?? `vessel:${wave.vesselId}:${wave.landingAt}`;
            }
            const part = { key, start: Date.parse(wave.disruptionAt), end: Date.parse(wave.clearsAt) };
            const index = state.constituents.findIndex((c) => c.key === key);
            if (index >= 0) state.constituents[index] = part;
            else state.constituents.push(part);
        }
        const cancelled = new Set(
            data.sailings.filter((s) => s.isCancelled && s.departingTime).map((s) => `7:3:${s.departingTime}`)
        );
        state.constituents = state.constituents.filter((c) => !cancelled.has(c.key));
        const merged = mergeConstituents(state.constituents);
        const next: Episode[] = [];
        const assigned = new Set<string>();
        for (const group of merged) {
            const related = state.episodes.filter((e) => e.keys.some((k) => group.keys.includes(k)));
            const prior = related.filter((e) => !assigned.has(e.id));
            const identity = prior.find((e) => e.started && !e.cleared) ?? prior[0];
            if (identity) assigned.add(identity.id);
            next.push({
                ...group,
                id: identity?.id ?? randomUUID(),
                wasFuture: related.some((e) => e.wasFuture) || group.start > now,
                started: prior.some((e) => e.started),
                cleared: prior.some((e) => e.cleared),
            });
        }
        // An active episode keeps its final end even if a fresh source omits its members.
        for (const prior of state.episodes) {
            if (!next.some((e) => e.keys.some((k) => prior.keys.includes(k))) && prior.started && !prior.cleared)
                next.push(prior);
        }
        state.episodes = next;
        const due: Due[] = [];
        for (const episode of next) {
            if (!episode.started && episode.wasFuture && episode.end <= now) {
                episode.started = true;
                episode.cleared = true;
                state.status = 'missed';
                state.lastError = 'A disruption episode was missed.';
                continue;
            }
            if (!episode.started && episode.wasFuture && episode.start <= now && episode.end > now) {
                if (now - episode.start <= GRACE_MS)
                    due.push({
                        key: `disruption:${episode.id}:start`,
                        at: episode.start,
                        title: 'Ferry Tracker: Bainbridge disruption',
                        message: 'Ferry offload traffic is reaching Bainbridge roads.',
                    });
                else {
                    episode.started = true;
                    state.status = 'missed';
                    state.lastError = 'A disruption-start notification was missed.';
                }
            }
            if (!episode.started && episode.start <= now && !episode.wasFuture) episode.started = true;
            if (episode.started && !episode.cleared && episode.end <= now) {
                if (episode.wasFuture && now - episode.end <= GRACE_MS)
                    due.push({
                        key: `disruption:${episode.id}:clear`,
                        at: episode.end,
                        title: 'Ferry Tracker: Bainbridge clear',
                        message: 'The ferry offload traffic window has cleared.',
                    });
                else {
                    episode.cleared = true;
                    if (episode.wasFuture) {
                        state.status = 'missed';
                        state.lastError = 'A disruption-clear notification was missed.';
                    }
                }
            }
        }
        const active = next.filter((e) => !e.cleared).sort((a, b) => a.start - b.start)[0];
        state.targetAt = active ? iso(active.started ? active.end : active.start) : null;
        if (active && !['failed', 'uncertain', 'missed'].includes(state.status)) state.status = 'armed';
        state.constituents = state.constituents.filter((c) => c.end > now - 24 * 60 * 60_000);
        state.episodes = state.episodes.filter((e) => e.end > now - 24 * 60 * 60_000);
        return due;
    }
    private async deliver(row: StoredSubscription, due: Due, now: number): Promise<void> {
        const existing = await this.store.event(due.key);
        let claimed = false;
        if (!existing) claimed = await this.store.claim(row, due.key, now);
        else if (
            existing.status === 'failed' &&
            existing.retry_at &&
            existing.attempts === 1 &&
            Date.parse(existing.retry_at) <= now &&
            now - due.at <= GRACE_MS
        ) {
            claimed = await this.store.retry(row, due.key, now);
        }
        if (!claimed) {
            if (!existing || (existing.retry_at && existing.attempts === 1 && now - due.at <= GRACE_MS)) return;
            row.state.status = existing.status === 'claimed' ? 'uncertain' : existing.status;
            row.state.lastError =
                row.state.status === 'accepted' ? null : 'Notification delivery could not be confirmed.';
            this.handled(row, due.key);
            return;
        }
        const result = await this.sender.send(due.title, due.message);
        const retryAt =
            result.retryAfterMs && !existing && now + result.retryAfterMs <= due.at + GRACE_MS
                ? now + result.retryAfterMs
                : null;
        const detail =
            result.status === 'accepted'
                ? null
                : result.status === 'uncertain'
                  ? 'Notification delivery could not be confirmed.'
                  : 'Notification was rejected.';
        await this.store.finish(due.key, result.status, this.now(), retryAt, detail);
        row.state.status = result.status;
        row.state.lastEventAt = iso(this.now());
        row.state.lastError = detail;
        if (retryAt === null) this.handled(row, due.key);
    }
    private handled(row: StoredSubscription, key: string): void {
        if (row.scope !== 'disruption') {
            const target = row.state.catches.find((c) => c.key === key);
            if (target) target.handled = true;
        } else {
            for (const episode of row.state.episodes) {
                if (key === `disruption:${episode.id}:start`) episode.started = true;
                if (key === `disruption:${episode.id}:clear`) episode.cleared = true;
            }
        }
    }
}
