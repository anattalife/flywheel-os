import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { StripeAdapter } from './stripe.js';
import type { ChargeResult, CheckoutRequest, PaymentsAdapter } from './types.js';

/** Development stand-in: no money moves. A payment method named 'pm_fail' declines. */
export class DevPayments implements PaymentsAdapter {
  readonly name = 'dev';
  readonly checkouts: CheckoutRequest[] = [];
  readonly charges: { customer: string; paymentMethod: string; amountCents: number }[] = [];
  readonly refunds: { paymentIntent: string; amountCents?: number }[] = [];
  async ensureCustomer(c: { existing?: string | null }) { return c.existing ?? `cus_dev_${randomUUID().slice(0, 8)}`; }
  async createCheckout(req: CheckoutRequest) {
    this.checkouts.push(req);
    const id = `cs_dev_${randomUUID()}`;
    return { url: `${config().PUBLIC_BASE_URL}/dev/checkout/${id}`, providerId: id };
  }
  async chargeSaved(req: { customer: string; paymentMethod: string; amountCents: number }): Promise<ChargeResult> {
    this.charges.push(req);
    return req.paymentMethod === 'pm_fail'
      ? { status: 'failed', providerId: `pi_dev_${randomUUID()}`, failureReason: 'card_declined' }
      : { status: 'succeeded', providerId: `pi_dev_${randomUUID()}` };
  }
  async cardFromSetup() { return { paymentMethod: `pm_dev_${randomUUID().slice(0, 8)}`, brand: 'visa', last4: '4242' }; }
  async refund(req: { paymentIntent: string; amountCents?: number }) { this.refunds.push(req); return { providerId: `re_dev_${randomUUID()}`, status: 'succeeded' }; }
}

let adapter: PaymentsAdapter | undefined;
export function payments(): PaymentsAdapter {
  if (!adapter) {
    const c = config();
    if (c.PAYMENTS_PROVIDER === 'stripe') {
      if (!c.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required');
      adapter = new StripeAdapter(c.STRIPE_SECRET_KEY);
    } else adapter = new DevPayments();
  }
  return adapter;
}
export function setPaymentsAdapter(a: PaymentsAdapter) { adapter = a; }
