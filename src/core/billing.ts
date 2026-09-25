import { config } from '../config.js';
import { payments } from '../adapters/payments/index.js';
import type { Tx } from '../db/pool.js';
import { sign } from '../lib/sign.js';
import { links, type Business } from './business.js';
import { emit } from './events.js';
import { creditBalance } from './referrals.js';

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

export interface Invoice {
  id: string; customer_id: string; booking_id: string | null; number: number; description: string;
  amount_cents: number; refunded_cents: number; status: 'open' | 'paid' | 'failed' | 'void' | 'refunded';
  payment_intent_id: string | null; failure_reason: string | null; attempts: number; paid_at: Date | null; created_at: Date;
}

export const dollars = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const payLink = (b: Business, invoiceId: string) => `${links(b).origin}/pay/${invoiceId}?t=${sign('pay', invoiceId)}`;
export const receiptLink = (b: Business, invoiceId: string) => `${links(b).origin}/receipt/${invoiceId}?t=${sign('receipt', invoiceId)}`;

export async function getInvoice(tx: Tx, id: string): Promise<Invoice | null> {
  return (await tx.query<Invoice>(`select * from invoices where id = $1`, [id])).rows[0] ?? null;
}

export async function createInvoice(tx: Tx, business: Business, i: { customerId: string; bookingId?: string | null; amountCents: number; description: string }) {
  if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) throw err(400, 'The amount must be more than zero.');
  const visible = await tx.query(`select 1 from customers where id = $1`, [i.customerId]);
  if (!visible.rowCount) throw err(404, 'customer not found');
  if (i.bookingId) {
    // Foreign keys ignore row-level security, so check the booking is this business's and this customer's.
    const b = await tx.query(`select 1 from bookings where id = $1 and customer_id = $2`, [i.bookingId, i.customerId]);
    if (!b.rowCount) throw err(404, 'booking not found');
  }
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`invoice-number:${business.id}`]);
  const next = (await tx.query<{ n: number }>(`select coalesce(max(number), 1000) + 1 as n from invoices`)).rows[0].n;
  // Account credit (referral rewards, goodwill) comes off automatically.
  const credit = Math.min(i.amountCents, await creditBalance(tx, i.customerId));
  const amount = i.amountCents - credit;
  const description = credit ? `${i.description} (credit applied: ${dollars(credit)})` : i.description;
  const inv = (await tx.query<Invoice>(
    `insert into invoices (business_id, customer_id, booking_id, number, description, amount_cents) values ($1, $2, $3, $4, $5, $6) returning *`,
    [business.id, i.customerId, i.bookingId ?? null, next, description, amount])).rows[0];
  if (credit) await tx.query(`insert into credits (business_id, customer_id, amount_cents, reason, invoice_id) values ($1, $2, $3, $4, $5)`, [business.id, i.customerId, -credit, `Applied to invoice #${next}`, inv.id]);
  await emit(tx, business.id, 'invoice.created', { type: 'invoice', id: inv.id }, { customer_id: i.customerId, amount_cents: amount, credit_cents: credit });
  if (amount === 0) {
    await markPaid(tx, business.id, inv.id, { providerId: null, amountCents: 0, method: 'other' });
    return (await getInvoice(tx, inv.id))!;
  }
  return inv;
}

async function stripeCustomer(tx: Tx, business: Business, customerId: string): Promise<string> {
  const c = (await tx.query<{ stripe_customer_id: string | null; first_name: string | null; last_name: string | null; email: string | null; phone: string | null }>(
    `select stripe_customer_id, first_name, last_name, email, phone from customers where id = $1`, [customerId])).rows[0];
  if (!c) throw err(404, 'customer not found');
  const id = await payments().ensureCustomer({
    existing: c.stripe_customer_id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null, email: c.email, phone: c.phone,
    metadata: { business_id: business.id, customer_id: customerId },
  });
  if (!c.stripe_customer_id) await tx.query(`update customers set stripe_customer_id = $2 where id = $1`, [customerId, id]);
  return id;
}

