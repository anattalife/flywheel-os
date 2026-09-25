import { config } from '../../config.js';
import { withSystem, withTenant } from '../../db/pool.js';
import { markFailed, markPaid, saveCard } from '../../core/billing.js';
import { HttpError } from '../../lib/http.js';
import { verifyStripeSignature } from '../../adapters/payments/stripe.js';
import { loadBusiness } from '../../core/business.js';
import { receiveSms, recordMissedCall } from '../../core/inbound.js';
import { emit } from '../../core/events.js';
import { setOptOut } from '../../core/customers.js';
import { verifyTwilioSignature } from '../../adapters/messaging/twilio.js';
import { router, twilio, twiml, xmlEscape } from '../context.js';

const MISSED = new Set(['no-answer', 'busy', 'failed', 'canceled']);

router.add('POST', '/webhooks/twilio/sms', twilio(async (req, businessId) => {
  await withTenant(businessId, (tx) => receiveSms(tx, businessId, String(req.body.From), String(req.body.Body ?? ''), req.body.MessageSid));
  return twiml();
}));

/**
 * Incoming call to the business number: ring the owner's phone (settings.forward_to).
 * Twilio reports how the dial ended to /dial-result.
 */
router.add('POST', '/webhooks/twilio/voice/incoming', twilio(async (req, businessId) => {
  const forwardTo = await withTenant(businessId, async (tx) => (await loadBusiness(tx)).settings?.forward_to as string | undefined);
  if (!forwardTo) {
    await withTenant(businessId, (tx) => recordMissedCall(tx, businessId, String(req.body.From), req.body.CallSid));
    return twiml(`<Say>Sorry we can't take your call right now. We'll text you shortly.</Say><Hangup/>`);
  }
  const action = `${config().PUBLIC_BASE_URL}/webhooks/twilio/voice/dial-result`;
  return twiml(`<Dial timeout="20" action="${action}">${xmlEscape(forwardTo)}</Dial>`);
}));

/** How the forwarded call ended. Unanswered, busy or failed becomes a missed call → text-back playbook. */
router.add('POST', '/webhooks/twilio/voice/dial-result', twilio(async (req, businessId) => {
  if (MISSED.has(String(req.body.DialCallStatus))) {
    await withTenant(businessId, (tx) => recordMissedCall(tx, businessId, String(req.body.From), req.body.CallSid));
    return twiml(`<Say>Sorry we missed you. We'll text you right away.</Say><Hangup/>`);
  }
  return twiml();
}));

/**
 * Delivery results for texts we sent. Failures show in the conversation; Twilio
 * error 21610 means the person has blocked texts from us, so we stop too.
 */
router.add('POST', '/webhooks/twilio/status', async (req) => {
  const c = config();
  if (c.MESSAGING_PROVIDER !== 'twilio' && c.NODE_ENV === 'production') throw new HttpError(403, 'texting is not configured');
  if (c.MESSAGING_PROVIDER === 'twilio') {
    const url = `${c.PUBLIC_BASE_URL}${req.path}`;
    if (!verifyTwilioSignature(c.TWILIO_AUTH_TOKEN!, url, req.body, req.headers['x-twilio-signature'] as string | undefined)) throw new HttpError(403, 'invalid Twilio signature');
  }
  const sid = String(req.body.MessageSid ?? '');
  const status = String(req.body.MessageStatus ?? '');
  if (!sid || !['delivered', 'undelivered', 'failed'].includes(status)) return twiml();
  const businessId = await withSystem(async (tx) => (await tx.query<{ b: string | null }>(`select message_business_by_provider($1) as b`, [sid])).rows[0].b);
  if (!businessId) return twiml();
  await withTenant(businessId, async (tx) => {
    const m = (await tx.query<{ id: string; customer_id: string }>(
      `update messages set status = $2, error_code = $3, delivered_at = case when $2 = 'delivered' then now() else delivered_at end
       where provider_id = $1 and status in ('sent','delivered') returning id, customer_id`,
      [sid, status === 'delivered' ? 'delivered' : 'failed', req.body.ErrorCode ?? null])).rows[0];
    if (!m || status === 'delivered') return;
    if (String(req.body.ErrorCode) === '21610') await setOptOut(tx, businessId, m.customer_id, true);
    await emit(tx, businessId, 'message.failed', { type: 'message', id: m.id }, { customer_id: m.customer_id, error_code: req.body.ErrorCode ?? null });
  });
  return twiml();
});

interface StripeObject {
  id: string; object: string; mode?: string; amount_total?: number; amount_received?: number; amount?: number;
  payment_intent?: string; setup_intent?: string; customer?: string; payment_method?: string;
  metadata?: Record<string, string>; last_payment_error?: { message?: string; decline_code?: string };
}

/**
 * Stripe events, verified and handled once each (Stripe may deliver more than once).
 * Paid checkouts and succeeded intents mark invoices paid; setup checkouts save the card.
 */
router.add('POST', '/webhooks/stripe', async (req) => {
  const secret = config().STRIPE_WEBHOOK_SECRET;
  if (!secret || !verifyStripeSignature(req.rawBody, req.headers['stripe-signature'] as string | undefined, secret)) {
    throw new HttpError(400, 'invalid Stripe signature');
  }
  const event = JSON.parse(req.rawBody) as { id: string; type: string; data: { object: StripeObject } };
  const handled = [ 'checkout.session.completed', 'payment_intent.succeeded', 'payment_intent.payment_failed' ];
  if (!handled.includes(event.type)) return { json: { received: true } };
  const obj = event.data.object;
  const businessId = obj.metadata?.business_id;
  if (!businessId || !/^[0-9a-f-]{36}$/.test(businessId)) return { json: { received: true } };
  const fresh = await withSystem(async (tx) => (await tx.query(`insert into stripe_events (id, type) values ($1, $2) on conflict do nothing`, [event.id, event.type])).rowCount);
  if (!fresh) return { json: { received: true, duplicate: true } };
  try {
    await withTenant(businessId, async (tx) => {
      const invoiceId = obj.metadata?.invoice_id;
      const customerId = obj.metadata?.customer_id;
      if (event.type === 'checkout.session.completed' && obj.mode === 'setup' && obj.setup_intent && customerId) {
        await saveCard(tx, businessId, customerId, obj.setup_intent);
      } else if (event.type === 'checkout.session.completed' && obj.mode === 'payment' && invoiceId) {
        await markPaid(tx, businessId, invoiceId, { providerId: obj.payment_intent ?? null, amountCents: obj.amount_total ?? 0 });
      } else if (event.type === 'payment_intent.succeeded' && invoiceId) {
        await markPaid(tx, businessId, invoiceId, { providerId: obj.id, amountCents: obj.amount_received ?? obj.amount ?? 0 });
        if (customerId && obj.payment_method) {
          // Card kept from a pay link becomes the card on file if there isn't one yet.
          await tx.query(`update customers set default_payment_method = coalesce(default_payment_method, $2) where id = $1`, [customerId, obj.payment_method]);
        }
      } else if (event.type === 'payment_intent.payment_failed' && invoiceId) {
        await markFailed(tx, businessId, invoiceId, { providerId: obj.id, reason: obj.last_payment_error?.decline_code ?? obj.last_payment_error?.message ?? 'failed' });
      }
    });
  } catch (e) {
    // Let Stripe retry: forget that we saw this event.
    await withSystem((tx) => tx.query(`delete from stripe_events where id = $1`, [event.id]));
    throw e;
  }
  return { json: { received: true } };
});
