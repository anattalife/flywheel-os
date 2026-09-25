import type { Tx } from '../db/pool.js';
import { addLocalDays, hhmm, localParts, minutesOf, weekdayOf, zonedTime } from '../lib/tz.js';
import type { Business } from './business.js';
import { emit } from './events.js';

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

export interface Busy { id: string; starts_at: Date; ends_at: Date }
export interface Hours { weekday: number; opens: string; closes: string }

export function schedulingRules(b: Business) {
  const s = b.pack.scheduling;
  const o = (b.settings?.scheduling ?? {}) as Partial<typeof s>;
  return { ...s, ...o };
}

/** Serialize booking changes for one business, so two customers can't grab the last slot at once. */
export async function lockSchedule(tx: Tx, businessId: string) {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`schedule:${businessId}`]);
}

export async function loadHours(tx: Tx): Promise<Hours[]> {
  const r = await tx.query<{ weekday: number; opens: string; closes: string }>(`select weekday, opens::text, closes::text from business_hours order by weekday, opens`);
  return r.rows.map((h) => ({ weekday: h.weekday, opens: h.opens.slice(0, 5), closes: h.closes.slice(0, 5) }));
}

async function busyBetween(tx: Tx, from: Date, to: Date, excludeId?: string | null): Promise<Busy[]> {
  const r = await tx.query<Busy>(
    `select id, starts_at, ends_at from bookings
     where status in ('confirmed','requested') and not skipped and starts_at < $2 and ends_at > $1 and ($3::uuid is null or id <> $3)
     union all
     select id, starts_at, ends_at from time_off where staff_id is null and starts_at < $2 and ends_at > $1`,
    [from, to, excludeId ?? null],
  );
  return r.rows.map((b) => ({ ...b, starts_at: new Date(b.starts_at), ends_at: new Date(b.ends_at) }));
}

async function timeOffIds(tx: Tx, from: Date, to: Date): Promise<Set<string>> {
  const r = await tx.query<{ id: string }>(`select id from time_off where staff_id is null and starts_at < $2 and ends_at > $1`, [from, to]);
  return new Set(r.rows.map((x) => x.id));
}

function fits(start: Date, end: Date, busy: Busy[], offIds: Set<string>, capacity: number, bufferMin: number): boolean {
  const buf = bufferMin * 60_000;
  let overlapping = 0;
  for (const b of busy) {
    if (offIds.has(b.id)) {
      if (b.starts_at < end && b.ends_at > start) return false; // time off blocks outright
      continue;
    }
    if (b.starts_at.getTime() < end.getTime() + buf && b.ends_at.getTime() + buf > start.getTime()) overlapping++;
    if (overlapping >= capacity) return false;
  }
  return true;
}

function withinHours(start: Date, end: Date, hours: Hours[], tz: string): boolean {
  const s = localParts(start, tz);
  const e = localParts(new Date(end.getTime() - 60_000), tz);
  if (s.date !== e.date) return false;
  const from = s.hour * 60 + s.minute;
  const to = e.hour * 60 + e.minute + 1;
  return hours.some((h) => h.weekday === s.weekday && minutesOf(h.opens) <= from && minutesOf(h.closes) >= to);
}

export interface SlotDay { date: string; slots: string[] }

/**
 * Open start times for a job of `durationMin`, day by day, in the business's
 * timezone: inside opening hours, after the minimum notice, within the booking
 * horizon, clear of time off, and under capacity (including travel buffer).
 */
export async function availableSlots(tx: Tx, business: Business, opts: { durationMin: number; fromDate?: string; days?: number; now?: Date; excludeBookingId?: string | null }): Promise<SlotDay[]> {
  const rules = schedulingRules(business);
  const tz = business.timezone;
  const now = opts.now ?? new Date();
  const earliest = new Date(now.getTime() + rules.min_notice_hours * 3_600_000);
  const latest = new Date(now.getTime() + rules.max_days_ahead * 86_400_000);
  const startDate = opts.fromDate ?? localParts(now, tz).date;
  const days = Math.min(opts.days ?? 7, 62);
  const rangeFrom = zonedTime(startDate, '00:00', tz);
  const rangeTo = zonedTime(addLocalDays(startDate, days + 1), '00:00', tz);
  const [hours, busy, off] = await Promise.all([loadHours(tx), busyBetween(tx, rangeFrom, rangeTo, opts.excludeBookingId), timeOffIds(tx, rangeFrom, rangeTo)]);
  const out: SlotDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = addLocalDays(startDate, i);
    const wd = weekdayOf(date);
    const slots: string[] = [];
    for (const h of hours.filter((x) => x.weekday === wd)) {
      for (let t = minutesOf(h.opens); t + opts.durationMin <= minutesOf(h.closes); t += rules.slot_step_min) {
        const start = zonedTime(date, hhmm(t), tz);
        if (start < earliest || start > latest) continue;
        const end = new Date(start.getTime() + opts.durationMin * 60_000);
        if (fits(start, end, busy, off, rules.capacity, rules.buffer_min)) slots.push(start.toISOString());
      }
    }
    out.push({ date, slots });
  }
  return out;
}

