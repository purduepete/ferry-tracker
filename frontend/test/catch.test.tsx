import { describe, expect, it } from 'vitest';
import { catchDeparture, catchWindowLevel, catchWindows, normalizeSettings } from '../src/format';

const at = (time: string) => Date.parse(`2026-09-06T${time}-07:00`);
const sailing = {
  departingTime: new Date(at('11:35:00')).toISOString(), departingTerminalId: 3,
  vesselId: 18, vesselName: 'Tacoma', isCancelled: false,
  spaceAvailable: true, driveUpSpaceCount: 180, reservableSpaceCount: null, maxSpaceCount: 197,
};
const next = { ...sailing, departingTime: new Date(at('12:20:00')).toISOString() };
const timing = { trafficMinutes: 15, queueMinutes: 15 };
const inbound = {
  id: 18, atDock: false, speed: 14, leftDock: null,
  scheduledDeparture: new Date(at('10:30:00')).toISOString(), arrivingTerminalId: 3,
  eta: new Date(at('11:47:00')).toISOString(), updatedAt: new Date(at('11:20:00')).toISOString(),
};

describe('Catch traffic cutoff', () => {
  it.each([0, 7])('uses yellow below %i only before the raw queue boundary', (catchSoonMinutes) => {
    const settings = normalizeSettings({ catchSoonMinutes, catchImminentMinutes: 30 });
    const windowAt = (now: number) => catchWindows([sailing], now, timing)[0];
    const leaveBy = at('11:05:00');
    if (catchSoonMinutes > 0) {
      expect(catchWindowLevel(windowAt(leaveBy - catchSoonMinutes * 60000), settings)).toBe('clear');
      expect(catchWindowLevel(windowAt(leaveBy - (catchSoonMinutes - 1) * 60000), settings)).toBe('soon');
    }
    expect(catchWindowLevel(windowAt(leaveBy - 1), settings)).toBe(catchSoonMinutes ? 'soon' : 'clear');
    expect(catchWindowLevel(windowAt(leaveBy), settings)).toBe('imminent');
    expect(catchWindowLevel(windowAt(leaveBy + 60000), settings)).toBe('imminent');
  });

  it.each([0, 5, 15, 30])('starts the %i minute queue countdown at the raw leave-by boundary', (queueMinutes) => {
    const options = { ...timing, queueMinutes };
    const cutoff = at('11:20:00');
    const leaveBy = cutoff - queueMinutes * 60000;
    expect(catchWindows([sailing], leaveBy - 1, options)[0].queueMinutesRemaining).toBeNull();
    expect(catchWindows([sailing], leaveBy, options)[0].queueMinutesRemaining).toBe(queueMinutes);
    if (queueMinutes > 0) {
      expect(catchWindows([sailing], leaveBy + 1, options)[0].queueMinutesRemaining).toBe(queueMinutes);
      expect(catchWindows([sailing], leaveBy + 60000, options)[0].queueMinutesRemaining).toBe(queueMinutes - 1);
    }
    expect(catchWindows([sailing], cutoff, options)[0].queueMinutesRemaining).toBe(0);
    expect(catchWindows([sailing], cutoff + 1, options)).toEqual([]);
  });

  it('keeps independent scheduled and estimated queue phases', () => {
    const fresh = { ...inbound, updatedAt: new Date(at('11:10:00')).toISOString() };
    expect(catchWindows([sailing], at('11:10:00'), timing, [fresh])[0]).toMatchObject({
      queueMinutesRemaining: 10, estimatedQueueMinutesRemaining: null, estimatedMinutesAway: 7,
    });
    expect(catchWindowLevel(catchWindows([sailing], at('11:10:00'), timing, [fresh])[0])).toBe('soon');
    expect(catchWindows([sailing], at('11:21:43'), timing, [inbound])[0]).toMatchObject({
      queueMinutesRemaining: 0, estimatedQueueMinutesRemaining: 11, dimScheduled: true,
    });
    expect(catchWindowLevel(catchWindows([sailing], at('11:21:43'), timing, [inbound])[0])).toBe('imminent');
  });

  it('uses raw seconds for phase changes and clock minutes for display', () => {
    const withSeconds = { ...sailing, departingTime: new Date(at('11:35:30')).toISOString() };
    expect(catchWindows([withSeconds], at('11:05:30') - 1, timing)[0]).toMatchObject({ minutesAway: 0, queueMinutesRemaining: null });
    expect(catchWindows([withSeconds], at('11:05:30'), timing)[0].queueMinutesRemaining).toBe(15);
    expect(catchWindows([withSeconds], at('11:06:00'), timing)[0].queueMinutesRemaining).toBe(14);
    expect(catchWindows([withSeconds], at('11:20:30'), timing)[0].queueMinutesRemaining).toBe(0);
    expect(catchWindows([withSeconds], at('11:20:30') + 1, timing)).toEqual([]);
  });

  it.each([0, 5, 15, 30])('consumes only the %i minute queue allowance', (queueMinutes) => {
    const options = { ...timing, queueMinutes };
    const cutoff = at('11:20:00');
    expect(catchWindows([sailing], cutoff - 1, options)).toHaveLength(1);
    expect(catchWindows([sailing], cutoff, options)[0].minutesAway).toBe(0 - queueMinutes);
    expect(catchWindows([sailing, next], cutoff + 1, options).map((window) => window.departureAt)).toEqual([next.departingTime]);
  });

  it('extends the cutoff using a fresh projected departure, with two clock-minute values', () => {
    expect(catchWindows([sailing], at('11:21:43'), timing, [inbound])[0]).toMatchObject({
      minutesAway: -16, estimatedMinutesAway: -4, dimScheduled: true,
      leaveByAt: new Date(at('11:05:00')).toISOString(),
      estimatedLeaveByAt: new Date(at('11:17:00')).toISOString(),
    });
    const fresh = { ...inbound, updatedAt: new Date(at('11:32:00')).toISOString() };
    expect(catchWindows([sailing], at('11:32:00'), timing, [fresh])).toHaveLength(1);
    expect(catchWindows([sailing, next], at('11:32:00') + 1, timing, [fresh]).map((window) => window.departureAt)).toEqual([next.departingTime]);
  });

  it.each([null, 'invalid', '11:15:59.999', '11:21:00.001'])('rejects unusable projected timestamp %s', (stamp) => {
    const updatedAt = stamp === null || stamp === 'invalid' ? stamp : new Date(at(stamp)).toISOString();
    expect(catchWindows([sailing, next], at('11:21:00'), timing, [{ ...inbound, updatedAt }]).map((window) => window.departureAt)).toEqual([next.departingTime]);
  });

  it('dims an inbound estimate only after scheduled queue slack is exceeded', () => {
    const cutoff = at('11:20:00');
    const fresh = { ...inbound, updatedAt: new Date(cutoff - 60000).toISOString() };
    expect(catchWindows([sailing], cutoff - 1, timing, [fresh])[0].dimScheduled).toBe(false);
    expect(catchWindows([sailing], cutoff, timing, [fresh])[0].dimScheduled).toBe(false);
    expect(catchWindows([sailing], cutoff + 1, timing, [fresh])[0].dimScheduled).toBe(true);
    expect(catchWindows([sailing], cutoff, timing)[0].dimScheduled).toBe(false);
  });

  it('expires projected evidence after exactly five minutes', () => {
    const stamp = at('11:16:00');
    const vessel = { ...inbound, updatedAt: new Date(stamp).toISOString() };
    expect(catchWindows([sailing], stamp + 300000, timing, [vessel])).toHaveLength(1);
    expect(catchWindows([sailing], stamp + 300001, timing, [vessel])).toEqual([]);
  });

  it('keeps observed delay detection but advances when the drive cannot fit', () => {
    const now = at('12:10:00');
    const docked = { ...inbound, atDock: true, speed: 0, scheduledDeparture: sailing.departingTime, updatedAt: new Date(now).toISOString() };
    expect(catchDeparture(sailing, [docked], now)).toMatchObject({ delayMinutes: 35, delaySource: 'observed' });
    const later = { ...next, departingTime: new Date(at('13:00:00')).toISOString() };
    expect(catchWindows([sailing, later], now, timing, [docked]).map((window) => window.departureAt)).toEqual([later.departingTime]);
    expect(catchWindows([sailing], now, timing, [docked])).toEqual([]);
    expect(catchWindows([sailing], now, { trafficMinutes: 0, queueMinutes: 15 }, [docked])[0])
      .toMatchObject({ minutesAway: -50, estimatedMinutesAway: -15, dimScheduled: true, queueMinutesRemaining: 0, estimatedQueueMinutesRemaining: 0 });
    expect(catchWindows([sailing], now, { trafficMinutes: 0, queueMinutes: 15 }, [{ ...docked, updatedAt: null }])[0].dimScheduled).toBe(false);
  });

  it('retires zero-traffic sailings at departure without observed dock evidence', () => {
    expect(catchWindows([sailing], at('11:35:00'), { trafficMinutes: 0, queueMinutes: 0 })).toEqual([]);
  });

  it('does not lend a vessel estimate to an earlier slot beyond the delay cap', () => {
    const earlier = { ...sailing, departingTime: new Date(at('10:35:00')).toISOString() };
    expect(catchWindows([earlier, sailing], at('11:21:00'), timing, [inbound]).map((window) => window.departureAt)).toEqual([sailing.departingTime]);
  });

  it('uses exact cutoff timestamps across midnight with seconds in the estimate', () => {
    const departure = Date.parse('2026-09-07T00:05:30-07:00');
    const midnightSailing = { ...sailing, departingTime: new Date(departure).toISOString() };
    const cutoff = departure - 15 * 60000;
    expect(catchWindows([midnightSailing], cutoff, timing)[0].minutesAway).toBe(-15);
    expect(catchWindows([midnightSailing], cutoff + 1, timing)).toEqual([]);
  });

  it('uses estimated urgency when available and keeps vehicle-space urgency', () => {
    expect(catchWindowLevel({ minutesAway: -16, estimatedMinutesAway: 12, spacePercent: 90 })).toBe('clear');
    expect(catchWindowLevel({ minutesAway: -16, estimatedMinutesAway: 12, spacePercent: 10 })).toBe('imminent');
  });
});