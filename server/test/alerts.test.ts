import { describe, expect, it, vi } from 'vitest';
import type { ScheduleAlert } from '@ferry-tracker/shared';
import { AlertDirectory, assignAlerts, RouteDirectory, type RouteTerminals } from '../src/alerts';
import type { WsdotClient } from '../src/wsdotClient';

const routeTerminals: RouteTerminals = new Map([
  [5, [7, 3]],
  [7, [7, 9]],
]);

function alert(overrides: Partial<ScheduleAlert> & { BulletinID: number }): ScheduleAlert {
  return {
    BulletinText: 'A sailing is cancelled.',
    PublishDate: '/Date(1789225200000-0700)/',
    AllRoutesFlag: false,
    SortSeq: 10,
    AlertType: 'Cancellation',
    AlertFullTitle: 'Sailing cancelled',
    AffectedRouteIDs: [5],
    ...overrides,
  };
}

describe('alert assignment', () => {
  it('gives an all-routes alert to every terminal on every route', () => {
    const assigned = assignAlerts([alert({ BulletinID: 1, AllRoutesFlag: true, AffectedRouteIDs: [] })], routeTerminals);
    expect([...assigned.keys()].sort()).toEqual([3, 7, 9]);
    expect(assigned.get(3)?.[0].allRoutes).toBe(true);
  });

  it('scopes a route alert to the terminals on that route', () => {
    const assigned = assignAlerts([alert({ BulletinID: 2 })], routeTerminals);
    expect([...assigned.keys()].sort()).toEqual([3, 7]);
    expect(assigned.has(9)).toBe(false);
  });

  it('spans every affected route without repeating a shared terminal', () => {
    const assigned = assignAlerts([alert({ BulletinID: 3, AffectedRouteIDs: [5, 7] })], routeTerminals);
    expect(assigned.get(7)).toHaveLength(1);
    expect([...assigned.keys()].sort()).toEqual([3, 7, 9]);
  });

  it('skips an unknown route id instead of throwing', () => {
    // The route map can be a day stale while alerts are current.
    const assigned = assignAlerts([alert({ BulletinID: 4, AffectedRouteIDs: [999] })], routeTerminals);
    expect(assigned.size).toBe(0);
  });

  it('drops an alert with no usable title', () => {
    const assigned = assignAlerts([alert({ BulletinID: 5, AlertFullTitle: null, BulletinText: null, AlertType: null })], routeTerminals);
    expect(assigned.size).toBe(0);
  });

  it('mutes standing notices even when the title pads the phrase out', () => {
    const muted = [
      alert({ BulletinID: 50, AlertFullTitle: 'Join the Ferry Riders Opinion Group' }),
      alert({ BulletinID: 51, AlertFullTitle: 'Sea/BI/Brem-ADA Alert- Alaskan Way #5 Elevator is Out of Service at Colman Dock' }),
      alert({ BulletinID: 52, AlertFullTitle: 'Muk/Clin - Clinton Restrooms Unavailable -- Portable Restrooms Available' }),
      alert({ BulletinID: 53, AlertFullTitle: 'Fall sailing schedule starts in one week on Sunday, September 20' }),
      alert({ BulletinID: 54, AlertFullTitle: 'PD/Tal- Point Defiance public restrooms out of service' }),
    ];
    expect(assignAlerts(muted, routeTerminals).size).toBe(0);
  });

  it('keeps an alert whose words match a muted phrase out of order', () => {
    const assigned = assignAlerts([alert({ BulletinID: 52, AlertFullTitle: 'Service restored: elevator back in operation' })], routeTerminals);
    expect(assigned.get(3)?.length).toBe(1);
  });

  it('strips markup out of the title and body', () => {
    const assigned = assignAlerts([alert({
      BulletinID: 6,
      AlertFullTitle: '<b>Cancelled</b>',
      BulletinText: '<p>The 4:40 sailing is cancelled.</p><p>See <a href="https://wsdot.com">wsdot.com</a>.</p>',
    })], routeTerminals);
    const view = assigned.get(3)?.[0];
    expect(view?.title).toBe('Cancelled');
    expect(view?.text).toBe('The 4:40 sailing is cancelled. See wsdot.com.');
    expect(view?.text).not.toContain('<');
  });

  it('orders by sort sequence and dedupes a repeated bulletin', () => {
    const assigned = assignAlerts([
      alert({ BulletinID: 8, SortSeq: 30, AlertFullTitle: 'Later' }),
      alert({ BulletinID: 7, SortSeq: 5, AlertFullTitle: 'Earlier' }),
      alert({ BulletinID: 7, SortSeq: 5, AlertFullTitle: 'Earlier' }),
    ], routeTerminals);
    expect(assigned.get(3)?.map((entry) => entry.title)).toEqual(['Earlier', 'Later']);
  });
});

