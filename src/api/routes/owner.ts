import { z } from 'zod';
import { config } from '../../config.js';
import { assertPublicHttps } from '../../lib/net.js';
import { withTenant } from '../../db/pool.js';
import { HttpError } from '../../lib/http.js';
import { toE164 } from '../../lib/phone.js';
import { loadBusiness, updatePackOverrides } from '../../core/business.js';
import { upsertCustomer } from '../../core/customers.js';
import { cancelBooking, completeBooking, createBooking, quote } from '../../core/bookings.js';
import { approveDraft, queueMessage, rejectDraft } from '../../core/messaging.js';
import { scorecard } from '../../core/scorecard.js';
import { today } from '../../core/today.js';
import { owner, parse, router, zodMessage } from '../context.js';

const uuid = z.string().uuid();
const idParam = (v: string) => { if (!uuid.safeParse(v).success) throw new HttpError(404, 'not found'); return v; };

router.add('GET', '/v1/business', owner(async (req) => {
  const b = await withTenant(req.businessId, loadBusiness);
  const { ai_key_sealed: _sealed, ...settings } = b.settings ?? {};
  return { json: { ...b, settings } };
}));

router.add('PATCH', '/v1/business/pack', owner(async (req) => {
  try {
    return { json: await withTenant(req.businessId, (tx) => updatePackOverrides(tx, req.body)) };
  } catch (e) {
    if (e instanceof z.ZodError) throw new HttpError(400, `invalid pack change: ${zodMessage(e)}`);
    throw e;
  }
}, { ownerOnly: true }));

const Settings = z.object({
  tagline: z.string().max(140).optional(),
  forward_to: z.string().regex(/^\+1\d{10}$/, 'use a US number in E.164 format, e.g. +15125550100').optional(),
  ai_notes: z.string().max(2000).optional(),
  address: z.string().max(200).optional(),
  ai: z.object({
    provider: z.enum(['anthropic', 'openai_compatible', 'none']),
    model: z.string().optional(),
    fast_model: z.string().optional(),
    base_url: z.string().url().refine((u) => u.startsWith('https://'), 'the address must start with https://').optional(),
  }).optional(),
}).strict();

const BusinessFields = z.object({
  name: z.string().min(1).max(120).optional(),
  timezone: z.string().optional(),
  review_url: z.string().url().nullable().optional(),
}).strict();

router.add('PATCH', '/v1/business/settings', owner(async (req) => {
  const s = parse(Settings, req.body);
  if (s.ai?.base_url && s.ai.base_url !== config().AI_BASE_URL) {
    try { await assertPublicHttps(s.ai.base_url); } catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  const r = await withTenant(req.businessId, (tx) => tx.query(`update businesses set settings = settings || $1::jsonb where id = app_business_id() returning settings`, [s]));
  return { json: r.rows[0].settings };
}, { ownerOnly: true }));

router.add('PATCH', '/v1/business', owner(async (req) => {
  const f = parse(BusinessFields, req.body);
  if (f.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: f.timezone }); } catch { throw new HttpError(400, 'unknown timezone'); } }
  await withTenant(req.businessId, (tx) => tx.query(
    `update businesses set name = coalesce($1, name), timezone = coalesce($2, timezone),
       review_url = case when $3::boolean then $4 else review_url end
     where id = app_business_id()`, [f.name ?? null, f.timezone ?? null, 'review_url' in f, f.review_url ?? null]));
  return { json: await withTenant(req.businessId, loadBusiness) };
}, { ownerOnly: true }));

router.add('GET', '/v1/today', owner(async (req) => ({ json: await withTenant(req.businessId, (tx) => today(tx)) })));

router.add('GET', '/v1/services', owner(async (req) => ({
  json: (await withTenant(req.businessId, (tx) => tx.query(`select id, key, name, description, duration_min, price_rule, active, bookable_online, position from services order by position, name`))).rows,
})));

const CustomerIn = z.object({
  first_name: z.string().max(80).optional(), last_name: z.string().max(80).optional(),
  phone: z.string().max(30).optional(), email: z.string().email().optional(),
  sms_consent: z.boolean().optional(),
  consent_source: z.enum(['web_form', 'verbal', 'written', 'import']).optional(),
  source: z.string().max(60).optional(), notes: z.string().max(4000).optional(),
});
router.add('POST', '/v1/customers', owner(async (req) => {
  const c = parse(CustomerIn, req.body);
  if (c.sms_consent && !c.consent_source) throw new HttpError(400, 'consent_source is required when recording SMS consent');
  if (c.phone && !toE164(c.phone)) throw new HttpError(400, 'That phone number doesn’t look right.');
  const r = await withTenant(req.businessId, (tx) => upsertCustomer(tx, req.businessId, { ...c, source: c.source ?? 'owner_added' }));
  return { status: r.created ? 201 : 200, json: r };
}));

