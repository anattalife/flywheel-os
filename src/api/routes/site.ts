import { z } from 'zod';
import { config } from '../../config.js';
import { withTenant, type Tx } from '../../db/pool.js';
import { HttpError, RateLimiter, type Req, type Res } from '../../lib/http.js';
import { looksLikeLink, toE164 } from '../../lib/phone.js';
import { loadBusiness, links } from '../../core/business.js';
import { upsertCustomer } from '../../core/customers.js';
import { createBooking, quote } from '../../core/bookings.js';
import { availableSlots, loadHours } from '../../core/scheduling.js';
import { addLocalDays, localParts } from '../../lib/tz.js';
import { SITE_CSP } from '../../site/html.js';
import {
  areaPage, bookDetailsPage, bookDonePage, bookServicePage, bookTimePage, homePage, legalPage, notFoundPage,
  requestQuotePage, slug, thanksPage, type BookingState, type SiteContext, type SiteService,
} from '../../site/pages.js';
import { accentOf, inkOn, siteSettings } from '../../site/settings.js';
import { legalText } from '../../site/legal.js';
import { router } from '../context.js';
import { webFile } from './static.js';
import { submitLead } from './public.js';
import { recordReferral, referrerByCode } from '../../core/referrals.js';

const bookLimiter = new RateLimiter(8, 10 * 60_000);
const htmlRes = (text: string, status = 200): Res => ({ status, text, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': SITE_CSP } });
const redirect = (location: string): Res => ({ status: 303, text: '', headers: { location } });

function businessIdOf(req: Req) {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'not found');
  return id;
}
/** '' when served on the business's own domain, '/site/<id>' on the platform domain. */
export const baseOf = (req: Req, id: string) => (req.headers['x-fw-site-host'] ? '' : `/site/${id}`);

export async function siteContext(tx: Tx, base: string): Promise<SiteContext> {
  const business = await loadBusiness(tx);
  const services = (await tx.query<SiteService>(
    `select key, name, description, duration_min, price_rule from services where active and bookable_online order by position, name`)).rows;
  const hours = await loadHours(tx);
  const rating = (await tx.query<{ avg: string | null; count: number }>(
    `select avg(rating)::numeric(3,2)::text as avg, count(*)::int as count from reviews where not is_private_feedback and rating is not null`)).rows[0];
  const reviews = (await tx.query(
    `select r.rating, r.body, c.first_name, r.created_at from reviews r left join customers c on c.id = r.customer_id
     where not r.is_private_feedback and r.rating >= 4 and coalesce(r.body, '') <> '' order by r.created_at desc limit 6`)).rows;
  return {
    business, site: siteSettings(business), base, services, hours, reviews,
    canonicalOrigin: links(business).origin,
    rating: { avg: rating.avg ? Number(rating.avg) : null, count: rating.count },
  };
}

async function withSite<T>(req: Req, fn: (ctx: SiteContext, tx: Tx, id: string) => Promise<T>): Promise<T> {
  const id = businessIdOf(req);
  return withTenant(id, async (tx) => {
    const exists = await tx.query(`select 1 from businesses where id = app_business_id()`);
    if (!exists.rowCount) throw new HttpError(404, 'not found');
    const ctx = await siteContext(tx, baseOf(req, id));
    if (!ctx.site.published) throw new HttpError(404, 'not found');
    return fn(ctx, tx, id);
  });
}

function readState(src: Record<string, unknown> | URLSearchParams): BookingState {
  const get = (k: string) => (src instanceof URLSearchParams ? src.get(k) : (src[k] as string | undefined)) ?? undefined;
  const keys = src instanceof URLSearchParams ? [...src.keys()] : Object.keys(src);
  const inputs: Record<string, string> = {};
  for (const k of keys) if (k.startsWith('in_') && /^in_[\w-]{1,40}$/.test(k)) inputs[k.slice(3)] = String(get(k) ?? '').slice(0, 60);
  const week = Number(get('week') ?? 0);
  const ref = String(get('ref') ?? '').toUpperCase();
  return { service: get('service') || undefined, repeat: get('repeat') || undefined, inputs, at: get('at') || undefined, week: Number.isFinite(week) ? Math.max(0, Math.min(12, week)) : 0, ref: /^[A-Z0-9]{3,20}$/.test(ref) ? ref : undefined };
}

/** Typed pricing inputs for a service from the raw strings in the form. */
function typedInputs(svc: SiteService, raw: Record<string, string>) {
  const out: Record<string, unknown> = {};
  const rule = svc.price_rule;
  if (rule.type === 'hourly' && raw.minutes) out.minutes = Number(raw.minutes);
  if (rule.type === 'formula') {
    for (const inp of rule.inputs) {
      if (raw[inp.key] === undefined) continue;
      out[inp.key] = inp.kind === 'number' ? Number(raw[inp.key]) : raw[inp.key];
    }
  }
  return out;
}

const chosenService = (ctx: SiteContext, key?: string) => ctx.services.find((s) => s.key === key);

// ---- pages ------------------------------------------------------------------------

router.add('GET', '/site/:id', async (req) => withSite(req, async (ctx, tx) => {
  // Show the soonest open time for the first bookable service: a one-tap way in.
  const svc = ctx.services.find((s) => s.price_rule.type !== 'quote');
  if (svc) {
    const days = await availableSlots(tx, ctx.business, { durationMin: svc.duration_min, days: 14 });
    const at = days.flatMap((d) => d.slots)[0];
    ctx.nextOpening = at ? { at, service: svc } : null;
  }
  return htmlRes(homePage(ctx, req.query.get('sent') ? 'Thanks! We got your message.' : undefined));
}));

router.add('GET', '/site/:id/theme.css', async (req) => withSite(req, async (ctx) => {
  const accent = accentOf(ctx.site);
  const themeCss = (await webFile(`site/theme-${ctx.site.theme}.css`)).toString('utf8');
  return {
    text: `${themeCss}\n:root{--accent:${accent};--accent-ink:${inkOn(accent)};}\n`,
    contentType: 'text/css; charset=utf-8',
    headers: { 'cache-control': 'public, max-age=300' },
  };
}));

router.add('GET', '/site/:id/book', async (req) => withSite(req, async (ctx) => {
  const s = readState(req.query);
  const svc = chosenService(ctx, s.service);
  if (svc?.price_rule.type === 'quote') return htmlRes(requestQuotePage(ctx, svc));
  return htmlRes(bookServicePage(ctx, s));
}));

router.add('POST', '/site/:id/quote', async (req) => withSite(req, async (ctx, tx) => {
  const s = readState(req.body ?? {});
  const svc = chosenService(ctx, s.service);
  if (!svc) throw new HttpError(404, 'unknown service');
  if (svc.price_rule.type === 'quote') return { json: { amount_cents: null, needs_owner_quote: true, lines: [] } };
  const q = await quote(tx, svc.key, typedInputs(svc, s.inputs), s.repeat ?? null);
  return { json: { amount_cents: q.amount_cents, lines: q.lines, needs_owner_quote: q.needs_owner_quote } };
}));

router.add('GET', '/site/:id/book/time', async (req) => withSite(req, async (ctx, tx) => {
  const s = readState(req.query);
  const svc = chosenService(ctx, s.service);
  if (!svc) return htmlRes(bookServicePage(ctx, s, 'Choose a service first.'), 400);
  if (svc.price_rule.type === 'quote') return redirect(`${ctx.base}/book?service=${encodeURIComponent(svc.key)}`);
  let q;
  try { q = await quote(tx, svc.key, typedInputs(svc, s.inputs), s.repeat ?? null); }
  catch (e) { return htmlRes(bookServicePage(ctx, s, (e as Error).message), 400); }
  const minutes = svc.price_rule.type === 'hourly' ? Number(s.inputs.minutes ?? svc.duration_min) : svc.duration_min;
  const today = localParts(new Date(), ctx.business.timezone).date;
  const days = await availableSlots(tx, ctx.business, { durationMin: minutes, fromDate: addLocalDays(today, (s.week ?? 0) * 7), days: 7 });
  return htmlRes(bookTimePage(ctx, s, q, svc, days, req.query.get('taken') ? 'Sorry, that time was just taken. Pick another.' : undefined));
}));

router.add('GET', '/site/:id/book/details', async (req) => withSite(req, async (ctx, tx) => {
  const s = readState(req.query);
  const svc = chosenService(ctx, s.service);
  if (!svc || !s.at || Number.isNaN(new Date(s.at).getTime())) return redirect(`${ctx.base}/book`);
  const q = await quote(tx, svc.key, typedInputs(svc, s.inputs), s.repeat ?? null);
  return htmlRes(bookDetailsPage(ctx, s, svc, q));
}));

const Details = z.object({
  first_name: z.string().trim().min(1, 'Enter your first name.').max(40).refine((v) => !looksLikeLink(v), 'Names can\u2019t contain links.'),
  last_name: z.string().trim().max(40).refine((v) => !looksLikeLink(v), 'Names can\u2019t contain links.').optional(),
  phone: z.string().trim().min(7, 'Enter your mobile number.').max(30),
  email: z.string().trim().email('That email doesn’t look right.').max(200).optional().or(z.literal('')),
  address: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(2000).optional(),
  sms_consent: z.string().optional(),
  website: z.string().optional(),
});

router.add('POST', '/site/:id/book', async (req) => withSite(req, async (ctx, tx, id) => {
  const s = readState(req.body);
  const svc = chosenService(ctx, s.service);
  if (!svc || svc.price_rule.type === 'quote' || !s.at) return redirect(`${ctx.base}/book`);
  const values = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v).slice(0, 2000)]));
  if (values.website) return redirect(`${ctx.base}/thanks`);
  const q = await quote(tx, svc.key, typedInputs(svc, s.inputs), s.repeat ?? null);
  const retry = (msg: string, status = 400) => htmlRes(bookDetailsPage(ctx, s, svc, q, msg, values), status);
  if (!bookLimiter.allow(req.ip)) return retry('Too many attempts. Wait a few minutes and try again.', 429);
  const parsed = Details.safeParse(req.body);
  if (!parsed.success) return retry(parsed.error.issues[0].message);
  const d = parsed.data;
  const phone = toE164(d.phone);
  if (!phone) return retry('That mobile number doesn’t look right. Include the area code.');
  const { customer } = await upsertCustomer(tx, id, {
    first_name: d.first_name, last_name: d.last_name || null, phone, email: d.email || null,
    sms_consent: d.sms_consent === 'on', consent_source: 'web_form', source: 'website',
  }, { untrusted: true });
  let placeId: string | null = null;
  const placeDetails = Object.fromEntries(ctx.business.pack.place_fields.map((f) => [f.key, values[`pf_${f.key}`] ?? null]));
  if (d.address || Object.values(placeDetails).some(Boolean)) {
    placeId = (await tx.query<{ id: string }>(
      `insert into places (business_id, customer_id, label, address, details) values ($1, $2, 'Home', $3, $4) returning id`,
      [id, customer.id, d.address || null, placeDetails])).rows[0].id;
  }
  await tx.query(`insert into messages (business_id, customer_id, direction, channel, body, status) values ($1, $2, 'in', 'web', $3, 'received')`,
    [id, customer.id, `Booked online: ${svc.name}${d.notes ? `. Note: ${d.notes}` : ''}`]);
  if (s.ref) await recordReferral(tx, ctx.business, s.ref, customer.id);
  try {
    await tx.query('savepoint book');
    const booking = await createBooking(tx, id, {
      customer_id: customer.id, service_key: svc.key, starts_at: s.at, inputs: typedInputs(svc, s.inputs),
      recurrence_key: s.repeat ?? null, place_id: placeId, notes: d.notes || null, source: 'online',
    });
    return redirect(`${ctx.base}/book/done?b=${booking.id}`);
  } catch (e) {
    if ((e as { status?: number }).status === 409) {
      await tx.query('rollback to savepoint book');
      return redirect(`${ctx.base}/book/time?${new URLSearchParams({ ...(s.service ? { service: s.service } : {}), ...(s.repeat ? { repeat: s.repeat } : {}), ...Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [`in_${k}`, v])), taken: '1' })}`);
    }
    throw e;
  }
}));

