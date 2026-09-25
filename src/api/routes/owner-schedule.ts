import { z } from 'zod';
import { withTenant } from '../../db/pool.js';
import { HttpError } from '../../lib/http.js';
import { loadBusiness } from '../../core/business.js';
import { emit } from '../../core/events.js';
import { availableSlots, endSeries, loadHours, pauseSeries, rescheduleBooking, resumeSeries, setHours, skipBooking } from '../../core/scheduling.js';
import { localParts } from '../../lib/tz.js';
import { SiteSettings } from '../../site/settings.js';
import { owner, parse, router } from '../context.js';

const uuid = z.string().uuid();
const idParam = (v: string) => { if (!uuid.safeParse(v).success) throw new HttpError(404, 'not found'); return v; };
const Hhmm = z.string().regex(/^\d\d:\d\d$/, 'use HH:MM');

router.add('GET', '/v1/hours', owner(async (req) => ({ json: await withTenant(req.businessId, loadHours) })));
router.add('PUT', '/v1/hours', owner(async (req) => {
  const hours = parse(z.array(z.object({ weekday: z.number().int().min(0).max(6), opens: Hhmm, closes: Hhmm })).max(28), req.body);
  await withTenant(req.businessId, (tx) => setHours(tx, req.businessId, hours));
  return { json: await withTenant(req.businessId, loadHours) };
}, { ownerOnly: true }));

router.add('GET', '/v1/time-off', owner(async (req) => ({
  json: (await withTenant(req.businessId, (tx) => tx.query(`select id, starts_at, ends_at, reason from time_off where ends_at > now() order by starts_at`))).rows,
})));
router.add('POST', '/v1/time-off', owner(async (req) => {
  const t = parse(z.object({ starts_at: z.string(), ends_at: z.string(), reason: z.string().max(200).optional() }), req.body);
  const s = new Date(t.starts_at), e = new Date(t.ends_at);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) throw new HttpError(400, 'Time off needs a start before its end.');
  const r = await withTenant(req.businessId, (tx) => tx.query(`insert into time_off (business_id, starts_at, ends_at, reason) values ($1, $2, $3, $4) returning id, starts_at, ends_at, reason`, [req.businessId, s, e, t.reason ?? null]));
  return { status: 201, json: r.rows[0] };
}));
router.add('DELETE', '/v1/time-off/:id', owner(async (req) => {
  await withTenant(req.businessId, (tx) => tx.query(`delete from time_off where id = $1`, [idParam(req.params.id)]));
  return { json: { ok: true } };
}));

router.add('GET', '/v1/availability', owner(async (req) => {
  const service = req.query.get('service') ?? '';
  const days = Math.min(31, Math.max(1, Number(req.query.get('days') ?? 7)));
  return {
    json: await withTenant(req.businessId, async (tx) => {
      const b = await loadBusiness(tx);
      const svc = (await tx.query<{ duration_min: number }>(`select duration_min from services where key = $1`, [service])).rows[0];
      if (!svc) throw new HttpError(404, 'unknown service');
      return availableSlots(tx, b, { durationMin: svc.duration_min, fromDate: req.query.get('date') ?? localParts(new Date(), b.timezone).date, days, now: new Date(), excludeBookingId: req.query.get('exclude') });
    }),
  };
}));

router.add('POST', '/v1/bookings/:id/reschedule', owner(async (req) => {
  const b = parse(z.object({ starts_at: z.string(), force: z.boolean().optional() }), req.body);
  const id = idParam(req.params.id);
  await withTenant(req.businessId, async (tx) => {
    const business = await loadBusiness(tx);
    if (b.force) {
      const cur = (await tx.query<{ starts_at: Date; ends_at: Date; customer_id: string }>(`select starts_at, ends_at, customer_id from bookings where id = $1 and status in ('confirmed','requested')`, [id])).rows[0];
      if (!cur) throw new HttpError(409, 'Only upcoming bookings can be moved.');
      const start = new Date(b.starts_at);
      const end = new Date(start.getTime() + (new Date(cur.ends_at).getTime() - new Date(cur.starts_at).getTime()));
      await tx.query(`update bookings set starts_at = $2, ends_at = $3, status = 'confirmed' where id = $1`, [id, start, end]);
      await emit(tx, business.id, 'booking.rescheduled', { type: 'booking', id }, { customer_id: cur.customer_id, from: new Date(cur.starts_at).toISOString(), to: start.toISOString(), by: 'owner' });
    } else {
      await rescheduleBooking(tx, business, id, new Date(b.starts_at), { enforceHours: false, by: 'owner' });
    }
  });
  return { json: { ok: true } };
}));