router.add('GET', '/v1/customers', owner(async (req) => {
  const status = req.query.get('status');
  const q = req.query.get('q')?.trim();
  const atRisk = req.query.get('risk') === '1';
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `select id, first_name, last_name, phone, email, status, source, sms_consent, sms_opted_out, last_visit_at, created_at, health_score, health_reasons
     from customers
     where ($1::text is null or status = $1)
       and ($2::text is null or (coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(phone,'') || ' ' || coalesce(email,'')) ilike '%' || $2 || '%')
       and (not $3 or (health_score < 50 and status = 'active'))
     order by case when $3 then health_score end asc nulls last, coalesce(last_visit_at, created_at) desc limit 200`, [status, q || null, atRisk]));
  return { json: r.rows };
}));

router.add('GET', '/v1/customers/:id', owner(async (req) => {
  const id = idParam(req.params.id);
  const out = await withTenant(req.businessId, async (tx) => {
    const c = (await tx.query(`select * from customers where id = $1`, [id])).rows[0];
    if (!c) throw new HttpError(404, 'customer not found');
    const bookings = (await tx.query(
      `select b.id, b.starts_at, b.status, b.price_cents, b.recurrence_key, s.name as service
       from bookings b left join services s on s.id = b.service_id where b.customer_id = $1 order by b.starts_at desc limit 50`, [id])).rows;
    const stats = (await tx.query(
      `select count(*) filter (where status = 'completed')::int as visits, coalesce(sum(price_cents) filter (where status = 'completed'), 0)::int as lifetime_cents
       from bookings where customer_id = $1`, [id])).rows[0];
    return { customer: c, bookings, ...stats };
  });
  return { json: out };
}));

const CustomerPatch = z.object({
  first_name: z.string().max(80).nullable().optional(), last_name: z.string().max(80).nullable().optional(),
  email: z.string().email().nullable().optional(), phone: z.string().max(30).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  sms_consent: z.boolean().optional(), consent_source: z.enum(['web_form', 'verbal', 'written', 'import']).optional(),
}).strict();
router.add('PATCH', '/v1/customers/:id', owner(async (req) => {
  const id = idParam(req.params.id);
  const p = parse(CustomerPatch, req.body);
  if (p.sms_consent === true && !p.consent_source) throw new HttpError(400, 'Say how the customer agreed to texts (consent_source).');
  const phone = p.phone === undefined ? undefined : p.phone === null ? null : toE164(p.phone);
  if (p.phone && !phone) throw new HttpError(400, 'That phone number doesn’t look right.');
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `update customers set
       first_name = case when $2 then $3 else first_name end,
       last_name  = case when $4 then $5 else last_name end,
       email      = case when $6 then lower($7) else email end,
       phone      = case when $8 then $9 else phone end,
       notes      = case when $10 then $11 else notes end,
       sms_consent = case when $12::boolean is null then sms_consent when sms_opted_out then false else $12 end,
       sms_consent_at = case when $12 is true and not sms_consent and not sms_opted_out then now() else sms_consent_at end,
       sms_consent_source = case when $12 is true and not sms_consent and not sms_opted_out then $13 else sms_consent_source end
     where id = $1 returning *`,
    [id, 'first_name' in p, p.first_name ?? null, 'last_name' in p, p.last_name ?? null, 'email' in p, p.email ?? null,
      phone !== undefined, phone ?? null, 'notes' in p, p.notes ?? null, p.sms_consent ?? null, p.consent_source ?? null]).catch((e) => {
    if (e.code === '23505') throw new HttpError(409, 'Another customer already has that phone or email.');
    throw e;
  }));
  if (!r.rowCount) throw new HttpError(404, 'customer not found');
  return { json: r.rows[0] };
}));

router.add('GET', '/v1/customers/:id/messages', owner(async (req) => {
  const id = idParam(req.params.id);
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `select id, direction, channel, body, kind, status, block_reason, playbook, created_at from messages where customer_id = $1 order by created_at`, [id]));
  return { json: r.rows };
}));

router.add('POST', '/v1/customers/:id/messages', owner(async (req) => {
  const id = idParam(req.params.id);
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(1600) }), req.body);
  const messageId = await withTenant(req.businessId, (tx) => queueMessage(tx, req.businessId, { customerId: id, body, kind: 'conversational', playbook: null, draftId: null }));
  return { status: 202, json: { message_id: messageId } };
}));

