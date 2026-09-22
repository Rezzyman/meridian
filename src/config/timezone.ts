/**
 * Timezone resolution for every scheduler in the runtime.
 *
 * Defect (b) from the July 2026 production run: four schedulers defaulted to
 * a hard-coded America/Chicago when TZ was unset, so briefs fired an hour off
 * for a Denver operator and nobody could see why. The runtime now resolves
 * the first VALID IANA zone from an explicit chain and falls back to UTC,
 * which is at least honest. `doctor` warns when nothing is configured.
 */
export const DEFAULT_TIMEZONE = 'UTC';

export function isValidTimezone(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** First valid zone wins; UTC when nothing valid was supplied. */
export function resolveTimezone(...candidates: Array<string | undefined | null>): string {
  for (const c of candidates) if (isValidTimezone(c)) return c;
  return DEFAULT_TIMEZONE;
}

/** True when a real zone (not the UTC fallback) was configured somewhere. */
export function timezoneConfigured(...candidates: Array<string | undefined | null>): boolean {
  return candidates.some((c) => isValidTimezone(c));
}
