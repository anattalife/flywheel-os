import { z } from 'zod';
import { config } from '../../config.js';
import { google } from '../../adapters/google/index.js';
import { storage } from '../../adapters/storage/index.js';
import { withSystem, withTenant } from '../../db/pool.js';
import { HttpError } from '../../lib/http.js';
import { sign, verifySig } from '../../lib/sign.js';
import { decryptJson } from '../../lib/crypto.js';
import { loadBusiness } from '../../core/business.js';
import { emit } from '../../core/events.js';
import {
  addPhoto, checkAiVisibility, chooseLocation, connectGoogle, draftProfilePost, draftReviewReply, googleIntegration, mediaUrl,
  postReviewReply, publishProfilePost, syncGoogleReviews,
} from '../../core/discovery.js';
import { getSession } from '../../core/auth.js';
import { SESSION_COOKIE, owner, parse, router } from '../context.js';

const uuid = z.string().uuid();
const idParam = (v: string) => { if (!uuid.safeParse(v).success) throw new HttpError(404, 'not found'); return v; };
const redirectUri = () => `${config().PUBLIC_BASE_URL}/oauth/google/callback`;

// ---- Google connection ------------------------------------------------------------------

router.add('GET', '/v1/google', owner(async (req) => ({
  json: await withTenant(req.businessId, async (tx) => {
    const i = await googleIntegration(tx);
    if (!i) return { connected: false, live: google().name === 'google' };
    const out: Record<string, unknown> = { connected: true, status: i.status, location: i.location_title, last_sync_at: i.last_sync_at, last_error: i.last_error, live: google().name === 'google' };
    if (i.status === 'needs_location' && i.credentials) {
      const token = await google().accessToken(decryptJson(i.credentials));
      out.locations = await google().listLocations(token);
    }
    return out;
  }),
})));

/**
 * Start Google's sign-in. The state names the business and the signed-in user and
 * is signed; the callback only accepts it from that same user's session, so a
 * link can't be used to attach someone else's Google account to another business.
 */
router.add('GET', '/v1/google/connect', owner(async (req) => {
  if (!req.userId) throw new HttpError(400, 'Sign in to the app to connect Google.');
  const exp = Date.now() + 15 * 60_000;
  const payload = `${req.businessId}.${req.userId}.${exp}`;
  const state = `${payload}.${sign('google-state', payload)}`;
  return { json: { url: google().authUrl(state, redirectUri()) } };
}, { ownerOnly: true }));

router.add('GET', '/oauth/google/callback', async (req) => {
  const [businessId, userId, exp, sig] = (req.query.get('state') ?? '').split('.');
  const back = (q: string) => ({ status: 303, text: '', headers: { location: `/app/grow?${q}` } });
  if (!businessId || !userId || !exp || !verifySig('google-state', `${businessId}.${userId}.${exp}`, sig) || Number(exp) < Date.now()) return back('google=expired');
  const session = await getSession(req.cookies[SESSION_COOKIE] ?? '');
  if (!session || session.userId !== userId || session.businessId !== businessId || session.role !== 'owner') return back('google=expired');
  const code = req.query.get('code');
  if (!code) return back('google=cancelled');
  try {
    const creds = await google().exchangeCode(code, redirectUri());
    await withTenant(businessId, (tx) => connectGoogle(tx, businessId, creds));
    return back('google=connected');
  } catch (e) {
    console.error('google connect failed', e);
    return back('google=failed');
  }
});

router.add('POST', '/v1/google/location', owner(async (req) => {
  const b = parse(z.object({ account: z.string().min(1), location: z.string().min(1) }), req.body);
  return { json: await withTenant(req.businessId, (tx) => chooseLocation(tx, b.account, b.location)) };
}, { ownerOnly: true }));

router.add('POST', '/v1/google/sync', owner(async (req) => ({
  json: await withTenant(req.businessId, async (tx) => syncGoogleReviews(tx, await loadBusiness(tx))),
})));

router.add('DELETE', '/v1/google', owner(async (req) => {
  await withTenant(req.businessId, (tx) => tx.query(`delete from integrations where provider = 'google'`));
  return { json: { ok: true } };
}, { ownerOnly: true }));

// ---- reviews --------------------------------------------------------------------------------

router.add('GET', '/v1/reviews', owner(async (req) => {
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `select r.id, r.platform, r.rating, r.body, r.reviewer_name, r.reply, r.reply_draft, r.reply_status, r.is_private_feedback, r.created_at,
            c.first_name, c.last_name
     from reviews r left join customers c on c.id = r.customer_id order by r.created_at desc limit 100`));
  return { json: r.rows };
}));

router.add('POST', '/v1/reviews', owner(async (req) => {
  const b = parse(z.object({ platform: z.string().min(1).max(40), rating: z.number().int().min(1).max(5), body: z.string().max(4000).optional(), reviewer_name: z.string().max(120).optional() }), req.body);
  const id = await withTenant(req.businessId, async (tx) => {
    const r = await tx.query<{ id: string }>(`insert into reviews (business_id, platform, rating, body, reviewer_name) values ($1, $2, $3, $4, $5) returning id`, [req.businessId, b.platform, b.rating, b.body ?? null, b.reviewer_name ?? null]);
    await emit(tx, req.businessId, 'review.received', { type: 'review', id: r.rows[0].id }, { platform: b.platform, rating: b.rating, has_reply: false });
    return r.rows[0].id;
  });
  return { status: 201, json: { id } };
}));

