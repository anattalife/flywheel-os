import { z } from 'zod';
import { looksLikeLink, toE164 } from '../../lib/phone.js';
import { withSystem, withTenant } from '../../db/pool.js';
import { HttpError } from '../../lib/http.js';
import { receiveLead } from '../../core/inbound.js';
import { loadBusiness } from '../../core/business.js';
import { recordReferral } from '../../core/referrals.js';
import { listPacks } from '../../packs/registry.js';
import { formLimiter, parse, router } from '../context.js';

router.add('GET', '/health', async () => {
  await withSystem((tx) => tx.query('select 1'));
  return { json: { ok: true } };
});

router.add('GET', '/v1/packs', async () => ({ json: listPacks() }));

/** Caddy's on-demand TLS asks here before issuing a certificate for a customer's domain. */
router.add('GET', '/internal/domain-check', async (req) => {
  const domain = req.query.get('domain') ?? '';
  const id = await withSystem(async (tx) => (await tx.query<{ id: string | null }>(`select find_business_by_domain($1) as id`, [domain])).rows[0].id);
  return id ? { json: { ok: true } } : { status: 404, json: { ok: false } };
});

export const LeadForm = z.object({
  first_name: z.string().max(40).refine((v) => !looksLikeLink(v), 'Names can\u2019t contain links.').optional(),
  last_name: z.string().max(40).refine((v) => !looksLikeLink(v), 'Names can\u2019t contain links.').optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(200).optional().or(z.literal('')),
  message: z.string().max(2000).optional(),
  sms_consent: z.union([z.boolean(), z.enum(['on', 'true', 'false', 'yes'])]).optional(),
  source: z.string().max(60).optional(),
  utm_source: z.string().max(100).optional(),
  utm_medium: z.string().max(100).optional(),
  utm_campaign: z.string().max(100).optional(),
  referral_code: z.string().max(40).optional(),
  website: z.string().optional(), // honeypot: humans never fill this in
});

export async function submitLead(businessId: string, ip: string, body: unknown) {
  if (!formLimiter.allow(ip)) throw new HttpError(429, 'Too many requests. Try again in a minute.');
  const f = parse(LeadForm, body);
  if (f.website) return { spam: true as const };
  if (!f.phone && !f.email) throw new HttpError(400, 'Enter a phone number or email.');
  if (f.phone && !toE164(f.phone)) throw new HttpError(400, 'Enter a US mobile number with the area code.');
  if (!z.string().uuid().safeParse(businessId).success) throw new HttpError(404, 'unknown business');
  const consent = f.sms_consent === true || ['on', 'true', 'yes'].includes(String(f.sms_consent));
  const source = f.referral_code ? 'referral' : f.source ?? (f.utm_source ? `utm:${f.utm_source}` : 'website');
  const result = await withTenant(businessId, async (tx) => {
    const exists = await tx.query(`select 1 from businesses where id = app_business_id()`);
    if (!exists.rowCount) throw new HttpError(404, 'unknown business');
    const lead = await receiveLead(tx, businessId, {
      first_name: f.first_name, last_name: f.last_name, phone: f.phone, email: f.email || null,
      sms_consent: consent, source,
      source_detail: { utm_source: f.utm_source, utm_medium: f.utm_medium, utm_campaign: f.utm_campaign, referral_code: f.referral_code },
      message: f.message,
    });
    if (f.referral_code) await recordReferral(tx, await loadBusiness(tx), f.referral_code, lead.customerId);
    return lead;
  });
  return { spam: false as const, customerId: result.customerId };
}

router.add('POST', '/public/:businessId/leads', async (req) => {
  const r = await submitLead(req.params.businessId, req.ip, req.body);
  if (r.spam) return { status: 202, json: { ok: true } };
  return { status: 201, json: { ok: true, customer_id: r.customerId } };
});