router.add('GET', '/site/:id/book/done', async (req) => withSite(req, async (ctx, tx) => {
  const bid = req.query.get('b') ?? '';
  if (!z.string().uuid().safeParse(bid).success) return redirect(ctx.base || '/');
  const b = (await tx.query<{ starts_at: Date; service: string; first_name: string }>(
    `select b.starts_at, s.name as service, c.first_name from bookings b join services s on s.id = b.service_id join customers c on c.id = b.customer_id
     where b.id = $1 and b.created_at > now() - interval '1 hour'`, [bid])).rows[0];
  if (!b) return redirect(ctx.base || '/');
  return htmlRes(bookDonePage(ctx, new Date(b.starts_at), b.service, b.first_name));
}));

router.add('POST', '/site/:id/contact', async (req) => {
  const id = businessIdOf(req);
  const base = baseOf(req, id);
  const body = { ...req.body, source: req.body?.service ? 'website_quote' : 'website' };
  try {
    await submitLead(id, req.ip, body);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) {
      return withSite(req, async (ctx) => htmlRes(homePage(ctx, `${e.message}`), e.status));
    }
    throw e;
  }
  return redirect(`${base}/thanks`);
});

/** A customer's share link: straight to booking, with the friend credit shown. */
router.add('GET', '/site/:id/r/:code', async (req) => withSite(req, async (ctx, tx) => {
  const ref = await referrerByCode(tx, req.params.code);
  return redirect(ref ? `${ctx.base}/book?ref=${encodeURIComponent(req.params.code.toUpperCase())}` : `${ctx.base}/book`);
}));

