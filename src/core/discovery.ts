import { aiFor } from '../adapters/ai/index.js';
import { google } from '../adapters/google/index.js';
import type { GoogleCreds } from '../adapters/google/types.js';
import { storage } from '../adapters/storage/index.js';
import type { Tx } from '../db/pool.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { sign } from '../lib/sign.js';
import { render } from '../lib/template.js';
import { links, templateData, type Business } from './business.js';
import { emit } from './events.js';
import { siteSettings } from '../site/settings.js';

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

// ---------- Google connection ----------

export interface Integration { id: string; credentials: string | null; account: string | null; location: string | null; location_title: string | null; status: string; last_sync_at: Date | null; last_error: string | null }

export async function googleIntegration(tx: Tx): Promise<Integration | null> {
  return (await tx.query<Integration>(`select * from integrations where provider = 'google'`)).rows[0] ?? null;
}

async function withGoogle<T>(tx: Tx, fn: (token: string, i: Integration) => Promise<T>): Promise<T> {
  const i = await googleIntegration(tx);
  if (!i?.credentials || !i.account || !i.location) throw err(409, 'Connect your Google Business Profile first.');
  const creds = decryptJson<GoogleCreds>(i.credentials);
  const before = creds.access_token;
  const token = await google().accessToken(creds);
  if (creds.access_token !== before) await tx.query(`update integrations set credentials = $2 where id = $1`, [i.id, encryptJson(creds)]);
  return fn(token, i);
}

/** Save the owner's Google authorization and pick their location if there's only one. */
export async function connectGoogle(tx: Tx, businessId: string, creds: GoogleCreds) {
  const token = await google().accessToken(creds);
  const locations = await google().listLocations(token);
  const one = locations.length === 1 ? locations[0] : null;
  await tx.query(
    `insert into integrations (business_id, provider, credentials, account, location, location_title, status, connected_at, last_error)
     values ($1, 'google', $2, $3, $4, $5, $6, now(), null)
     on conflict (business_id, provider) do update set credentials = excluded.credentials, account = excluded.account, location = excluded.location,
       location_title = excluded.location_title, status = excluded.status, connected_at = now(), last_error = null`,
    [businessId, encryptJson(creds), one?.account ?? null, one?.location ?? null, one?.title ?? null, one ? 'connected' : 'needs_location']);
  await emit(tx, businessId, 'google.connected', null, { locations: locations.length });
  return locations;
}

export async function chooseLocation(tx: Tx, account: string, location: string) {
  const available = await withGoogleToken(tx, (token) => google().listLocations(token));
  const pick = available.find((l) => l.account === account && l.location === location);
  if (!pick) throw err(404, 'That location is not on your Google account.');
  await tx.query(`update integrations set account = $1, location = $2, location_title = $3, status = 'connected' where provider = 'google'`, [pick.account, pick.location, pick.title]);
  return pick;
}

async function withGoogleToken<T>(tx: Tx, fn: (token: string) => Promise<T>) {
  const i = await googleIntegration(tx);
  if (!i?.credentials) throw err(409, 'Connect Google first.');
  return fn(await google().accessToken(decryptJson<GoogleCreds>(i.credentials)));
}

// ---------- reviews ----------

/** Pull Google reviews in; new ones become review.received events (which draft replies). */
export async function syncGoogleReviews(tx: Tx, business: Business) {
  const i = await googleIntegration(tx);
  if (!i || i.status !== 'connected') return { skipped: true };
  try {
    return await withGoogle(tx, async (token, integ) => {
      const reviews = await google().listReviews(token, integ.account!, integ.location!);
      let added = 0;
      for (const r of reviews) {
        const ins = await tx.query<{ id: string }>(
          `insert into reviews (business_id, platform, external_id, rating, body, reviewer_name, reply, reply_status, created_at, customer_id)
           values ($1, 'google', $2, $3, $4, $5, $6, $7, $8,
             (select c.id from customers c where lower(c.first_name || ' ' || coalesce(c.last_name, '')) = lower($5) limit 1))
           on conflict (business_id, platform, external_id) where external_id is not null
           do update set rating = excluded.rating, body = excluded.body, reply = coalesce(excluded.reply, reviews.reply),
             reply_status = case when excluded.reply is not null then 'posted' else reviews.reply_status end
           returning id, (xmax = 0) as inserted`,
          [business.id, r.id, r.rating, r.comment, r.reviewer, r.reply, r.reply ? 'posted' : 'none', r.createdAt]);
        if ((ins.rows[0] as any).inserted) {
          added++;
          await emit(tx, business.id, 'review.received', { type: 'review', id: ins.rows[0].id }, { platform: 'google', rating: r.rating, has_reply: !!r.reply });
        }
      }
      await tx.query(`update integrations set last_sync_at = now(), last_error = null where id = $1`, [integ.id]);
      return { added, total: reviews.length };
    });
  } catch (e) {
    await tx.query(`update integrations set last_error = $1 where provider = 'google'`, [(e as Error).message.slice(0, 500)]);
    throw e;
  }
}

