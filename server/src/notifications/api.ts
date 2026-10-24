import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import type { ApiEnvelope, NotificationScope, NotificationStatus } from '@ferry-tracker/shared';
import type { AppConfig } from '../config.js';
import { NotificationStore, subscriptionView } from './store.js';

export const notificationScopeSchema = z.union([
    z.literal('disruption'),
    z
        .string()
        .regex(/^catch:[1-9]\d{0,3}:[1-9]\d{0,3}$/)
        .refine((value) => {
            const [, from, to] = value.split(':');
            return from !== to;
        }),
]);
const catchSettings = z
    .object({
        trafficMinutes: z.number().int().min(0).max(180),
        queueMinutes: z.number().int().min(0).max(180),
    })
    .strict();
const disruptionSettings = z
    .object({
        disruptionLeadMinutes: z.number().int().min(0).max(30),
        disruptionDurationMinutes: z.number().int().min(5).max(60),
    })
    .strict();
export const notificationUpdateSchema = z.union([
    z.object({ scope: z.literal('disruption'), enabled: z.boolean(), settings: disruptionSettings }).strict(),
    z
        .object({
            scope: notificationScopeSchema.refine((s) => s !== 'disruption'),
            enabled: z.boolean(),
            settings: catchSettings,
        })
        .strict(),
]);

export function notificationsConfigured(config: AppConfig): boolean {
    return Boolean(config.notifications?.enabled && config.notifications.appToken && config.notifications.userKey);
}

function sameOrigin(request: Request): boolean {
    const site = request.get('sec-fetch-site');
    if (site === 'cross-site') return false;
    const origin = request.get('origin');
    if (!origin) return site === 'same-origin';
    try {
        const parsed = new URL(origin);
        return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === request.get('host');
    } catch {
        return false;
    }
}

export function notificationRouter(config: AppConfig, store?: NotificationStore, now = Date.now): Router {
    const router = express.Router();
    let windowStart = now();
    const calls = new Map<string, number>();
    const send = (response: express.Response, data: NotificationStatus) => {
        const envelope: ApiEnvelope<NotificationStatus> = {
            data,
            fetchedAt: new Date(now()).toISOString(),
            source: config.dataSource,
            raw: null,
        };
        response.set('Cache-Control', 'no-store').json(envelope);
    };
    router.use((_request, response, next) => {
        response.set('Cache-Control', 'no-store');
        next();
    });
    router.get('/', async (request, response, next) => {
        const scope = notificationScopeSchema.safeParse(request.query.scope);
        if (!scope.success) {
            response.status(400).json({ error: 'A valid notification scope is required.' });
            return;
        }
        if (!store || !notificationsConfigured(config)) {
            send(response, { available: false, subscription: null });
            return;
        }
        try {
            const row = await store.get(scope.data);
            send(response, { available: true, subscription: row ? subscriptionView(row) : null });
        } catch (error) {
            next(error);
        }
    });
    router.put(
        '/',
        (request, response, next) => {
            if (!sameOrigin(request)) {
                response.status(403).json({ error: 'Same-origin requests are required.' });
                return;
            }
            if (now() - windowStart >= 60_000) {
                calls.clear();
                windowStart = now();
            }
            const key = request.ip ?? 'local';
            const count = (calls.get(key) ?? 0) + 1;
            if (calls.size >= 1000 && !calls.has(key)) {
                response.status(429).json({ error: 'Too many notification updates.' });
                return;
            }
            calls.set(key, count);
            if (count > 30) {
                response.status(429).json({ error: 'Too many notification updates.' });
                return;
            }
            next();
        },
        express.json({ limit: '2kb', strict: true }),
        async (request, response, next) => {
            const update = notificationUpdateSchema.safeParse(request.body);
            if (!update.success) {
                response.status(400).json({ error: 'Invalid notification settings.' });
                return;
            }
            if (!store || !notificationsConfigured(config)) {
                send(response, { available: false, subscription: null });
                return;
            }
            try {
                const row = await store.put(
                    update.data.scope as NotificationScope,
                    update.data.enabled,
                    update.data.settings,
                    now()
                );
                send(response, { available: true, subscription: subscriptionView(row) });
            } catch (error) {
                next(error);
            }
        }
    );
    router.use((error: unknown, _request: Request, response: express.Response, _next: express.NextFunction) => {
        if (
            error instanceof SyntaxError ||
            (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large')
        ) {
            response.status(400).json({ error: 'Invalid notification request.' });
            return;
        }
        void error;
        response.status(502).json({ error: 'Notifications are temporarily unavailable.' });
    });
    return router;
}
