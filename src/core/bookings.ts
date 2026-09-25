import type { Tx } from '../db/pool.js';
import { priceService } from '../packs/pricing.js';
import type { PriceRule } from '../packs/schema.js';
import { loadBusiness } from './business.js';
import { emit } from './events.js';
import { assertSlotFree, extendSeries, schedulingRules } from './scheduling.js';

export interface NewBooking {
  customer_id: string;
  service_key: string;
  starts_at: string | Date;
  inputs?: Record<string, unknown>;
  recurrence_key?: string | null;
  place_id?: string | null;
  staff_id?: string | null;
  price_cents?: number | null;   // owner-set price for quoted services
  notes?: string | null;
  source?: 'owner' | 'online' | 'portal' | 'ai' | 'import';
  force?: boolean;               // owner only: book even if the time overlaps
}

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function quote(tx: Tx, serviceKey: string, inputs: Record<string, unknown> = {}, recurrenceKey?: string | null) {
  const business = await loadBusiness(tx);
  const svc = (await tx.query<{ id: string; name: string; duration_min: number; price_rule: PriceRule }>(
    `select id, name, duration_min, price_rule from services where key = $1 and active`, [serviceKey],
  )).rows[0];
  if (!svc) throw err(404, `unknown service: ${serviceKey}`);
  const recurrence = recurrenceKey ? business.pack.recurrence.options.find((o) => o.key === recurrenceKey) : undefined;
  if (recurrenceKey && !recurrence) throw err(400, `unknown recurrence: ${recurrenceKey}`);
  return { service: svc, recurrence, ...priceService(svc.price_rule, inputs, recurrence) };
}

export async function createBooking(tx: Tx, businessId: string, b: NewBooking) {
  // Foreign keys bypass row-level security, so check every referenced row is this tenant's.
  const visible = await tx.query(
    `select (select count(*) from customers where id = $1)::int as c,
            (select count(*) from places where id = $2)::int as p,
            (select count(*) from staff where id = $3)::int as s`,
    [b.customer_id, b.place_id ?? null, b.staff_id ?? null]);
  const v = visible.rows[0];
  if (!v.c || (b.place_id && !v.p) || (b.staff_id && !v.s)) throw err(404, 'customer, place or team member not found');
  const q = await quote(tx, b.service_key, b.inputs, b.recurrence_key);
  const startsAt = new Date(b.starts_at);
  if (Number.isNaN(startsAt.getTime())) throw err(400, 'starts_at is not a valid date');
  startsAt.setUTCSeconds(0, 0);
  const minutes = Number(b.inputs?.minutes ?? q.service.duration_min);
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  const price = b.price_cents ?? q.amount_cents;
  const source = b.source ?? 'owner';
  const business = await loadBusiness(tx);
  if (!(source === 'owner' && b.force)) {
    await assertSlotFree(tx, business, startsAt, endsAt, { enforceHours: source !== 'owner' });
  }
  let seriesId: string | null = null;
  if (b.recurrence_key) {
    seriesId = (await tx.query<{ id: string }>(
      `insert into series (business_id, customer_id, service_id, place_id, staff_id, recurrence_key, interval_days, anchor_at, duration_min, price_cents, inputs)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [businessId, b.customer_id, q.service.id, b.place_id ?? null, b.staff_id ?? null, b.recurrence_key, q.recurrence!.interval_days,
        startsAt, minutes, price, b.inputs ?? {}],
    )).rows[0].id;
  }
  const r = await tx.query<{ id: string }>(
    `insert into bookings (business_id, customer_id, service_id, place_id, staff_id, starts_at, ends_at, status, recurrence_key, price_cents, inputs, notes, series_id, source)
     values ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, $9, $10, $11, $12, $13)
     returning id`,
    [businessId, b.customer_id, q.service.id, b.place_id ?? null, b.staff_id ?? null, startsAt, endsAt,
      b.recurrence_key ?? null, price, b.inputs ?? {}, b.notes ?? null, seriesId, source],
  );
  await emit(tx, businessId, 'booking.created', { type: 'booking', id: r.rows[0].id }, { customer_id: b.customer_id, price_cents: price, recurring: !!b.recurrence_key, source, series_id: seriesId });
  if (seriesId) {
    const horizon = new Date(Date.now() + schedulingRules(business).series_horizon_days * 86_400_000);
    await extendSeries(tx, business, seriesId, horizon);
  }
  return { id: r.rows[0].id, price_cents: price, series_id: seriesId, needs_owner_quote: q.needs_owner_quote && price == null };
}

export async function completeBooking(tx: Tx, businessId: string, bookingId: string, now = new Date()) {
  const bk = (await tx.query<{ id: string; customer_id: string; status: string }>(
    `update bookings set status = 'completed', completed_at = $2 where id = $1 and status in ('confirmed','requested')
     returning id, customer_id, status`, [bookingId, now],
  )).rows[0];
  if (!bk) throw err(409, 'booking not found or not open');
  const prior = (await tx.query<{ n: number }>(
    `select count(*)::int as n from bookings where customer_id = $1 and status = 'completed' and id <> $2`, [bk.customer_id, bk.id],
  )).rows[0].n;
  await tx.query(`update customers set status = 'active', last_visit_at = $2 where id = $1`, [bk.customer_id, now]);
  await emit(tx, businessId, 'job.completed', { type: 'booking', id: bk.id }, { customer_id: bk.customer_id, first_visit: prior === 0 }, now);
  return bk;
}

export async function cancelBooking(tx: Tx, businessId: string, bookingId: string, reasonCode?: string, note?: string) {
  const bk = (await tx.query<{ id: string; customer_id: string }>(
    `update bookings set status = 'cancelled' where id = $1 and status in ('confirmed','requested') returning id, customer_id`, [bookingId],
  )).rows[0];
  if (!bk) throw err(409, 'booking not found or not open');
  if (reasonCode) {
    const business = await loadBusiness(tx);
    if (!business.pack.reasons.cancel.some((r) => r.code === reasonCode)) throw err(400, `unknown cancel reason: ${reasonCode}`);
    await tx.query(`insert into reasons (business_id, customer_id, kind, code, note) values ($1, $2, 'cancel', $3, $4)`, [businessId, bk.customer_id, reasonCode, note ?? null]);
    await emit(tx, businessId, 'reason.recorded', { type: 'customer', id: bk.customer_id }, { kind: 'cancel', code: reasonCode });
  }
  await emit(tx, businessId, 'booking.cancelled', { type: 'booking', id: bk.id }, { customer_id: bk.customer_id, reason: reasonCode ?? null });
  return bk;
}