/**
 * Throw 409 unless [start, end) is free. Customers (online, portal, AI) must also
 * book inside opening hours and after the minimum notice; the owner may override both.
 */
export async function assertSlotFree(tx: Tx, business: Business, start: Date, end: Date, opts: { excludeBookingId?: string | null; enforceHours: boolean; now?: Date }) {
  await lockSchedule(tx, business.id);
  const rules = schedulingRules(business);
  if (opts.enforceHours) {
    const now = opts.now ?? new Date();
    if (start.getTime() < now.getTime() + rules.min_notice_hours * 3_600_000) throw err(409, 'That time is too soon to book online. Pick a later time.');
    if (!withinHours(start, end, await loadHours(tx), business.timezone)) throw err(409, 'That time is outside opening hours.');
  }
  const pad = (rules.buffer_min + 1) * 60_000;
  const [busy, off] = await Promise.all([
    busyBetween(tx, new Date(start.getTime() - pad), new Date(end.getTime() + pad), opts.excludeBookingId),
    timeOffIds(tx, new Date(start.getTime() - pad), new Date(end.getTime() + pad)),
  ]);
  if (!fits(start, end, busy, off, rules.capacity, rules.buffer_min)) throw err(409, 'That time was just taken or is blocked. Pick another time.');
}

// ---------- recurring series ----------

export interface SeriesRow {
  id: string; customer_id: string; service_id: string | null; place_id: string | null; staff_id: string | null;
  recurrence_key: string; interval_days: number; anchor_at: Date; duration_min: number; price_cents: number | null;
  inputs: Record<string, unknown>; status: 'active' | 'paused' | 'ended'; paused_until: Date | null;
}

/** Create visits for a series up to `until`, keeping the first visit's local time of day across DST. */
export async function extendSeries(tx: Tx, business: Business, seriesId: string, until: Date) {
  const s = (await tx.query<SeriesRow>(`select * from series where id = $1 for update`, [seriesId])).rows[0];
  if (!s || s.status === 'ended') return 0;
  const tz = business.timezone;
  const anchor = localParts(new Date(s.anchor_at), tz);
  let created = 0;
  for (let k = 0; ; k++) {
    const start = zonedTime(addLocalDays(anchor.date, k * s.interval_days), anchor.time, tz);
    if (start > until) break;
    if (start < new Date()) continue;
    if (s.status === 'paused' && s.paused_until && start < new Date(s.paused_until)) continue;
    const end = new Date(start.getTime() + s.duration_min * 60_000);
    const exists = await tx.query(`select 1 from bookings where series_id = $1 and starts_at = $2`, [s.id, start]);
    if (exists.rowCount) continue;
    let status: 'confirmed' | 'requested' = 'confirmed';
    try { await assertSlotFree(tx, business, start, end, { enforceHours: false }); } catch { status = 'requested'; }
    const r = await tx.query<{ id: string }>(
      `insert into bookings (business_id, customer_id, service_id, place_id, staff_id, starts_at, ends_at, status, recurrence_key, series_id, price_cents, inputs, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'series') on conflict do nothing returning id`,
      [business.id, s.customer_id, s.service_id, s.place_id, s.staff_id, start, end, status, s.recurrence_key, s.id, s.price_cents, s.inputs],
    );
    if (!r.rows[0]) continue;
    created++;
    await emit(tx, business.id, 'booking.created', { type: 'booking', id: r.rows[0].id }, { customer_id: s.customer_id, source: 'series', series_id: s.id, price_cents: s.price_cents });
    if (status === 'requested') await emit(tx, business.id, 'series.conflict', { type: 'booking', id: r.rows[0].id }, { series_id: s.id });
  }
  if (s.status === 'paused' && s.paused_until && new Date(s.paused_until) <= new Date()) {
    await tx.query(`update series set status = 'active', paused_until = null where id = $1`, [s.id]);
  }
  return created;
}

export async function extendAllSeries(tx: Tx, business: Business, now = new Date()) {
  const horizon = new Date(now.getTime() + schedulingRules(business).series_horizon_days * 86_400_000);
  const ids = (await tx.query<{ id: string }>(`select id from series where status in ('active','paused')`)).rows;
  let n = 0;
  for (const { id } of ids) n += await extendSeries(tx, business, id, horizon);
  return n;
}

