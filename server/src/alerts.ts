import {
  pacificParts,
  parseWsdotDate,
  plainText,
  routeTerminalMateSchema,
  scheduleAlertSchema,
  scheduleRouteSchema,
  type ScheduleAlert,
  type TerminalAlertView,
} from '@ferry-tracker/shared';
import { z } from 'zod';
import type { WsdotClient } from './wsdotClient.js';

/** Alerts announce cancellations and delays, so they are refreshed on a passenger-relevant cadence. */
const ALERT_TTL_MS = 300_000;
/** A failed refresh keeps serving the previous list and retries well before the full TTL. */
const ALERT_RETRY_MS = 60_000;
/** Roughly 20 routes, each needing its own call. Three at a time keeps the burst off WSDOT's rate limiter. */
const ROUTE_FETCH_CONCURRENCY = 3;
const ROUTE_RETRY_MS = 60_000;

export type RouteTerminals = Map<number, number[]>;

/** Standing WSF notices that never change a sailing. Matched loosely, so filler words in the title do not defeat them. */
const MUTED_ALERT_PHRASES = [
  'join the ferry riders opinion group',
  'elevator out of service',
  'restroom',
  'restrooms',
  'spring sailing schedule',
  'summer sailing schedule',
  'fall sailing schedule',
  'winter sailing schedule',
].map((phrase) => phrase.split(' '));

function alertWords(title: string): string[] {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
}

/** True when a muted phrase runs through the title in order, allowing extra words between its own. */
function isMuted(title: string): boolean {
  const words = alertWords(title);
  return MUTED_ALERT_PHRASES.some((phrase) => {
    let at = 0;
    for (const word of words) {
      if (word === phrase[at]) at += 1;
      if (at === phrase.length) return true;
    }
    return false;
  });
}

function alertTitle(alert: ScheduleAlert): string | null {
  return plainText(alert.AlertFullTitle, 160) ?? plainText(alert.BulletinText, 160) ?? plainText(alert.AlertType, 160);
}

/**
 * WSF scopes an alert to routes, never to terminals, so every terminal on an affected route inherits it.
 * An unknown route id is skipped: the route map can be a day stale while alerts are current.
 */
export function assignAlerts(alerts: ScheduleAlert[], routeTerminals: RouteTerminals): Map<number, TerminalAlertView[]> {
  const everyTerminal = [...new Set([...routeTerminals.values()].flat())];
  const assigned = new Map<number, TerminalAlertView[]>();
  const seen = new Map<number, Set<number>>();

  const ordered = [...alerts].sort((left, right) => {
    const bySeq = (left.SortSeq ?? Number.MAX_SAFE_INTEGER) - (right.SortSeq ?? Number.MAX_SAFE_INTEGER);
    if (bySeq !== 0) return bySeq;
    return (parseWsdotDate(right.PublishDate) ?? '').localeCompare(parseWsdotDate(left.PublishDate) ?? '');
  });

  for (const alert of ordered) {
    const title = alertTitle(alert);
    if (title === null || isMuted(title)) continue;

    const allRoutes = alert.AllRoutesFlag === true;
    const terminalIds = allRoutes
      ? everyTerminal
      : [...new Set((alert.AffectedRouteIDs ?? []).flatMap((routeId) => routeTerminals.get(routeId) ?? []))];
    if (terminalIds.length === 0) continue;

    const view: TerminalAlertView = {
      id: alert.BulletinID,
      title,
      text: plainText(alert.BulletinText) ?? plainText(alert.DisruptionDescription),
      type: plainText(alert.AlertType, 80),
      publishedAt: parseWsdotDate(alert.PublishDate),
      allRoutes,
    };

    for (const terminalId of terminalIds) {
      const bulletins = seen.get(terminalId) ?? new Set<number>();
      if (bulletins.has(view.id)) continue;
      bulletins.add(view.id);
      seen.set(terminalId, bulletins);
      const list = assigned.get(terminalId) ?? [];
      list.push(view);
      assigned.set(terminalId, list);
    }
  }

  return assigned;
}