/** A hosted checkout page for one invoice. Created on demand, so links in texts never go stale. */
export async function checkoutForInvoice(tx: Tx, business: Business, invoiceId: string) {
  const inv = await getInvoice(tx, invoiceId);
  if (!inv) throw err(404, 'invoice not found');
  if (inv.status !== 'open' && inv.status !== 'failed') throw err(409, `This invoice is ${inv.status}.`);
  const customer = await stripeCustomer(tx, business, inv.customer_id);
  return payments().createCheckout({
    mode: 'payment', customer, amountCents: inv.amount_cents, description: `${business.name}: ${inv.description}`,
    metadata: { business_id: business.id, invoice_id: inv.id, customer_id: inv.customer_id },
    successUrl: receiptLink(business, inv.id), cancelUrl: payLink(business, inv.id),
  });
}

/** Hosted page to save or replace the customer's card. */
export async function checkoutForCard(tx: Tx, business: Business, customerId: string, returnUrl: string) {
  const customer = await stripeCustomer(tx, business, customerId);
  return payments().createCheckout({
    mode: 'setup', customer, metadata: { business_id: business.id, customer_id: customerId },
    successUrl: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}msg=${encodeURIComponent('Card saved. Thank you!')}`, cancelUrl: returnUrl,
  });
}

/**
 * Charge the saved card for an invoice. The idempotency key is tied to the attempt
 * number, so a retried job can never charge twice for the same attempt.
 */
export async function chargeInvoice(tx: Tx, business: Business, invoiceId: string) {
  const inv = (await tx.query<Invoice>(`select * from invoices where id = $1 for update`, [invoiceId])).rows[0];
  if (!inv) throw err(404, 'invoice not found');
  if (inv.status !== 'open' && inv.status !== 'failed') return { status: inv.status };
  const c = (await tx.query<{ default_payment_method: string | null }>(`select default_payment_method from customers where id = $1`, [inv.customer_id])).rows[0];
  if (!c?.default_payment_method) throw err(409, 'No card on file for this customer.');
  const customer = await stripeCustomer(tx, business, inv.customer_id);
  const attempt = inv.attempts + 1;
  const r = await payments().chargeSaved({
    customer, paymentMethod: c.default_payment_method, amountCents: inv.amount_cents, description: `${business.name}: ${inv.description}`,
    metadata: { business_id: business.id, invoice_id: inv.id, customer_id: inv.customer_id }, idempotencyKey: `inv:${inv.id}:${attempt}`,
  });
  await tx.query(`update invoices set attempts = $2, payment_intent_id = $3 where id = $1`, [inv.id, attempt, r.providerId]);
  if (r.status === 'succeeded') await markPaid(tx, business.id, inv.id, { providerId: r.providerId, amountCents: inv.amount_cents });
  else await markFailed(tx, business.id, inv.id, { providerId: r.providerId, reason: r.failureReason ?? r.status });
  return { status: r.status };
}

/** Record a successful payment. Safe to call twice for the same payment (webhooks repeat). */
export async function markPaid(tx: Tx, businessId: string, invoiceId: string, p: { providerId: string | null; amountCents: number; method?: 'card' | 'cash' | 'check' | 'other' }) {
  const inv = (await tx.query<Invoice>(`update invoices set status = 'paid', paid_at = now(), failure_reason = null, payment_intent_id = coalesce($2, payment_intent_id)
    where id = $1 and status in ('open','failed') returning *`, [invoiceId, p.providerId])).rows[0];
  if (!inv) return false;
  const pay = await tx.query<{ id: string }>(
    `insert into payments (business_id, customer_id, booking_id, invoice_id, amount_cents, status, provider, provider_id, kind, method)
     values ($1, $2, $3, $4, $5, 'succeeded', $6, $7, 'charge', $8) on conflict do nothing returning id`,
    [businessId, inv.customer_id, inv.booking_id, inv.id, p.amountCents, p.method && p.method !== 'card' ? 'offline' : 'stripe', p.providerId, p.method ?? 'card']);
  await emit(tx, businessId, 'payment.succeeded', { type: 'payment', id: pay.rows[0]?.id ?? inv.id }, { customer_id: inv.customer_id, invoice_id: inv.id, amount_cents: p.amountCents });
  await emit(tx, businessId, 'invoice.paid', { type: 'invoice', id: inv.id }, { customer_id: inv.customer_id, amount_cents: p.amountCents, method: p.method ?? 'card' });
  return true;
}

export async function markFailed(tx: Tx, businessId: string, invoiceId: string, p: { providerId: string | null; reason: string }) {
  const inv = (await tx.query<Invoice>(`update invoices set status = 'failed', failure_reason = $2 where id = $1 and status in ('open','failed') returning *`, [invoiceId, p.reason])).rows[0];
  if (!inv) return false;
  const pay = await tx.query<{ id: string }>(
    `insert into payments (business_id, customer_id, booking_id, invoice_id, amount_cents, status, provider, provider_id, failure_reason, kind)
     values ($1, $2, $3, $4, $5, 'failed', 'stripe', $6, $7, 'charge') on conflict do nothing returning id`,
    [businessId, inv.customer_id, inv.booking_id, inv.id, inv.amount_cents, p.providerId, p.reason]);
  if (!pay.rowCount) return false; // this exact failure was already recorded
  await emit(tx, businessId, 'payment.failed', { type: 'payment', id: pay.rows[0].id }, { customer_id: inv.customer_id, invoice_id: inv.id, reason: p.reason });
  return true;
}

export async function saveCard(tx: Tx, businessId: string, customerId: string, setupIntentId: string) {
  const card = await payments().cardFromSetup(setupIntentId);
  await tx.query(`update customers set default_payment_method = $2, card_brand = $3, card_last4 = $4 where id = $1`, [customerId, card.paymentMethod, card.brand, card.last4]);
  await emit(tx, businessId, 'card.saved', { type: 'customer', id: customerId }, { customer_id: customerId, brand: card.brand, last4: card.last4 });
  return card;
}

export async function refundInvoice(tx: Tx, business: Business, invoiceId: string, amountCents?: number) {
  const inv = (await tx.query<Invoice>(`select * from invoices where id = $1 for update`, [invoiceId])).rows[0];
  if (!inv) throw err(404, 'invoice not found');
  if (inv.status !== 'paid' && !(inv.status === 'refunded' && inv.refunded_cents < inv.amount_cents)) throw err(409, 'Only paid invoices can be refunded.');
  const remaining = inv.amount_cents - inv.refunded_cents;
  const amount = amountCents ?? remaining;
  if (amount <= 0 || amount > remaining) throw err(400, `You can refund up to ${dollars(remaining)}.`);
  const card = (await tx.query(`select 1 from payments where invoice_id = $1 and kind = 'charge' and status = 'succeeded' and method = 'card'`, [inv.id])).rowCount;
  let providerId: string | null = null;
  if (card) {
    if (!inv.payment_intent_id) throw err(409, 'This payment has no card charge to refund.');
    providerId = (await payments().refund({ paymentIntent: inv.payment_intent_id, amountCents: amount, idempotencyKey: `refund:${inv.id}:${inv.refunded_cents + amount}` })).providerId;
  }
  const full = inv.refunded_cents + amount >= inv.amount_cents;
  await tx.query(`update invoices set refunded_cents = refunded_cents + $2, status = case when $3 then 'refunded' else status end where id = $1`, [inv.id, amount, full]);
  await tx.query(
    `insert into payments (business_id, customer_id, booking_id, invoice_id, amount_cents, status, provider, provider_id, kind, method)
     values ($1, $2, $3, $4, $5, 'refunded', $6, $7, 'refund', $8)`,
    [business.id, inv.customer_id, inv.booking_id, inv.id, amount, card ? 'stripe' : 'offline', providerId, card ? 'card' : 'other']);
  await emit(tx, business.id, 'payment.refunded', { type: 'invoice', id: inv.id }, { customer_id: inv.customer_id, amount_cents: amount });
  return { refunded_cents: amount, full };
}

export async function voidInvoice(tx: Tx, businessId: string, invoiceId: string) {
  const r = await tx.query<{ customer_id: string }>(`update invoices set status = 'void' where id = $1 and status in ('open','failed') returning customer_id`, [invoiceId]);
  if (!r.rowCount) throw err(409, 'Only unpaid invoices can be voided.');
  await emit(tx, businessId, 'invoice.voided', { type: 'invoice', id: invoiceId }, { customer_id: r.rows[0].customer_id });
}

export const paymentsLive = () => config().PAYMENTS_PROVIDER === 'stripe';
