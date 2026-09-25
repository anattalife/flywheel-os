/** Minutes since local midnight for `at` in the given IANA timezone. */
export function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  return h * 60 + m;
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True when `at` falls inside quiet hours (a window that may wrap past midnight). */
export function inQuietHours(at: Date, timeZone: string, quiet: { start: string; end: string }): boolean {
  const now = localMinutes(at, timeZone);
  const start = toMin(quiet.start);
  const end = toMin(quiet.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** The next moment quiet hours end, searched minute-accurately within 24h. */
export function nextAllowedTime(at: Date, timeZone: string, quiet: { start: string; end: string }): Date {
  if (!inQuietHours(at, timeZone, quiet)) return at;
  const now = localMinutes(at, timeZone);
  const end = toMin(quiet.end);
  const wait = (end - now + 24 * 60) % (24 * 60);
  const candidate = new Date(at.getTime() + wait * 60_000);
  candidate.setUTCSeconds(0, 0);
  // A daylight-saving shift can leave us up to an hour short; step forward until clear.
  for (let i = 0; i < 8 && inQuietHours(candidate, timeZone, quiet); i++) candidate.setTime(candidate.getTime() + 15 * 60_000);
  return candidate;
}

export const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