/** Write a reply to a review: in the owner's voice with AI when it's on, otherwise from a template. */
export async function draftReviewReply(tx: Tx, business: Business, reviewId: string): Promise<string | null> {
  const r = (await tx.query<{ rating: number; body: string | null; reviewer_name: string | null; reply_status: string }>(`select rating, body, reviewer_name, reply_status from reviews where id = $1`, [reviewId])).rows[0];
  if (!r || r.reply_status === 'posted') return null;
  const first = (r.reviewer_name ?? '').split(' ')[0] || null;
  let text: string | null = null;
  const ai = aiFor(business.settings);
  if (ai) {
    text = await ai.complete({
      system: [`You write short public replies to Google reviews for ${business.name}, a small service business, in the owner's voice.`,
        'Two to three sentences. Thank them by first name if given. Mention a specific detail from their review. Never offer discounts publicly.',
        'For 1-3 star reviews: apologize without arguing, and invite them to contact the business directly. Never reveal private customer details.',
        business.settings?.ai_notes ? `Owner notes: ${business.settings.ai_notes}` : '', 'Reply with the text only.'].filter(Boolean).join('\n'),
      messages: [{ role: 'user', content: `${r.rating} stars from ${r.reviewer_name ?? 'a customer'}: ${r.body ?? '(no text)'}` }],
      tier: 'strong', maxTokens: 250,
    }).catch(() => null);
  }
  if (!text) {
    const key = r.rating >= 4 ? 'review_reply_positive' : 'review_reply_negative';
    text = render(business.pack.templates[key] ?? '', { ...templateData(business), review: { first_name: first } });
  }
  await tx.query(`update reviews set reply_draft = $2, reply_status = 'drafted' where id = $1`, [reviewId, text]);
  return text;
}

export async function postReviewReply(tx: Tx, reviewId: string, text?: string) {
  const r = (await tx.query<{ external_id: string | null; platform: string; reply_draft: string | null; reply_status: string }>(`select external_id, platform, reply_draft, reply_status from reviews where id = $1`, [reviewId])).rows[0];
  if (!r) throw err(404, 'review not found');
  if (r.platform !== 'google' || !r.external_id) throw err(409, 'Only Google reviews can be replied to from here.');
  const comment = (text ?? r.reply_draft ?? '').trim();
  if (!comment) throw err(400, 'Write a reply first.');
  try {
    await withGoogle(tx, (token, i) => google().replyToReview(token, i.account!, i.location!, r.external_id!, comment));
  } catch (e) {
    await tx.query(`update reviews set reply_status = 'failed', reply_draft = $2 where id = $1`, [reviewId, comment]);
    throw e;
  }
  await tx.query(`update reviews set reply = $2, reply_draft = null, reply_status = 'posted', replied_at = now() where id = $1`, [reviewId, comment]);
}

// ---------- photos and Business Profile posts ----------

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function addPhoto(tx: Tx, business: Business, file: { body: Buffer; contentType: string }, meta: { bookingId?: string | null; customerId?: string | null; publicOk: boolean; caption?: string | null }) {
  const ext = TYPES[file.contentType];
  if (!ext) throw err(415, 'Upload a JPEG, PNG or WebP photo.');
  if (file.body.length > MAX_PHOTO_BYTES) throw err(413, 'That photo is too large (8 MB max).');
  if (meta.bookingId) {
    const b = (await tx.query<{ customer_id: string }>(`select customer_id from bookings where id = $1`, [meta.bookingId])).rows[0];
    if (!b) throw err(404, 'booking not found');
    meta.customerId = b.customer_id;
  }
  const r = (await tx.query<{ id: string }>(
    `insert into photos (business_id, booking_id, customer_id, storage_key, content_type, bytes, public_ok, caption) values ($1, $2, $3, '', $4, $5, $6, $7) returning id`,
    [business.id, meta.bookingId ?? null, meta.customerId ?? null, file.contentType, file.body.length, meta.publicOk, meta.caption ?? null])).rows[0];
  const key = `${business.id}/photos/${r.id}.${ext}`;
  await storage().put(key, file.body, file.contentType);
  await tx.query(`update photos set storage_key = $2 where id = $1`, [r.id, key]);
  await emit(tx, business.id, 'photo.added', { type: 'photo', id: r.id }, { booking_id: meta.bookingId ?? null, public_ok: meta.publicOk });
  return r.id;
}

