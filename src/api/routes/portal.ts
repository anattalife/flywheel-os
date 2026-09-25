import { z } from 'zod';
import { withTenant, type Tx } from '../../db/pool.js';
import { HttpError, type Req, type Res } from '../../lib/http.js';
import { resolvePortalToken } from '../../core/portal.js';
import { cancelBooking } from '../../core/bookings.js';
import { availableSlots, pauseSeries, rescheduleBooking, resumeSeries, schedulingRules, skipBooking } from '../../core/scheduling.js';
import { addLocalDays, localParts } from '../../lib/tz.js';
import { SITE_CSP } from '../../site/html.js';
import { portalGone, portalHome, portalMove, type PortalBooking } from '../../site/portal.js';
import { router } from '../context.js';
import { baseOf, siteContext } from './site.js';

const htmlRes = (text: string, status = 200): Res => ({ status, text, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': SITE_CSP, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
const back = (token: string, msg: string): Res => ({ status: 303, text: '', headers: { location: `/m/${token}?msg=${encodeURIComponent(msg)}` } });
const uuid = z.string().uuid();

/** Extra portal sections added by later features (payments, referrals). */
export const portalExtras: ((tx: Tx, customerId: string, token: string) => Promise<string>)[] = [];

async function withPortal(req: Req, fn: (tx: Tx, who: { businessId: string; customerId: string; base: string }, token: string) => Promise<Res>): Promise<Res> {
  const token = req.params.token;
  const who = await resolvePortalToken(token);
  if (!who) return htmlRes(portalGone(), 410);
  return withTenant(who.businessId, (tx) => fn(tx, { ...who, base: baseOf(req, who.businessId) }, token));
}

async function ownBooking(tx: Tx, customerId: string, bookingId: string): Promise<PortalBooking> {
  if (!uuid.safeParse(bookingId).success) throw new HttpError(404, 'not found');
  const b = (await tx.query<PortalBooking & { customer_id: string }>(
    `select b.id, b.starts_at, b.status, s.name as service, b.price_cents, b.series_id, b.customer_id
     from bookings b left join services s on s.id = b.service_id where b.id = $1`, [bookingId])).rows[0];
  if (!b || b.customer_id !== customerId) throw new HttpError(404, 'not found');
  return b;
}

function assertChangeable(b: PortalBooking, noticeHours: number) {
  if (!['confirmed', 'requested'].includes(b.status)) throw new HttpError(409, 'That booking can’t be changed anymore.');
  if (new Date(b.starts_at).getTime() - Date.now() < noticeHours * 3_600_000) throw new HttpError(409, `Changes need ${noticeHours} hours’ notice. Please text us.`);
}

router.add('GET', '/m/:token', async (req) => withPortal(req, async (tx, who, token) => {
  const ctx = await siteContext(tx, who.base);
  const rules = schedulingRules(ctx.business);
  const customer = (await tx.query<{ first_name: string | null }>(`select first_name from customers where id = $1`, [who.customerId])).rows[0];
  const bookings = (await tx.query<PortalBooking>(
    `select b.id, b.starts_at, b.status, s.name as service, b.price_cents, b.series_id
     from bookings b left join services s on s.id = b.service_id
     where b.customer_id = $1 and b.status in ('confirmed','requested') and b.starts_at > now() order by b.starts_at limit 10`, [who.customerId])).rows;
  const series = (await tx.query(
    `select sr.id, sr.recurrence_key, sr.status, sr.paused_until, s.name as service from series sr left join services s on s.id = sr.service_id
     where sr.customer_id = $1 order by sr.created_at`, [who.customerId])).rows.map((r: any) => ({
    ...r, recurrence_label: ctx.business.pack.recurrence.options.find((o) => o.key === r.recurrence_key)?.label ?? r.recurrence_key,
  }));
  const extras = (await Promise.all(portalExtras.map((f) => f(tx, who.customerId, token)))).join('');
  return htmlRes(portalHome(ctx, token, {
    first_name: customer?.first_name ?? null, bookings, series, extras,
    cancelNoticeHours: (ctx.business.settings?.scheduling?.cancel_notice_hours as number | undefined) ?? Math.max(rules.min_notice_hours, 24),
    reasons: ctx.business.pack.reasons.cancel,
  }, req.query.get('msg') ?? undefined));
}));

const noticeOf = (settings: any, min: number) => (settings?.scheduling?.cancel_notice_hours as number | undefined) ?? Math.max(min, 24);

router.add('GET', '/m/:token/b/:bid/move', async (req) => withPortal(req, async (tx, who, token) => {
  const ctx = await siteContext(tx, who.base);
  const b = await ownBooking(tx, who.customerId, req.params.bid);
  const rules = schedulingRules(ctx.business);
  try { assertChangeable(b, noticeOf(ctx.business.settings, rules.min_notice_hours)); } catch (e) { return back(token, (e as Error).message); }
  const duration = (await tx.query<{ m: number }>(`select extract(epoch from ends_at - starts_at)::int / 60 as m from bookings where id = $1`, [b.id])).rows[0].m;
  const days = await availableSlots(tx, ctx.business, { durationMin: duration, fromDate: localParts(new Date(), ctx.business.timezone).date, days: 14, excludeBookingId: b.id });
  return htmlRes(portalMove(ctx, token, b, days, req.query.get('taken') ? 'That time was just taken. Pick another.' : undefined));
}));

router.add('POST', '/m/:token/b/:bid/move', async (req) => withPortal(req, async (tx, who, token) => {
  const ctx = await siteContext(tx, who.base);
  const b = await ownBooking(tx, who.customerId, req.params.bid);
  const rules = schedulingRules(ctx.business);
  try { assertChangeable(b, noticeOf(ctx.business.settings, rules.min_notice_hours)); } catch (e) { return back(token, (e as Error).message); }
  const at = new Date(String(req.body?.at ?? ''));
  try {
    await tx.query('savepoint mv');
    await rescheduleBooking(tx, ctx.business, b.id, at, { enforceHours: true, by: 'customer' });
  } catch (e) {
    await tx.query('rollback to savepoint mv');
    if ((e as { status?: number }).status === 409 || (e as { status?: number }).status === 400) return { status: 303, text: '', headers: { location: `/m/${token}/b/${b.id}/move?taken=1` } };
    throw e;
  }
  return back(token, 'Moved. We’ve texted you the new time.');
}));

router.add('POST', '/m/:token/b/:bid/cancel', async (req) => withPortal(req, async (tx, who, token) => {
  const ctx = await siteContext(tx, who.base);
  const b = await ownBooking(tx, who.customerId, req.params.bid);
  try { assertChangeable(b, noticeOf(ctx.business.settings, schedulingRules(ctx.business).min_notice_hours)); } catch (e) { return back(token, (e as Error).message); }
  const reason = String(req.body?.reason ?? '');
  const valid = ctx.business.pack.reasons.cancel.some((r) => r.code === reason);
  await cancelBooking(tx, ctx.business.id, b.id, valid ? reason : undefined);
  return back(token, 'Cancelled. Thanks for letting us know.');
}));

router.add('POST', '/m/:token/b/:bid/skip', async (req) => withPortal(req, async (tx, who, token) => {
  const ctx = await siteContext(tx, who.base);
  const b = await ownBooking(tx, who.customerId, req.params.bid);
  try { assertChangeable(b, noticeOf(ctx.business.settings, schedulingRules(ctx.business).min_notice_hours)); } catch (e) { return back(token, (e as Error).message); }
  await skipBooking(tx, ctx.business, b.id);
  return back(token, 'Skipped. Your plan continues after that.');
}));

async function ownSeries(tx: Tx, customerId: string, sid: string) {
  if (!uuid.safeParse(sid).success) throw new HttpError(404, 'not found');
  const s = (await tx.query<{ customer_id: string }>(`select customer_id from series where id = $1`, [sid])).rows[0];
  if (!s || s.customer_id !== customerId) throw new HttpError(404, 'not found');
}

router.add('POST', '/m/:token/s/:sid/pause', async (req) => withPortal(req, async (tx, who, token) => {
  await ownSeries(tx, who.customerId, req.params.sid);
  const ctx = await siteContext(tx, who.base);
  const weeks = [2, 4, 8].includes(Number(req.body?.weeks)) ? Number(req.body.weeks) : 4;
  const tz = ctx.business.timezone;
  const until = new Date(`${addLocalDays(localParts(new Date(), tz).date, weeks * 7)}T12:00:00Z`);
  await pauseSeries(tx, ctx.business, req.params.sid, until);
  return back(token, `Paused for ${weeks} weeks. We’ll pick up after that.`);
}));

router.add('POST', '/m/:token/s/:sid/resume', async (req) => withPortal(req, async (tx, who, token) => {
  await ownSeries(tx, who.customerId, req.params.sid);
  const ctx = await siteContext(tx, who.base);
  await resumeSeries(tx, ctx.business, req.params.sid);
  return back(token, 'Welcome back. Your plan is active again.');
}));