async function mapWithLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Maps each route to its terminals, which is the bridge an alert needs: alerts carry route ids and
 * terminals carry neither. Keyed by service date because WSF publishes routes per day.
 */
export class RouteDirectory {
  private routeTerminals: RouteTerminals = new Map();
  private serviceDate: string | null = null;
  private retryAt = 0;
  private inFlight: { date: string | null; promise: Promise<RouteTerminals> } | null = null;

  constructor(private readonly client: WsdotClient, private readonly now: () => number = Date.now) {}

  /**
   * Never blocks a terminal request. A cold map resolves only all-routes alerts while it fills,
   * because paying ~20 serialised calls on the first page load is worse than one incomplete render.
   */
  list(): RouteTerminals {
    const today = pacificParts(this.now())?.serviceDate ?? null;
    if (today !== this.serviceDate && this.now() >= this.retryAt) void this.refresh(today);
    return this.routeTerminals;
  }

  warm(): void {
    void this.refresh(pacificParts(this.now())?.serviceDate ?? null);
  }

  // Single-flight is keyed by service date, so a roll to the next day that lands mid-refresh still
  // queues a rebuild rather than being swallowed by the call already running.
  private refresh(serviceDate: string | null): Promise<RouteTerminals> {
    if (this.inFlight?.date === serviceDate) return this.inFlight.promise;
    const promise = (this.inFlight?.promise ?? Promise.resolve(this.routeTerminals))
      .then(() => this.load(serviceDate))
      .finally(() => { if (this.inFlight?.date === serviceDate) this.inFlight = null; });
    this.inFlight = { date: serviceDate, promise };
    return promise;
  }

  private async load(serviceDate: string | null): Promise<RouteTerminals> {
    try {
      const routes = z.array(scheduleRouteSchema).parse(await this.client.getRoutes());
      const pairs = await mapWithLimit(routes, ROUTE_FETCH_CONCURRENCY, async (route) => {
        const mates = z.array(routeTerminalMateSchema).parse(await this.client.getTerminalsAndMatesByRoute(route.RouteID));
        const terminalIds = new Set<number>();
        for (const mate of mates) {
          terminalIds.add(mate.DepartingTerminalID);
          terminalIds.add(mate.ArrivingTerminalID);
        }
        return [route.RouteID, [...terminalIds]] as [number, number[]];
      });
      this.routeTerminals = new Map(pairs);
      this.serviceDate = serviceDate;
      this.retryAt = 0;
    } catch {
      // A stale or empty route map degrades alerts to all-routes only; it must never fail a request.
      this.retryAt = this.now() + ROUTE_RETRY_MS;
    }
    return this.routeTerminals;
  }
}

/** Same stale-while-revalidate shape as CameraDirectory: only a cold cache waits on the network. */
export class AlertDirectory {
  private alerts: ScheduleAlert[] = [];
  private expiresAt = 0;
  private inFlight: Promise<ScheduleAlert[]> | null = null;

  constructor(private readonly client: WsdotClient, private readonly now: () => number = Date.now) {}

  async list(): Promise<ScheduleAlert[]> {
    if (this.now() < this.expiresAt) return this.alerts;
    const cold = this.expiresAt === 0;
    const refresh = this.refresh();
    return cold ? refresh : this.alerts;
  }

  warm(): void {
    if (this.expiresAt === 0) void this.refresh();
  }

  private refresh(): Promise<ScheduleAlert[]> {
    this.inFlight ??= this.load().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async load(): Promise<ScheduleAlert[]> {
    try {
      this.alerts = z.array(scheduleAlertSchema).parse(await this.client.getScheduleAlerts());
      this.expiresAt = this.now() + ALERT_TTL_MS;
    } catch {
      // A WSF alerts outage must never 502 the terminal list.
      this.expiresAt = this.now() + ALERT_RETRY_MS;
    }
    return this.alerts;
  }
}
