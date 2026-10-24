import type {
    NotificationSubscription,
    NotificationSettings,
    NotificationScope,
    NotificationDeliveryStatus,
} from '@ferry-tracker/shared';
import type { Db } from '../db/database.js';

export interface ArmedCatch {
    key: string;
    sailing: import('@ferry-tracker/shared').SailingView;
    target: number;
    departure: number;
    wasFuture: boolean;
    handled?: boolean;
    revisedDue?: boolean;
    estimated?: boolean;
}
export interface Constituent {
    key: string;
    start: number;
    end: number;
}
export interface Episode {
    id: string;
    keys: string[];
    start: number;
    end: number;
    wasFuture: boolean;
    started?: boolean;
    cleared?: boolean;
}
export interface MonitorState {
    status: NotificationDeliveryStatus;
    targetAt: string | null;
    lastEventAt: string | null;
    lastError: string | null;
    catches: ArmedCatch[];
    constituents: Constituent[];
    episodes: Episode[];
}
export const initialState = (): MonitorState => ({
    status: 'idle',
    targetAt: null,
    lastEventAt: null,
    lastError: null,
    catches: [],
    constituents: [],
    episodes: [],
});
export interface StoredSubscription {
    scope: NotificationScope;
    enabled: boolean;
    settings: NotificationSettings;
    state: MonitorState;
    revision: number;
}
interface Row {
    scope: NotificationScope;
    enabled: number;
    settings_json: string;
    state_json: string;
    revision: number;
}
export interface NotificationEvent {
    event_key: string;
    status: 'claimed' | 'accepted' | 'failed' | 'uncertain';
    retry_at: string | null;
    attempts: number;
    detail: string | null;
}
function decode(row: Row): StoredSubscription {
    return {
        scope: row.scope,
        enabled: row.enabled === 1,
        settings: JSON.parse(row.settings_json) as NotificationSettings,
        state: JSON.parse(row.state_json) as MonitorState,
        revision: row.revision,
    };
}
export function subscriptionView(row: StoredSubscription): NotificationSubscription {
    return {
        scope: row.scope,
        enabled: row.enabled,
        settings: row.settings,
        status: row.state.status,
        targetAt: row.state.targetAt,
        lastEventAt: row.state.lastEventAt,
        lastError: row.state.lastError,
    };
}

export class NotificationStore {
    constructor(private readonly db: Db) {}
    async get(scope: string): Promise<StoredSubscription | null> {
        const row = (await this.db.prepare('SELECT * FROM notification_subscriptions WHERE scope = ?').get(scope)) as
            Row | undefined;
        return row ? decode(row) : null;
    }
    async list(): Promise<StoredSubscription[]> {
        return (
            (await this.db.prepare('SELECT * FROM notification_subscriptions WHERE enabled = 1').all()) as Row[]
        ).map(decode);
    }
    async put(
        scope: NotificationScope,
        enabled: boolean,
        settings: NotificationSettings,
        now: number
    ): Promise<StoredSubscription> {
        // Preserve armed identities during settings edits. Re-enabling starts a fresh opt-in.
        for (let attempt = 0; attempt < 8; attempt++) {
            const previous = await this.get(scope);
            const state = previous?.enabled && enabled ? previous.state : initialState();
            const next = { scope, enabled, settings, state, revision: previous?.revision ?? 0 };
            if (!previous) {
                const result = await this.db
                    .prepare(
                        `INSERT INTO notification_subscriptions
                    (scope, enabled, settings_json, state_json, revision, updated_at) VALUES (?, ?, ?, ?, 0, ?)
                    ON CONFLICT(scope) DO NOTHING`
                    )
                    .run(
                        scope,
                        Number(enabled),
                        JSON.stringify(settings),
                        JSON.stringify(state),
                        new Date(now).toISOString()
                    );
                if (result.changes) return next;
            } else if (await this.save(next, now)) return { ...next, revision: next.revision + 1 };
        }
        throw new Error('Notification settings are busy. Try again.');
    }
    async save(row: StoredSubscription, now: number): Promise<boolean> {
        const result = await this.db
            .prepare(
                `UPDATE notification_subscriptions SET enabled = ?, settings_json = ?,
            state_json = ?, revision = revision + 1, updated_at = ? WHERE scope = ? AND revision = ?`
            )
            .run(
                Number(row.enabled),
                JSON.stringify(row.settings),
                JSON.stringify(row.state),
                new Date(now).toISOString(),
                row.scope,
                row.revision
            );
        return result.changes === 1;
    }
    async event(key: string): Promise<NotificationEvent | undefined> {
        return (await this.db.prepare('SELECT * FROM notification_events WHERE event_key = ?').get(key)) as
            NotificationEvent | undefined;
    }
    async claim(row: StoredSubscription, key: string, now: number): Promise<boolean> {
        const result = await this.db
            .prepare(
                `INSERT INTO notification_events
            (event_key, scope, status, claimed_at) SELECT ?, scope, 'claimed', ? FROM notification_subscriptions
            WHERE scope = ? AND enabled = 1 AND revision = ? ON CONFLICT(event_key) DO NOTHING`
            )
            .run(key, new Date(now).toISOString(), row.scope, row.revision);
        return result.changes === 1;
    }
    async retry(row: StoredSubscription, key: string, now: number): Promise<boolean> {
        const result = await this.db
            .prepare(
                `UPDATE notification_events SET status = 'claimed', attempts = 2,
            retry_at = NULL WHERE event_key = ? AND status = 'failed' AND attempts = 1 AND retry_at <= ?
            AND EXISTS (SELECT 1 FROM notification_subscriptions WHERE scope = ? AND enabled = 1 AND revision = ?)`
            )
            .run(key, new Date(now).toISOString(), row.scope, row.revision);
        return result.changes === 1;
    }
    async finish(
        key: string,
        status: 'accepted' | 'failed' | 'uncertain',
        now: number,
        retryAt: number | null,
        detail: string | null
    ): Promise<void> {
        await this.db
            .prepare(
                `UPDATE notification_events SET status = ?, finished_at = ?, retry_at = ?, detail = ?
            WHERE event_key = ? AND status = 'claimed'`
            )
            .run(
                status,
                new Date(now).toISOString(),
                retryAt === null ? null : new Date(retryAt).toISOString(),
                detail,
                key
            );
    }
}