describe('AlertDirectory', () => {
  it('serves the cache until the TTL expires', async () => {
    let clock = 1_000;
    const getScheduleAlerts = vi.fn().mockResolvedValue([alert({ BulletinID: 1 })]);
    const directory = new AlertDirectory({ getScheduleAlerts } as unknown as WsdotClient, () => clock);

    expect(await directory.list()).toHaveLength(1);
    await directory.list();
    expect(getScheduleAlerts).toHaveBeenCalledTimes(1);

    clock += 300_001;
    await directory.list();
    await vi.waitFor(() => expect(getScheduleAlerts).toHaveBeenCalledTimes(2));
  });

  it('keeps serving the previous list when a refresh fails', async () => {
    let clock = 1_000;
    const getScheduleAlerts = vi.fn()
      .mockResolvedValueOnce([alert({ BulletinID: 1 })])
      .mockRejectedValue(new Error('WSDOT returned HTTP 503.'));
    const directory = new AlertDirectory({ getScheduleAlerts } as unknown as WsdotClient, () => clock);

    await directory.list();
    clock += 300_001;
    expect(await directory.list()).toHaveLength(1);
  });

  it('answers with an empty list rather than rejecting on a cold failure', async () => {
    const getScheduleAlerts = vi.fn().mockRejectedValue(new Error('WSDOT returned HTTP 503.'));
    const directory = new AlertDirectory({ getScheduleAlerts } as unknown as WsdotClient);
    expect(await directory.list()).toEqual([]);
  });
});

describe('RouteDirectory', () => {
  const routes = [{ RouteID: 5 }, { RouteID: 7 }];
  const mates: Record<number, Array<Record<string, number>>> = {
    5: [{ DepartingTerminalID: 7, ArrivingTerminalID: 3 }, { DepartingTerminalID: 3, ArrivingTerminalID: 7 }],
    7: [{ DepartingTerminalID: 7, ArrivingTerminalID: 9 }],
  };

  function client() {
    return {
      getRoutes: vi.fn().mockResolvedValue(routes),
      getTerminalsAndMatesByRoute: vi.fn((routeId: number) => Promise.resolve(mates[routeId])),
    };
  }

  it('maps each route to its terminals without blocking the first call', async () => {
    const stub = client();
    const directory = new RouteDirectory(stub as unknown as WsdotClient);
    // A cold map answers immediately so a terminal request never waits on ~20 route calls.
    expect(directory.list().size).toBe(0);
    await vi.waitFor(() => expect(directory.list().get(5)).toEqual([7, 3]));
    expect(directory.list().get(7)).toEqual([7, 9]);
  });

  it('rebuilds when the Pacific service date rolls', async () => {
    const stub = client();
    let clock = Date.parse('2026-09-12T20:00:00Z');
    const directory = new RouteDirectory(stub as unknown as WsdotClient, () => clock);
    directory.list();
    await vi.waitFor(() => expect(stub.getRoutes).toHaveBeenCalledTimes(1));

    directory.list();
    expect(stub.getRoutes).toHaveBeenCalledTimes(1);

    clock += 86_400_000;
    directory.list();
    await vi.waitFor(() => expect(stub.getRoutes).toHaveBeenCalledTimes(2));
  });

  it('leaves the map empty and retries later when routes cannot be read', async () => {
    const stub = { getRoutes: vi.fn().mockRejectedValue(new Error('boom')), getTerminalsAndMatesByRoute: vi.fn() };
    const directory = new RouteDirectory(stub as unknown as WsdotClient);
    directory.list();
    await vi.waitFor(() => expect(stub.getRoutes).toHaveBeenCalledTimes(1));
    // Degrades to all-routes alerts rather than failing the terminal request.
    expect(directory.list().size).toBe(0);
  });
});