/** Pause until a date: future visits before then are cancelled (not counted as cancellations). */
export async function pauseSeries(tx: Tx, business: Business, seriesId: string, until: Date) {
  const r = await tx.query(`update series set status = 'paused', paused_until = $2 where id = $1 and status <> 'ended' returning id, customer_id`, [seriesId, until]);
  if (!r.rowCount) throw err(404, 'recurring plan not found');
  await tx.query(`update bookings set status = 'cancelled', skipped = true where series_id = $1 and status in ('confirmed','requested') and starts_at > now() and starts_at < $2`, [seriesId, until]);
  await emit(tx, business.id, 'series.paused', { type: 'series', id: seriesId }, { customer_id: r.rows[0].customer_id, until: until.toISOString() });
}

export async function resumeSeries(tx: Tx, business: Business, seriesId: string) {
  const r = await tx.query(`update series set status = 'active', paused_until = null where id = $1 and status = 'paused' returning id, customer_id`, [seriesId]);
  if (!r.rowCount) throw err(404, 'no paused plan with that id');
  await extendSeries(tx, business, seriesId, new Date(Date.now() + schedulingRules(business).series_horizon_days * 86_400_000));
  await emit(tx, business.id, 'series.resumed', { type: 'series', id: seriesId }, { customer_id: r.rows[0].customer_id });
}

export async function endSeries(tx: Tx, business: Business, seriesId: string, reasonCode?: string) {
  const r = await tx.query<{ customer_id: string }>(`update series set status = 'ended' where id = $1 and status <> 'ended' returning customer_id`, [seriesId]);
  if (!r.rowCount) throw err(404, 'recurring plan not found');
  await tx.query(`update bookings set status = 'cancelled' where series_id = $1 and status in ('confirmed','requested') and starts_at > now()`, [seriesId]);
  if (reasonCode) {
    await tx.query(`insert into reasons (business_id, customer_id, kind, code) values ($1, $2, 'cancel', $3)`, [business.id, r.rows[0].customer_id, reasonCode]);
  }
  await emit(tx, business.id, 'series.ended', { type: 'series', id: seriesId }, { customer_id: r.rows[0].customer_id, reason: reasonCode ?? null });
}

/** Skip one visit of a plan. It does not count as a cancellation. */
export async function skipBooking(tx: Tx, business: Business, bookingId: string) {
  const r = await tx.query<{ customer_id: string }>(
    `update bookings set status = 'cancelled', skipped = true where id = $1 and series_id is not null and status in ('confirmed','requested') and starts_at > now() returning customer_id`,
    [bookingId]);
  if (!r.rowCount) throw err(409, 'Only upcoming visits in a recurring plan can be skipped.');
  await emit(tx, business.id, 'booking.skipped', { type: 'booking', id: bookingId }, { customer_id: r.rows[0].customer_id });
}

export async function rescheduleBooking(tx: Tx, business: Business, bookingId: string, newStart: Date, opts: { enforceHours: boolean; by: string }) {
  const b = (await tx.query<{ id: string; customer_id: string; starts_at: Date; ends_at: Date; status: string }>(
    `select id, customer_id, starts_at, ends_at, status from bookings where id = $1 for update`, [bookingId])).rows[0];
  if (!b || !['confirmed', 'requested'].includes(b.status)) throw err(409, 'Only upcoming bookings can be moved.');
  if (Number.isNaN(newStart.getTime())) throw err(400, 'That is not a valid time.');
  const duration = new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime();
  const newEnd = new Date(newStart.getTime() + duration);
  await assertSlotFree(tx, business, newStart, newEnd, { excludeBookingId: b.id, enforceHours: opts.enforceHours });
  await tx.query(`update bookings set starts_at = $2, ends_at = $3, status = 'confirmed' where id = $1`, [b.id, newStart, newEnd]);
  await emit(tx, business.id, 'booking.rescheduled', { type: 'booking', id: b.id }, { customer_id: b.customer_id, from: new Date(b.starts_at).toISOString(), to: newStart.toISOString(), by: opts.by });
}

/** Replace the weekly opening hours. */
export async function setHours(tx: Tx, businessId: string, hours: Hours[]) {
  for (const h of hours) {
    if (!/^\d\d:\d\d$/.test(h.opens) || !/^\d\d:\d\d$/.test(h.closes) || minutesOf(h.closes) <= minutesOf(h.opens)) throw err(400, 'Each range needs an opening time before its closing time.');
  }
  await tx.query(`delete from business_hours`);
  for (const h of hours) await tx.query(`insert into business_hours (business_id, weekday, opens, closes) values ($1, $2, $3, $4)`, [businessId, h.weekday, h.opens, h.closes]);
}