export const mediaUrl = (b: Business, photoId: string) => `${links(b).origin}/media/${photoId}?t=${sign('media', photoId)}`;

/**
 * Weekly: turn the newest customer-approved photo into a draft Business Profile
 * post (AI caption when on, template otherwise). The owner publishes it.
 */
export async function draftProfilePost(tx: Tx, business: Business) {
  const photo = (await tx.query<{ id: string; caption: string | null; service: string | null }>(
    `select p.id, p.caption, s.name as service from photos p left join bookings b on b.id = p.booking_id left join services s on s.id = b.service_id
     where p.public_ok and not exists (select 1 from gbp_posts g where g.photo_id = p.id)
     order by p.created_at desc limit 1`)).rows[0];
  if (!photo) return null;
  const site = siteSettings(business);
  let body: string | null = null;
  const ai = aiFor(business.settings);
  if (ai) {
    body = await ai.complete({
      system: `Write a Google Business Profile post for ${business.name}. 1-2 short sentences, friendly and specific, no hashtags, no emoji, no prices, no customer names or addresses. End with an invitation to book online.`,
      messages: [{ role: 'user', content: `Photo of a finished ${photo.service ?? business.pack.vocabulary.job.one}${photo.caption ? `: ${photo.caption}` : ''}. Service area: ${site.service_area ?? 'local'}.` }],
      tier: 'fast', maxTokens: 120,
    }).catch(() => null);
  }
  body ??= render(business.pack.templates.profile_post ?? '', templateData(business));
  const r = await tx.query<{ id: string }>(`insert into gbp_posts (business_id, photo_id, body) values ($1, $2, $3) returning id`, [business.id, photo.id, body]);
  await emit(tx, business.id, 'post.drafted', { type: 'post', id: r.rows[0].id }, { photo_id: photo.id });
  if (business.pack.playbooks.profile_posts.trust === 'auto') await publishProfilePost(tx, business, r.rows[0].id).catch(() => {});
  return r.rows[0].id;
}

export async function publishProfilePost(tx: Tx, business: Business, postId: string, body?: string) {
  const p = (await tx.query<{ body: string; photo_id: string | null; status: string }>(`select body, photo_id, status from gbp_posts where id = $1`, [postId])).rows[0];
  if (!p) throw err(404, 'post not found');
  if (p.status === 'published') throw err(409, 'Already published.');
  const summary = (body ?? p.body).trim();
  try {
    const external = await withGoogle(tx, (token, i) => google().createPost(token, i.account!, i.location!, {
      summary, photoUrl: p.photo_id ? mediaUrl(business, p.photo_id) : undefined, bookUrl: links(business).booking,
    }));
    await tx.query(`update gbp_posts set status = 'published', body = $2, external_id = $3, published_at = now(), error = null where id = $1`, [postId, summary, external]);
  } catch (e) {
    await tx.query(`update gbp_posts set status = 'failed', body = $2, error = $3 where id = $1`, [postId, summary, (e as Error).message.slice(0, 500)]);
    throw e;
  }
}

// ---------- AI assistant visibility ----------

/**
 * Ask an AI assistant (with live web search) the questions customers ask, and
 * record whether this business is named in the answer.
 */
export async function checkAiVisibility(tx: Tx, business: Business) {
  const ai = aiFor(business.settings);
  if (!ai?.searchAnswer) return { skipped: 'Your AI provider cannot search the web, so this check is off.' };
  const site = siteSettings(business);
  const areas = site.areas.length ? site.areas.slice(0, 2) : site.service_area ? [site.service_area] : [];
  if (!areas.length) return { skipped: 'Add your service area on the Website settings first.' };
  const v = business.pack.vocabulary;
  const results = [];
  for (const area of areas) {
    const query = `Who are the best ${v.job.one} services in ${area}? Recommend a few by name.`;
    const answer = await ai.searchAnswer(query);
    const mentioned = answer.toLowerCase().includes(business.name.toLowerCase());
    const idx = answer.toLowerCase().indexOf(business.name.toLowerCase());
    const excerpt = mentioned ? answer.slice(Math.max(0, idx - 80), idx + business.name.length + 120) : answer.slice(0, 280);
    await tx.query(`insert into ai_checks (business_id, query, mentioned, excerpt, provider) values ($1, $2, $3, $4, $5)`, [business.id, query, mentioned, excerpt, ai.name]);
    results.push({ query, mentioned });
  }
  return { results };
}