/** One row per customer with their latest message: the unified inbox. */
router.add('GET', '/v1/inbox', owner(async (req) => {
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `select * from (
       select distinct on (m.customer_id) m.customer_id, c.first_name, c.last_name, c.phone, m.direction, m.channel, m.body, m.status, m.created_at,
              (select count(*)::int from drafts d where d.customer_id = m.customer_id and d.status = 'pending') as pending_drafts
       from messages m join customers c on c.id = m.customer_id
       where m.status <> 'queued' or m.direction = 'in'
       order by m.customer_id, m.created_at desc) t
     order by created_at desc limit 200`));
  return { json: r.rows };
}));

const QuoteIn = z.object({ service_key: z.string(), inputs: z.record(z.unknown()).optional(), recurrence_key: z.string().nullable().optional() });
router.add('POST', '/v1/quotes', owner(async (req) => {
  const q = parse(QuoteIn, req.body);
  const r = await withTenant(req.businessId, (tx) => quote(tx, q.service_key, q.inputs, q.recurrence_key));
  return { json: { service: r.service.name, amount_cents: r.amount_cents, lines: r.lines, needs_owner_quote: r.needs_owner_quote } };
}));

router.add('GET', '/v1/bookings', owner(async (req) => {
  const from = new Date(req.query.get('from') ?? Date.now() - 86400000);
  const to = new Date(req.query.get('to') ?? Date.now() + 14 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(400, 'from and to must be dates');
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `select b.id, b.starts_at, b.ends_at, b.status, b.price_cents, b.recurrence_key, s.name as service,
            c.id as customer_id, c.first_name, c.last_name
     from bookings b join customers c on c.id = b.customer_id left join services s on s.id = b.service_id
     where b.starts_at >= $1 and b.starts_at < $2 order by b.starts_at limit 500`, [from, to]));
  return { json: r.rows };
}));

const BookingIn = QuoteIn.extend({
  customer_id: z.string().uuid(), starts_at: z.string(),
  place_id: z.string().uuid().optional(), staff_id: z.string().uuid().optional(),
  price_cents: z.number().int().nonnegative().optional(), notes: z.string().max(4000).optional(),
});
router.add('POST', '/v1/bookings', owner(async (req) => {
  const b = parse(BookingIn, req.body);
  return { status: 201, json: await withTenant(req.businessId, (tx) => createBooking(tx, req.businessId, b)) };
}));
router.add('POST', '/v1/bookings/:id/complete', owner(async (req) => ({
  json: await withTenant(req.businessId, (tx) => completeBooking(tx, req.businessId, idParam(req.params.id))),
})));
router.add('POST', '/v1/bookings/:id/cancel', owner(async (req) => {
  const b = parse(z.object({ reason_code: z.string().optional(), note: z.string().max(2000).optional() }), req.body);
  return { json: await withTenant(req.businessId, (tx) => cancelBooking(tx, req.businessId, idParam(req.params.id), b.reason_code, b.note)) };
}));

router.add('GET', '/v1/drafts', owner(async (req) => {
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `select d.id, d.customer_id, c.first_name, c.last_name, c.phone, d.body, d.playbook, d.reason, d.status, d.action, d.created_at
     from drafts d join customers c on c.id = d.customer_id
     where d.status = coalesce($1, 'pending') and ($2::uuid is null or d.customer_id = $2)
     order by d.created_at`,
    [req.query.get('status'), req.query.get('customer_id')]));
  return { json: r.rows };
}));
router.add('POST', '/v1/drafts/:id/approve', owner(async (req) => {
  const { body } = parse(z.object({ body: z.string().max(1600).optional() }), req.body);
  const id = await withTenant(req.businessId, (tx) => approveDraft(tx, req.businessId, idParam(req.params.id), body));
  return { json: { message_id: id } };
}));
router.add('POST', '/v1/drafts/:id/reject', owner(async (req) => {
  await withTenant(req.businessId, (tx) => rejectDraft(tx, req.businessId, idParam(req.params.id)));
  return { json: { ok: true } };
}));

router.add('GET', '/v1/scorecard', owner(async (req) => {
  const days = Math.min(365, Math.max(7, Number(req.query.get('days') ?? 30)));
  return { json: await withTenant(req.businessId, (tx) => scorecard(tx, new Date(), days)) };
}));

router.add('GET', '/v1/events', owner(async (req) => {
  const limit = Math.min(500, Number(req.query.get('limit') ?? 100));
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `select id, type, subject_type, subject_id, data, occurred_at from events order by id desc limit $1`, [limit]));
  return { json: r.rows };
}));
