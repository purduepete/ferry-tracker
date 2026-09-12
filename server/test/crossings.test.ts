import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database';
import { CROSSING_CACHE_MS } from '../src/history/crossingMedians';
import { DatabaseSailingHistory } from '../src/history/sailingHistory';

const SEATTLE = 7;
const BAINBRIDGE = 3;
const NOW = Date.parse('2026-09-02T00:00:00.000Z');

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => db.close());

interface CrossingInput {
  minutes: number;
  departedAt?: string;
  from?: number;
  to?: number;
  confidence?: string;
  exclusionReason?: string | null;
}

const insertLeg = () => db.prepare(`INSERT INTO sailing_leg (
  vessel_id, vessel_name, departing_terminal_id, arriving_terminal_id, scheduled_departure,
  departed_at, dock_arrival_at, crossing_minutes, departure_delay_minutes, complete, confidence,
  exclusion_reason, service_date, weekday, hour_local
) VALUES (1, 'Tacoma', ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, '2026-09-01', 2, 11)`);

// Legs are written newest first, so index 0 is the most recent crossing on the pair.
function logCrossings(inputs: CrossingInput[]): void {
  const insert = insertLeg();

  inputs.forEach((input, index) => {
    const departedAt = input.departedAt ?? new Date(NOW - (index + 1) * 60 * 60 * 1000).toISOString();
    const arrivedAt = new Date(Date.parse(departedAt) + input.minutes * 60 * 1000).toISOString();
    insert.run(
      input.from ?? SEATTLE,
      input.to ?? BAINBRIDGE,
      departedAt,
      departedAt,
      arrivedAt,
      input.minutes,
      input.confidence ?? 'high',
      input.exclusionReason ?? null,
    );
  });
}

function read(now = NOW) {
  return new DatabaseSailingHistory(db, () => now).crossings();
}

function pair(from: number, to: number, now = NOW) {
  return read(now).find((row) => row.departingTerminalId === from && row.arrivingTerminalId === to) ?? null;
}

describe('crossing medians', () => {
  it('reports the median and the tenth percentile of the recent crossings', () => {
    logCrossings([32, 33, 34, 35, 36, 37, 38].map((minutes) => ({ minutes })));

    expect(pair(SEATTLE, BAINBRIDGE)).toEqual({
      departingTerminalId: SEATTLE,
      arrivingTerminalId: BAINBRIDGE,
      medianMinutes: 35,
      fastMinutes: 32,
      samples: 7,
      borrowed: false,
    });
  });

  // The window is the last 7 usable crossings, so a rejected leg must not eat a slot and push
  // a good one out of range.
  it('drops excluded and low-confidence legs before it counts to seven', () => {
    logCrossings([
      { minutes: 34 },
      { minutes: 200, confidence: 'low' },
      { minutes: 34 },
      { minutes: 200, exclusionReason: 'schedule gap' },
      { minutes: 34 },
    ]);

    expect(pair(SEATTLE, BAINBRIDGE)?.samples).toBe(3);
    expect(pair(SEATTLE, BAINBRIDGE)?.medianMinutes).toBe(34);
  });

  it('keeps only the newest seven crossings', () => {
    logCrossings([...Array(7).fill({ minutes: 30 }), { minutes: 90 }, { minutes: 90 }]);

    expect(pair(SEATTLE, BAINBRIDGE)?.samples).toBe(7);
    expect(pair(SEATTLE, BAINBRIDGE)?.medianMinutes).toBe(30);
  });

  it('ignores a pair with fewer than three crossings', () => {
    logCrossings([{ minutes: 34 }, { minutes: 35 }]);

    expect(pair(SEATTLE, BAINBRIDGE)).toBeNull();
  });

  it('ignores crossings older than the fortnight', () => {
    logCrossings([32, 33, 34].map((minutes, index) => ({
      minutes,
      departedAt: new Date(NOW - (20 + index) * 24 * 60 * 60 * 1000).toISOString(),
    })));

    expect(pair(SEATTLE, BAINBRIDGE)).toBeNull();
  });

  // The rollup can close a leg against the terminal it left when an intermediate call goes
  // unobserved, which would otherwise report a two minute crossing.
  it('ignores a same-terminal leg', () => {
    logCrossings([{ minutes: 2, to: SEATTLE }, { minutes: 2, to: SEATTLE }, { minutes: 2, to: SEATTLE }]);

    expect(pair(SEATTLE, SEATTLE)).toBeNull();
  });

  // Those truncated legs also land on real pairs, where a raw tenth percentile would report a
  // two minute run on a fifty minute route.
  it('discards crossings far below the median before it takes a percentile', () => {
    logCrossings([{ minutes: 2 }, { minutes: 3 }, { minutes: 34 }, { minutes: 35 }, { minutes: 36 }]);

    expect(pair(SEATTLE, BAINBRIDGE)?.samples).toBe(3);
    expect(pair(SEATTLE, BAINBRIDGE)?.fastMinutes).toBe(34);
  });

  // Crossing time is near enough symmetric, so a quiet direction borrows from its reverse
  // rather than falling back to WSDOT.
  it('borrows the reverse direction for a pair with no crossings of its own', () => {
    logCrossings([{ minutes: 34 }, { minutes: 35 }, { minutes: 36 }]);

    expect(pair(BAINBRIDGE, SEATTLE)).toEqual({
      departingTerminalId: BAINBRIDGE,
      arrivingTerminalId: SEATTLE,
      medianMinutes: 35,
      fastMinutes: 34,
      samples: 3,
      borrowed: true,
    });
  });

  it('prefers a direction of its own over the reverse', () => {
    logCrossings([
      { minutes: 34 }, { minutes: 35 }, { minutes: 36 },
      { minutes: 50, from: BAINBRIDGE, to: SEATTLE },
      { minutes: 51, from: BAINBRIDGE, to: SEATTLE },
      { minutes: 52, from: BAINBRIDGE, to: SEATTLE },
    ]);

    expect(pair(BAINBRIDGE, SEATTLE)).toMatchObject({ medianMinutes: 51, borrowed: false });
  });

  it('holds the medians for two minutes, then reads again', () => {
    logCrossings([{ minutes: 34 }, { minutes: 35 }, { minutes: 36 }]);
    let clock = NOW;
    const history = new DatabaseSailingHistory(db, () => clock);
    const seattleBound = () => history.crossings()
      .find((row) => row.departingTerminalId === SEATTLE && row.arrivingTerminalId === BAINBRIDGE);
    expect(seattleBound()?.samples).toBe(3);

    logCrossings([{ minutes: 35, departedAt: '2026-09-01T23:59:00.000Z' }]);
    expect(seattleBound()?.samples).toBe(3);

    clock = NOW + CROSSING_CACHE_MS + 1;
    expect(seattleBound()?.samples).toBe(4);
  });
});
