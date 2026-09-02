const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  // en-US with hour12:false yields the h24 cycle, which formats midnight as 24. Force h23.
  hourCycle: 'h23',
  weekday: 'short',
});

const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface PacificParts {
  /** YYYY-MM-DD in America/Los_Angeles. */
  serviceDate: string;
  /** 0 = Sunday through 6 = Saturday. */
  weekday: number;
  /** 0 through 23. */
  hourLocal: number;
  minuteLocal: number;
}

export function pacificParts(value: string | number | Date): PacificParts | null {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.valueOf())) return null;

  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const weekday = weekdays[parts.weekday ?? ''];
  if (weekday === undefined) return null;

  return {
    serviceDate: `${parts.year}-${parts.month}-${parts.day}`,
    weekday,
    hourLocal: Number(parts.hour),
    minuteLocal: Number(parts.minute),
  };
}
