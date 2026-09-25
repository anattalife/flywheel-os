import { z } from 'zod';
import { withTenant, type Tx } from '../../db/pool.js';
import { HttpError } from '../../lib/http.js';
import { loadBusiness } from '../../core/business.js';
import { dollars } from '../../core/billing.js';
import { creditBalance, grantCredit, referralCode, referralLink } from '../../core/referrals.js';
import { scoreHealth } from '../../core/retention.js';
import { html } from '../../site/html.js';
import { owner, parse, router } from '../context.js';
import { portalExtras } from './portal.js';

const uuid = z.string().uuid();
const idParam = (v: string) => { if (!uuid.safeParse(v).success) throw new HttpError(404, 'not found'); return v; };

portalExtras.push(async (tx: Tx, customerId: string) => {
  const business = await loadBusiness(tx);
  if (!business.pack.referrals.enabled) return '';
  const visits = (await tx.query<{ n: number }>(`select count(*)::int as n from bookings where customer_id = $1 and status = 'completed'`, [customerId])).rows[0].n;
  const balance = await creditBalance(tx, customerId);
  if (!visits && !balance) return '';
  const code = await referralCode(tx, customerId);
  const r = business.pack.referrals;
  return html`<h2>Share and save</h2><div class="card">
  <p>Give friends ${dollars(r.friend_credit_cents)} off their first visit, and get ${dollars(r.reward_cents)} credit when they book.</p>
  <p><strong>Your link:</strong> <a href="${referralLink(business, code)}">${referralLink(business, code)}</a></p>
  ${balance > 0 ? html`<p class="muted">Your credit: ${dollars(balance)}, applied to your next invoice.</p>` : ''}
</div>`.html;
});

router.add('GET', '/v1/customers/:id/referral', owner(async (req) => {
  const id = idParam(req.params.id);
  return {
    json: await withTenant(req.businessId, async (tx) => {
      const business = await loadBusiness(tx);
      const code = await referralCode(tx, id);
      const made = (await tx.query(`select r.status, c.first_name, c.last_name, r.created_at from referrals r left join customers c on c.id = r.referred_customer_id where r.referrer_id = $1 order by r.created_at desc`, [id])).rows;
      return { code, link: referralLink(business, code), credit_cents: await creditBalance(tx, id), referrals: made };
    }),
  };
}));

router.add('POST', '/v1/customers/:id/credits', owner(async (req) => {
  const b = parse(z.object({ amount_cents: z.number().int().positive().max(1_000_000), reason: z.string().min(1).max(200) }), req.body);
  const id = idParam(req.params.id);
  await withTenant(req.businessId, async (tx) => {
    if (!(await tx.query(`select 1 from customers where id = $1`, [id])).rowCount) throw new HttpError(404, 'customer not found');
    await grantCredit(tx, req.businessId, id, b.amount_cents, b.reason);
  });
  return { status: 201, json: { ok: true } };
}, { ownerOnly: true }));

/** Refresh health scores now instead of waiting for the nightly run. */
router.add('POST', '/v1/health/refresh', owner(async (req) => ({
  json: await withTenant(req.businessId, async (tx) => scoreHealth(tx, await loadBusiness(tx))),
})));
