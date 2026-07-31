export interface DeterministicTask {
  stop(): void;
  getNextRun(): Date | null;
}

interface CronFields {
  second: Set<number>;
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  dayWildcard: boolean;
  weekdayWildcard: boolean;
  hasSeconds: boolean;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function field(source: string, min: number, max: number, sundayAlias = false): Set<number> {
  const out = new Set<number>();
  for (const segment of source.split(',')) {
    const [base, stepRaw] = segment.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step '${segment}'`);
    let start: number;
    let end: number;
    if (base === '*') [start, end] = [min, max];
    else if (base?.includes('-')) [start, end] = base.split('-').map(Number) as [number, number];
    else start = end = Number(base);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`invalid cron field '${segment}'`);
    }
    for (let value = start; value <= end; value += step) out.add(sundayAlias && value === 7 ? 0 : value);
  }
  return out;
}

function parse(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) throw new Error(`cron must have 5 or 6 fields: '${expression}'`);
  const hasSeconds = parts.length === 6;
  const [second, minute, hour, day, month, weekday] = hasSeconds ? parts : ['0', ...parts];
  return {
    second: field(second!, 0, 59), minute: field(minute!, 0, 59), hour: field(hour!, 0, 23),
    day: field(day!, 1, 31), month: field(month!, 1, 12), weekday: field(weekday!, 0, 7, true),
    dayWildcard: day === '*', weekdayWildcard: weekday === '*', hasSeconds,
  };
}

function localParts(date: Date, timezone: string): { second: number; minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const weekday = WEEKDAY[parts.find((part) => part.type === 'weekday')?.value ?? ''];
  if (weekday === undefined) throw new Error(`could not resolve weekday in timezone '${timezone}'`);
  return { second: get('second'), minute: get('minute'), hour: get('hour'), day: get('day'), month: get('month'), weekday };
}

function matches(cron: CronFields, value: ReturnType<typeof localParts>): boolean {
  const dayMatches = cron.day.has(value.day);
  const weekdayMatches = cron.weekday.has(value.weekday);
  const calendarMatches = cron.dayWildcard
    ? weekdayMatches
    : cron.weekdayWildcard
      ? dayMatches
      : dayMatches || weekdayMatches;
  return cron.second.has(value.second) && cron.minute.has(value.minute) && cron.hour.has(value.hour) && cron.month.has(value.month) && calendarMatches;
}

export function nextCronOccurrence(expression: string, from = new Date(), timezone = 'UTC'): Date {
  const cron = parse(expression);
  const quantum = cron.hasSeconds ? 1_000 : 60_000;
  let epoch = Math.floor(from.getTime() / quantum) * quantum + quantum;
  const max = epoch + 370 * 24 * 3600 * 1000;
  for (; epoch <= max; epoch += quantum) {
    const candidate = new Date(epoch);
    if (matches(cron, localParts(candidate, timezone))) return candidate;
  }
  throw new Error(`cron has no occurrence within 370 days: '${expression}'`);
}

export function scheduleDeterministic(
  expression: string,
  callback: (scheduledAt: Date) => void | Promise<void>,
  options: { timezone: string; onScheduled?: (next: Date) => void } ,
): DeterministicTask {
  let timer: NodeJS.Timeout | null = null;
  let next: Date | null = null;
  let stopped = false;

  const arm = (from: Date) => {
    if (stopped) return;
    next = nextCronOccurrence(expression, from, options.timezone);
    options.onScheduled?.(next);
    const delay = Math.min(Math.max(0, next.getTime() - Date.now()), 2_147_000_000);
    timer = setTimeout(async () => {
      if (stopped || !next) return;
      // Very long delays are re-armed rather than fired early at the platform
      // timer ceiling.
      if (Date.now() + 500 < next.getTime()) return arm(new Date());
      const scheduledAt = next;
      try { await callback(scheduledAt); }
      finally { arm(scheduledAt); }
    }, delay);
    timer.unref();
  };
  arm(new Date());
  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; next = null; },
    getNextRun() { return next ? new Date(next) : null; },
  };
}
