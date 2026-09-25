import { z } from 'zod';
import { withSystem, withTenant } from '../../db/pool.js';
import { HttpError } from '../../lib/http.js';
import { verifySig } from '../../lib/sign.js';
import { html, page, SITE_CSP } from '../../site/html.js';
import { emit } from '../../core/events.js';
import { router } from '../context.js';

/** One-click email unsubscribe (link in every marketing email, and the List-Unsubscribe header). */
async function unsubscribe(customerId: string, sig: string | null) {
  if (!z.string().uuid().safeParse(customerId).success || !verifySig('unsub', customerId, sig)) throw new HttpError(404, 'not found');
  const businessId = await withSystem(async (tx) => (await tx.query<{ b: string | null }>(`select customer_business($1) as b`, [customerId])).rows[0].b);
  if (!businessId) throw new HttpError(404, 'not found');
  return withTenant(businessId, async (tx) => {
    await tx.query(`update customers set email_consent = false where id = $1`, [customerId]);
    await emit(tx, businessId, 'customer.consent_changed', { type: 'customer', id: customerId }, { email_consent: false });
    return (await tx.query<{ name: string }>(`select name from businesses where id = app_business_id()`)).rows[0].name;
  });
}

router.add('GET', '/u/:id', async (req) => {
  const name = await unsubscribe(req.params.id, req.query.get('t'));
  const body = html`<main class="wrap narrow flow"><h1>You’re unsubscribed</h1><p>${name} won’t send you marketing emails anymore. You’ll still get messages about bookings you make.</p></main>`;
  return { text: page({ title: 'Unsubscribed', body, themeHref: '/assets/site/theme-clean.css', noindex: true }), contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': SITE_CSP } };
});

router.add('POST', '/u/:id', async (req) => {
  await unsubscribe(req.params.id, req.query.get('t'));
  return { json: { ok: true } };
});
