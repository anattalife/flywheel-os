import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/secrets.js';
import type { ChargeResult, CheckoutRequest, PaymentsAdapter } from './types.js';

type Params = Record<string, string | number | boolean | undefined | null>;

export class StripeAdapter implements PaymentsAdapter {
  readonly name = 'stripe';
  /** `account` is set when charging on behalf of a connected account (Stripe Connect). */
  constructor(private secretKey: string, private account?: string) {}

  private async call<T>(method: 'GET' | 'POST', path: string, params: Params = {}, idempotencyKey?: string): Promise<T> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.set(k, String(v));
    const url = `https://api.stripe.com/v1${path}${method === 'GET' && [...form].length ? `?${form}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...(this.account ? { 'Stripe-Account': this.account } : {}),
      },
      body: method === 'POST' ? form : undefined,
    });
    const body = (await res.json()) as T & { error?: { message: string; code?: string; decline_code?: string; payment_intent?: { id: string } } };
    if (!res.ok) throw Object.assign(new Error(`stripe ${res.status}: ${body.error?.message ?? 'request failed'}`), { stripe: body.error });
    return body;
  }

  async ensureCustomer(c: { existing?: string | null; name?: string | null; email?: string | null; phone?: string | null; metadata: Record<string, string> }) {
    if (c.existing) return c.existing;
    const params: Params = { name: c.name ?? undefined, email: c.email ?? undefined, phone: c.phone ?? undefined };
    for (const [k, v] of Object.entries(c.metadata)) params[`metadata[${k}]`] = v;
    return (await this.call<{ id: string }>('POST', '/customers', params, `cust:${c.metadata.customer_id}`)).id;
  }

  async createCheckout(req: CheckoutRequest) {
    const params: Params = { mode: req.mode, customer: req.customer, success_url: req.successUrl, cancel_url: req.cancelUrl };
    for (const [k, v] of Object.entries(req.metadata)) params[`metadata[${k}]`] = v;
    if (req.mode === 'payment') {
      Object.assign(params, {
        'line_items[0][quantity]': 1,
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': req.amountCents,
        'line_items[0][price_data][product_data][name]': req.description ?? 'Service',
        // Keep the card for next time, so later visits can be charged without a link.
        'payment_intent_data[setup_future_usage]': 'off_session',
      });
      for (const [k, v] of Object.entries(req.metadata)) params[`payment_intent_data[metadata][${k}]`] = v;
    } else {
      params['currency'] = 'usd';
      for (const [k, v] of Object.entries(req.metadata)) params[`setup_intent_data[metadata][${k}]`] = v;
    }
    const s = await this.call<{ id: string; url: string }>('POST', '/checkout/sessions', params, req.idempotencyKey);
    return { url: s.url, providerId: s.id };
  }

  async chargeSaved(req: { customer: string; paymentMethod: string; amountCents: number; description: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<ChargeResult> {
    const params: Params = {
      amount: req.amountCents, currency: 'usd', customer: req.customer, payment_method: req.paymentMethod,
      off_session: true, confirm: true, description: req.description,
    };
    for (const [k, v] of Object.entries(req.metadata)) params[`metadata[${k}]`] = v;
    try {
      const pi = await this.call<{ id: string; status: string }>('POST', '/payment_intents', params, req.idempotencyKey);
      return { status: pi.status === 'succeeded' ? 'succeeded' : pi.status === 'requires_action' ? 'requires_action' : 'failed', providerId: pi.id };
    } catch (e) {
      const se = (e as { stripe?: { message: string; decline_code?: string; payment_intent?: { id: string } } }).stripe;
      if (!se) throw e;
      return { status: 'failed', providerId: se.payment_intent?.id ?? `failed_${req.idempotencyKey}`, failureReason: se.decline_code ?? se.message };
    }
  }

  async cardFromSetup(setupIntentId: string) {
    const si = await this.call<{ payment_method: { id: string; card?: { brand: string; last4: string } } }>('GET', `/setup_intents/${setupIntentId}`, { 'expand[]': 'payment_method' });
    return { paymentMethod: si.payment_method.id, brand: si.payment_method.card?.brand ?? null, last4: si.payment_method.card?.last4 ?? null };
  }

  async refund(req: { paymentIntent: string; amountCents?: number; idempotencyKey: string }) {
    const r = await this.call<{ id: string; status: string }>('POST', '/refunds', { payment_intent: req.paymentIntent, amount: req.amountCents }, req.idempotencyKey);
    return { providerId: r.id, status: r.status };
  }
}

/**
 * Verify a Stripe-Signature header ("t=...,v1=...") against the raw request body.
 * Rejects signatures older than `toleranceSec` to stop replays.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, now = Date.now(), toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  const v1s = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || v1s.length === 0) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return v1s.some((v) => safeEqual(v, expected));
}
