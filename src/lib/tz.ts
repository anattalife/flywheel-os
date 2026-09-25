/** Timezone helpers. All scheduling is done in the business's own timezone. */

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number; date: string; time: string }

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(at: Date, timeZone: string): LocalParts {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  const year = Number(g('year')), month = Number(g('month')), day = Number(g('day')), hour = Number(g('hour')), minute = Number(g('minute'));
  return {
    year, month, day, hour, minute, weekday: WEEKDAYS[g('weekday')],
    date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}`,
  };
}

function offsetMs(at: Date, timeZone: string): number {
  const l = localParts(at, timeZone);
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute) - Math.floor(at.getTime() / 60000) * 60000;
}

/** The instant when the wall clock in `timeZone` reads `date` (YYYY-MM-DD) `time` (HH:MM). */
export function zonedTime(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ms = guess - offsetMs(new Date(guess), timeZone);
  ms = guess - offsetMs(new Date(ms), timeZone);
  return new Date(ms);
}

/** YYYY-MM-DD plus n calendar days. */
export function addLocalDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Local midnight-to-midnight of the day containing `at`. */
export function dayBounds(at: Date, timeZone: string) {
  const label = localParts(at, timeZone).date;
  return { label, start: zonedTime(label, '00:00', timeZone), end: zonedTime(addLocalDays(label, 1), '00:00', timeZone) };
}

export const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** "Tue, Sep 30 at 10:00 AM" in the business's timezone. */
export function friendlyWhen(at: Date, timeZone: string): string {
  const d = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(at);
  const t = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(at);
  return `${d} at ${t}`;
}
