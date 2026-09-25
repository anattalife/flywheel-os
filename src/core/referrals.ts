import { randomInt } from 'node:crypto';
import type { Tx } from '../db/pool.js';
import { links, type Business } from './business.js';
import { emit } from './events.js';

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

/** A short, readable code like MARIA42: the customer's first name plus two digits. */
export async function referralCode(tx: Tx, customerId: string): Promise<string> {
  const c = (await tx.query<{ referral_code: string | null; first_name: string | null }>(`select referral_code, first_name from customers where id = $1`, [customerId])).rows[0];
  if (!c) throw err(404, 'customer not found');
  if (c.referral_code) return c.referral_code;
  const stem = (c.first_name ?? 'FRIEND').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'FRIEND';
  for (let i = 0; i < 20; i++) {
    const code = `${stem}${randomInt(i < 10 ? 10 : 100, i < 10 ? 100 : 1000)}`;
    const r = await tx.query(`update customers set referral_code = $2 where id = $1 and referral_code is null and not exists (select 1 from customers where referral_code = $2)`, [customerId, code]);
    if (r.rowCount) return code;
  }
  throw err(500, 'could not create a referral code');
}

export const referralLink = (b: Business, code: string) => `${links(b).site}/r/${encodeURIComponent(code)}`;

export async function referrerByCode(tx: Tx, code: string) {
  return (await tx.query<{ id: string; first_name: string | null }>(`select id, first_name from customers where referral_code = upper($1)`, [code.trim()])).rows[0] ?? null;
}

/**
 * Link a new customer to whoever referred them, and give the friend their welcome
 * credit now so it comes off their first invoice. The referrer is rewarded later,
 * when the friend's first job is completed.
 */
export async function recordReferral(tx: Tx, business: Business, code: string, friendId: string) {
  const cfg = business.pack.referrals;
  if (!cfg.enabled) return null;
  const referrer = await referrerByCode(tx, code);
  if (!referrer || referrer.id === friendId) return null;
  const prior = await tx.query(`select 1 from bookings where customer_id = $1 and status = 'completed' limit 1`, [friendId]);
  if (prior.rowCount) return null; // referrals are for new customers
  const r = await tx.query<{ id: string }>(
    `insert into referrals (business_id, referrer_id, code, referred_customer_id, status, reward_cents, friend_credit_cents)
     values ($1, $2, upper($3), $4, 'open', $5, $6) on conflict do nothing returning id`,
    [business.id, referrer.id, code, friendId, cfg.reward_cents, cfg.friend_credit_cents]);
  if (!r.rowCount) return null;
  await tx.query(`update customers set source = 'referral', source_detail = source_detail || jsonb_build_object('referral_code', upper($2::text)) where id = $1 and (source is null or source in ('website','unknown','inbound_text','phone'))`, [friendId, code]);
  if (cfg.friend_credit_cents > 0) await grantCredit(tx, business.id, friendId, cfg.friend_credit_cents, 'Welcome credit from a friend', r.rows[0].id);
  await emit(tx, business.id, 'referral.created', { type: 'referral', id: r.rows[0].id }, { customer_id: friendId, referrer_id: referrer.id });
  return r.rows[0].id;
}

/** Called when a referred friend's first job is completed: thank the referrer with credit. */
export async function convertReferral(tx: Tx, business: Business, friendId: string) {
  const ref = (await tx.query<{ id: string; referrer_id: string; reward_cents: number | null }>(
    `update referrals set status = 'rewarded', reward_granted_at = now() where referred_customer_id = $1 and status = 'open' returning id, referrer_id, reward_cents`, [friendId])).rows[0];
  if (!ref) return null;
  if (ref.reward_cents) await grantCredit(tx, business.id, ref.referrer_id, ref.reward_cents, 'Thanks for the referral', ref.id);
  await emit(tx, business.id, 'referral.converted', { type: 'referral', id: ref.id }, { customer_id: ref.referrer_id, friend_id: friendId, reward_cents: ref.reward_cents });
  return ref.id;
}

export async function grantCredit(tx: Tx, businessId: string, customerId: string, cents: number, reason: string, referralId?: string) {
  await tx.query(`insert into credits (business_id, customer_id, amount_cents, reason, referral_id) values ($1, $2, $3, $4, $5)`, [businessId, customerId, cents, reason, referralId ?? null]);
  await emit(tx, businessId, 'credit.granted', { type: 'customer', id: customerId }, { customer_id: customerId, amount_cents: cents, reason });
}

export async function creditBalance(tx: Tx, customerId: string): Promise<number> {
  return (await tx.query<{ n: number }>(`select coalesce(sum(amount_cents), 0)::int as n from credits where customer_id = $1`, [customerId])).rows[0].n;
}