router.add('GET', '/site/:id/thanks', async (req) => withSite(req, async (ctx) => htmlRes(thanksPage(ctx))));

router.add('GET', '/site/:id/areas/:area', async (req) => withSite(req, async (ctx) => {
  const area = ctx.site.areas.find((a) => slug(a) === req.params.area);
  return area ? htmlRes(areaPage(ctx, area)) : htmlRes(notFoundPage(ctx), 404);
}));

router.add('GET', '/site/:id/privacy', async (req) => withSite(req, async (ctx) => htmlRes(legalPage(ctx, 'privacy', legalText('privacy', ctx.business)))));
router.add('GET', '/site/:id/terms', async (req) => withSite(req, async (ctx) => htmlRes(legalPage(ctx, 'terms', legalText('terms', ctx.business)))));

router.add('GET', '/site/:id/robots.txt', async (req) => withSite(req, async (ctx) => ({
  text: `User-agent: *\nAllow: /\nDisallow: ${ctx.base}/book/\nDisallow: /m/\nSitemap: ${ctx.canonicalOrigin}${ctx.base}/sitemap.xml\n`,
})));

router.add('GET', '/site/:id/sitemap.xml', async (req) => withSite(req, async (ctx) => {
  const root = `${ctx.canonicalOrigin}${ctx.base}`;
  const urls = [root || '/', `${root}/book`, ...ctx.site.areas.map((a) => `${root}/areas/${slug(a)}`)];
  return {
    text: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u.replace(/&/g, '&amp;')}</loc></url>`).join('')}</urlset>`,
    contentType: 'application/xml',
  };
}));

export const siteOrigin = () => new URL(config().PUBLIC_BASE_URL).host;
