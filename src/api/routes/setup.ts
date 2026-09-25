import { z } from 'zod';
import { config } from '../../config.js';
import { withTenant } from '../../db/pool.js';
import { cookie, HttpError, RateLimiter } from '../../lib/http.js';
import { PriceRule } from '../../packs/schema.js';
import { createUser, login, SESSION_DAYS } from '../../core/auth.js';
import { createBusiness, loadBusiness } from '../../core/business.js';
import { draftCampaign } from '../../core/campaigns.js';
import { importCustomers, rowsFromCsv, rowsFromVcard } from '../../core/importer.js';
import { applySetup, proposeSetup, SetupProposal, setupStatus } from '../../core/setup.js';
import { isHttps, owner, parse, router, SESSION_COOKIE, zodMessage } from '../context.js';

const signupLimiter = new RateLimiter(5, 60 * 60_000);

// ---- services ------------------------------------------------------------------------

const ServiceIn = z.object({
  name: z.string().min(1).max(60), description: z.string().max(200).nullable().optional(),
  duration_min: z.number().int().min(5).max(1440), price_rule: PriceRule, bookable_online: z.boolean().optional(), position: z.number().int().optional(),
});
const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'service';

router.add('POST', '/v1/services', owner(async (req) => {
  const s = parse(ServiceIn, req.body);
  const r = await withTenant(req.businessId, async (tx) => {
    let key = keyOf(s.name);
    for (let i = 2; (await tx.query(`select 1 from services where key = $1`, [key])).rowCount; i++) key = `${keyOf(s.name)}_${i}`;
    return tx.query(`insert into services (business_id, key, name, description, duration_min, price_rule, bookable_online, position)
      values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, (select coalesce(max(position), 0) + 1 from services))) returning *`,
      [req.businessId, key, s.name, s.description ?? null, s.duration_min, s.price_rule, s.bookable_online ?? true, s.position ?? null]);
  });
  return { status: 201, json: r.rows[0] };
}, { ownerOnly: true }));

router.add('PATCH', '/v1/services/:key', owner(async (req) => {
  const s = parse(ServiceIn.partial().extend({ active: z.boolean().optional() }), req.body);
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `update services set name = coalesce($2, name), description = case when $3 then $4 else description end, duration_min = coalesce($5, duration_min),
       price_rule = coalesce($6, price_rule), bookable_online = coalesce($7, bookable_online), position = coalesce($8, position), active = coalesce($9, active)
     where key = $1 returning *`,
    [req.params.key, s.name ?? null, 'description' in s, s.description ?? null, s.duration_min ?? null, s.price_rule ?? null, s.bookable_online ?? null, s.position ?? null, s.active ?? null]));
  if (!r.rowCount) throw new HttpError(404, 'service not found');
  return { json: r.rows[0] };
}, { ownerOnly: true }));

// ---- guided setup ---------------------------------------------------------------------

router.add('GET', '/v1/setup', owner(async (req) => ({ json: await withTenant(req.businessId, setupStatus) })));

router.add('POST', '/v1/setup/suggest', owner(async (req) => {
  const { description } = parse(z.object({ description: z.string().min(10, 'Tell us a little more about what you do.').max(2000) }), req.body);
  return { json: await withTenant(req.businessId, async (tx) => proposeSetup(await loadBusiness(tx), description)) };
}, { ownerOnly: true }));

router.add('POST', '/v1/setup/apply', owner(async (req) => {
  const r = SetupProposal.safeParse(req.body);
  if (!r.success) throw new HttpError(400, zodMessage(r.error));
  await withTenant(req.businessId, (tx) => applySetup(tx, r.data));
  return { json: await withTenant(req.businessId, setupStatus) };
}, { ownerOnly: true }));

router.add('POST', '/v1/setup/dismiss', owner(async (req) => {
  await withTenant(req.businessId, (tx) => tx.query(`update businesses set settings = settings || jsonb_build_object('onboarding', coalesce(settings->'onboarding', '{}'::jsonb) || '{"dismissed": true}'::jsonb) where id = app_business_id()`));
  return { json: { ok: true } };
}));

/** Import customers from a spreadsheet (CSV) or phone contacts (vCard), sent as the request body. */
router.add('POST', '/v1/import/customers', owner(async (req) => {
  const consent = z.enum(['verbal', 'written', 'none']).catch('none').parse(req.query.get('consent'));
  const type = String(req.headers['content-type'] ?? '');
  const text = req.rawBody;
  if (!text.trim()) throw new HttpError(400, 'The file is empty.');
  const rows = /vcard|vcf/i.test(type) || /^BEGIN:VCARD/im.test(text) ? rowsFromVcard(text) : rowsFromCsv(text);
  if (!rows.length) throw new HttpError(400, 'No customers found. Check the file has a header row with names, phones or emails.');
  if (rows.length > 5000) throw new HttpError(413, 'Import up to 5,000 customers at a time.');
  return { json: await withTenant(req.businessId, (tx) => importCustomers(tx, req.businessId, rows, consent)) };
}));

router.add('POST', '/v1/campaigns', owner(async (req) => {
  const { kind } = parse(z.object({ kind: z.enum(['review_ask', 'win_back']) }), req.body);
  return { json: await withTenant(req.businessId, async (tx) => draftCampaign(tx, await loadBusiness(tx), kind)) };
}));

// ---- self-serve sign-up (off unless ALLOW_SIGNUP=true) ----------------------------------------------

router.add('POST', '/signup', async (req) => {
  if (config().ALLOW_SIGNUP !== 'true') throw new HttpError(404, 'not found');
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'send JSON');
  if (!signupLimiter.allow(req.ip)) throw new HttpError(429, 'Too many sign-ups from here. Try again later.');
  const b = parse(z.object({
    business_name: z.string().min(1).max(120), email: z.string().email(), password: z.string(),
    phone: z.string().regex(/^\+1\d{10}$/, 'use a US number in E.164 format, e.g. +15125550100').optional(), timezone: z.string().optional(),
  }), req.body);
  const { business } = await createBusiness({ name: b.business_name, timezone: b.timezone });
  await withTenant(business.id, (tx) => createUser(tx, business.id, { email: b.email, password: b.password, phone: b.phone ?? null, role: 'owner' }));
  const s = await login(b.email, b.password, String(req.headers['user-agent'] ?? ''));
  return {
    status: 201, json: { business_id: business.id },
    headers: s ? { 'set-cookie': cookie(SESSION_COOKIE, s.token, { maxAgeSec: SESSION_DAYS * 86400, secure: isHttps() }) } : undefined,
  };
});