router.add('POST', '/v1/reviews/:id/draft', owner(async (req) => ({
  json: { text: await withTenant(req.businessId, async (tx) => draftReviewReply(tx, await loadBusiness(tx), idParam(req.params.id))) },
})));

router.add('POST', '/v1/reviews/:id/reply', owner(async (req) => {
  const b = parse(z.object({ text: z.string().max(4000).optional() }), req.body);
  await withTenant(req.businessId, (tx) => postReviewReply(tx, idParam(req.params.id), b.text));
  return { json: { ok: true } };
}));

// ---- photos -----------------------------------------------------------------------------------

/** Upload one photo as the raw request body (Content-Type: image/jpeg, image/png or image/webp). */
router.add('POST', '/v1/photos', owner(async (req) => {
  if (!req.rawBuffer?.length) throw new HttpError(400, 'Send the photo as the request body.');
  const bookingId = req.query.get('booking_id');
  if (bookingId && !uuid.safeParse(bookingId).success) throw new HttpError(400, 'bad booking_id');
  const id = await withTenant(req.businessId, async (tx) => addPhoto(tx, await loadBusiness(tx),
    { body: req.rawBuffer!, contentType: String(req.headers['content-type'] ?? '').split(';')[0].trim() },
    { bookingId, publicOk: req.query.get('public_ok') === '1', caption: req.query.get('caption')?.slice(0, 200) ?? null }));
  return { status: 201, json: { id } };
}));

router.add('GET', '/v1/photos', owner(async (req) => ({
  json: await withTenant(req.businessId, async (tx) => {
    const b = await loadBusiness(tx);
    const rows = (await tx.query(
      `select p.id, p.booking_id, p.public_ok, p.caption, p.created_at, c.first_name, c.last_name from photos p left join customers c on c.id = p.customer_id
       where ($1::uuid is null or p.booking_id = $1) order by p.created_at desc limit 60`, [req.query.get('booking_id')])).rows;
    return rows.map((r: any) => ({ ...r, url: mediaUrl(b, r.id) }));
  }),
})));

router.add('GET', '/media/:id', async (req) => {
  const id = idParam(req.params.id);
  if (!verifySig('media', id, req.query.get('t'))) throw new HttpError(404, 'not found');
  const businessId = await withSystem(async (tx) => (await tx.query<{ b: string | null }>(`select photo_business($1) as b`, [id])).rows[0].b);
  if (!businessId) throw new HttpError(404, 'not found');
  const key = await withTenant(businessId, async (tx) => (await tx.query<{ storage_key: string }>(`select storage_key from photos where id = $1`, [id])).rows[0]?.storage_key);
  const file = key ? await storage().get(key) : null;
  if (!file) throw new HttpError(404, 'not found');
  return { text: file.body, contentType: file.contentType, headers: { 'cache-control': 'private, max-age=86400' } };
});

// ---- Business Profile posts ---------------------------------------------------------------------

router.add('GET', '/v1/posts', owner(async (req) => ({
  json: await withTenant(req.businessId, async (tx) => {
    const b = await loadBusiness(tx);
    const rows = (await tx.query(`select id, photo_id, body, status, error, created_at, published_at from gbp_posts order by created_at desc limit 50`)).rows;
    return rows.map((r: any) => ({ ...r, photo_url: r.photo_id ? mediaUrl(b, r.photo_id) : null }));
  }),
})));
router.add('POST', '/v1/posts/draft', owner(async (req) => {
  const id = await withTenant(req.businessId, async (tx) => draftProfilePost(tx, await loadBusiness(tx)));
  if (!id) throw new HttpError(409, 'Add a photo the customer agreed to share first.');
  return { status: 201, json: { id } };
}));
router.add('POST', '/v1/posts/:id/publish', owner(async (req) => {
  const b = parse(z.object({ body: z.string().min(1).max(1500).optional() }), req.body);
  await withTenant(req.businessId, async (tx) => publishProfilePost(tx, await loadBusiness(tx), idParam(req.params.id), b.body));
  return { json: { ok: true } };
}));
router.add('POST', '/v1/posts/:id/reject', owner(async (req) => {
  await withTenant(req.businessId, (tx) => tx.query(`update gbp_posts set status = 'rejected' where id = $1 and status in ('draft','failed')`, [idParam(req.params.id)]));
  return { json: { ok: true } };
}));

// ---- AI assistant visibility -----------------------------------------------------------------------

router.add('GET', '/v1/ai-visibility', owner(async (req) => ({
  json: (await withTenant(req.businessId, (tx) => tx.query(`select query, mentioned, excerpt, provider, created_at from ai_checks order by created_at desc limit 20`))).rows,
})));
router.add('POST', '/v1/ai-visibility/check', owner(async (req) => ({
  json: await withTenant(req.businessId, async (tx) => checkAiVisibility(tx, await loadBusiness(tx))),
})));