router.add('POST', '/v1/bookings/:id/skip', owner(async (req) => {
  await withTenant(req.businessId, async (tx) => skipBooking(tx, await loadBusiness(tx), idParam(req.params.id)));
  return { json: { ok: true } };
}));

router.add('GET', '/v1/series', owner(async (req) => {
  const customer = req.query.get('customer_id');
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `select sr.id, sr.customer_id, sr.recurrence_key, sr.status, sr.paused_until, sr.anchor_at, sr.price_cents, s.name as service,
            (select min(starts_at) from bookings b where b.series_id = sr.id and b.status = 'confirmed' and b.starts_at > now()) as next_at
     from series sr left join services s on s.id = sr.service_id
     where ($1::uuid is null or sr.customer_id = $1) order by sr.created_at desc`, [customer]));
  return { json: r.rows };
}));
router.add('POST', '/v1/series/:id/pause', owner(async (req) => {
  const b = parse(z.object({ until: z.string() }), req.body);
  const until = new Date(b.until);
  if (Number.isNaN(until.getTime()) || until <= new Date()) throw new HttpError(400, 'Pick a date in the future.');
  await withTenant(req.businessId, async (tx) => pauseSeries(tx, await loadBusiness(tx), idParam(req.params.id), until));
  return { json: { ok: true } };
}));
router.add('POST', '/v1/series/:id/resume', owner(async (req) => {
  await withTenant(req.businessId, async (tx) => resumeSeries(tx, await loadBusiness(tx), idParam(req.params.id)));
  return { json: { ok: true } };
}));
router.add('POST', '/v1/series/:id/end', owner(async (req) => {
  const b = parse(z.object({ reason_code: z.string().optional() }), req.body);
  await withTenant(req.businessId, async (tx) => endSeries(tx, await loadBusiness(tx), idParam(req.params.id), b.reason_code));
  return { json: { ok: true } };
}));

router.add('PATCH', '/v1/business/site', owner(async (req) => {
  const out = await withTenant(req.businessId, async (tx) => {
    const cur = (await tx.query<{ site: unknown }>(`select settings->'site' as site from businesses where id = app_business_id()`)).rows[0]?.site ?? {};
    const merged = SiteSettings.safeParse({ ...(cur as object), ...(req.body as object) });
    if (!merged.success) throw new HttpError(400, merged.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    await tx.query(`update businesses set settings = jsonb_set(settings, '{site}', $1::jsonb) where id = app_business_id()`, [merged.data]);
    return merged.data;
  });
  return { json: out };
}, { ownerOnly: true }));

const SchedulingSettings = z.object({
  capacity: z.number().int().min(1).max(50).optional(),
  buffer_min: z.number().int().min(0).max(240).optional(),
  min_notice_hours: z.number().min(0).max(168).optional(),
  max_days_ahead: z.number().int().min(1).max(365).optional(),
  slot_step_min: z.number().int().min(5).max(240).optional(),
  cancel_notice_hours: z.number().min(0).max(168).optional(),
}).strict();
router.add('PATCH', '/v1/business/scheduling', owner(async (req) => {
  const s = parse(SchedulingSettings, req.body);
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `update businesses set settings = jsonb_set(settings, '{scheduling}', coalesce(settings->'scheduling', '{}'::jsonb) || $1::jsonb) where id = app_business_id() returning settings->'scheduling' as scheduling`, [s]));
  return { json: r.rows[0].scheduling };
}, { ownerOnly: true }));
