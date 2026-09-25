import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { closePool } from '../src/db/pool.js';
import { DevPayments, setPaymentsAdapter } from '../src/adapters/payments/index.js';
import { resetConfigForTests } from '../src/config.js';
import { sign } from '../src/lib/sign.js';
import { daytime, freshOutbox, settle, tenant } from './helpers.js';
import { ADMIN, startServer, uniquePhone } from './support.js';

let srv: Awaited<ReturnType<typeof startServer>>;
let pay: DevPayments;
before(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  resetConfigForTests();
  srv = await startServer();
});
after(async () => { await srv.close(); await closePool(); });

async function setup(overrides: Record<string, unknown> = {}) {
  pay = new DevPayments(); setPaymentsAdapter(pay);
  const outbox = await freshOutbox();
  const r = await srv.call('POST', '/admin/businesses', { name: 'Pay Co', phone_number: uniquePhone(), pack_overrides: { scheduling: { min_notice_hours: 0, buffer_min: 0 }, ...overrides } }, ADMIN);
  const A = { authorization: `Bearer ${r.body.api_key}` };
  const c = await srv.call('POST', '/v1/customers', { first_name: 'Val', phone: `51255${String(Math.random()).slice(2, 7)}`, sms_consent: true, consent_source: 'verbal' }, A);
  const bk = await srv.call('POST', '/v1/bookings', { customer_id: c.body.customer.id, service_key: 'standard', starts_at: new Date(Date.now() - 3 * 3600_000).toISOString() }, A);
  return { id: r.body.business.id as string, A, customerId: c.body.customer.id as string, bookingId: bk.body.id as string, outbox };
}

function stripeEvent(type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'whsec_test_secret').update(`${t}.${body}`).digest('hex');
  return { body, headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' } };
}
async function webhook(type: string, object: Record<string, unknown>) {
  const e = stripeEvent(type, object);
  const res = await fetch(srv.base + '/webhooks/stripe', { method: 'POST', headers: e.headers, body: e.body });
  return { status: res.status, body: await res.json(), replay: () => fetch(srv.base + '/webhooks/stripe', { method: 'POST', headers: e.headers, body: e.body }).then((r) => r.json()) };
}

test('completed job → invoice → pay link text → paid by webhook → receipt text; duplicates ignored', async () => {
  const s = await setup();
  await srv.call('POST', `/v1/bookings/${s.bookingId}/complete`, {}, s.A);
  await settle(daytime());
  const inv = (await srv.call('GET', '/v1/invoices', undefined, s.A)).body[0];
  assert.equal(inv.amount_cents, 15000);
  assert.equal(inv.status, 'open');
  const text = s.outbox.find((m) => /Your total today is \$150/.test(m.body));
  assert.ok(text, 'pay link texted');
  const link = text!.body.match(/(\/pay\/[\w-]+\?t=[\w-]+)/)![1];
  const go = await srv.call('GET', link);
  assert.equal(go.status, 303);
  assert.equal(pay.checkouts.at(-1)?.amountCents, 15000);
  assert.equal(pay.checkouts.at(-1)?.metadata.invoice_id, inv.id);
  assert.equal((await srv.call('GET', link.replace(/t=[\w-]+/, 't=forged'))).status, 404, 'unsigned links are refused');

  const paid = await webhook('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'payment', amount_total: 15000, payment_intent: 'pi_1', metadata: { business_id: s.id, invoice_id: inv.id, customer_id: s.customerId } });
  assert.equal(paid.status, 200);
  assert.equal((await paid.replay()).duplicate, true);
  const after = (await srv.call('GET', '/v1/invoices', undefined, s.A)).body[0];
  assert.equal(after.status, 'paid');
  await settle(daytime());
  assert.ok(s.outbox.some((m) => /Payment received: \$150/.test(m.body)));
  const receipt = await srv.call('GET', `/receipt/${inv.id}?t=${sign('receipt', inv.id)}`);
  assert.match(String(receipt.body), /Receipt #\d+/);
  const payments = await tenant(s.id, (tx) => tx.query(`select count(*)::int as n from payments where invoice_id = $1 and status = 'succeeded'`, [inv.id]));
  assert.equal(payments.rows[0].n, 1, 'one payment even with two webhook deliveries');
});

test('saved card + auto-charge: charged after the job, no link needed', async () => {
  const s = await setup({ playbooks: { payment_request: { auto_charge: true } } });
  await webhook('checkout.session.completed', { id: 'cs_s', object: 'checkout.session', mode: 'setup', setup_intent: 'seti_1', metadata: { business_id: s.id, customer_id: s.customerId } });
  const c = await srv.call('GET', `/v1/customers/${s.customerId}`, undefined, s.A);
  assert.equal(c.body.customer.card_last4, '4242');
  await srv.call('POST', `/v1/bookings/${s.bookingId}/complete`, {}, s.A);
  await settle(daytime());
  assert.equal(pay.charges.length, 1);
  assert.equal((await srv.call('GET', '/v1/invoices', undefined, s.A)).body[0].status, 'paid');
  assert.ok(!s.outbox.some((m) => /Pay securely/.test(m.body)), 'no pay link when the card was charged');
});

test('declined card: customer told once with an update link, retries on schedule, new card retries at once', async () => {
  const s = await setup({ playbooks: { payment_request: { auto_charge: true } } });
  await tenant(s.id, (tx) => tx.query(`update customers set default_payment_method = 'pm_fail', stripe_customer_id = 'cus_x' where id = $1`, [s.customerId]));
  await srv.call('POST', `/v1/bookings/${s.bookingId}/complete`, {}, s.A);
  await settle(daytime());
  const inv = (await srv.call('GET', '/v1/invoices', undefined, s.A)).body[0];
  assert.equal(inv.status, 'failed');
  const notices = s.outbox.filter((m) => /card was declined/.test(m.body));
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /\/m\/[\w-]+/);
  await settle(new Date(daytime().getTime() + 2.1 * 86400_000));
  assert.equal(pay.charges.length, 2, 'retried after 2 days');
  assert.equal(s.outbox.filter((m) => /card was declined/.test(m.body)).length, 1, 'not nagged again');
  // They add a new card: retried straight away and paid.
  await webhook('checkout.session.completed', { id: 'cs_s2', object: 'checkout.session', mode: 'setup', setup_intent: 'seti_2', metadata: { business_id: s.id, customer_id: s.customerId } });
  await settle(new Date(daytime().getTime() + 2.2 * 86400_000));
  assert.equal((await srv.call('GET', '/v1/invoices', undefined, s.A)).body[0].status, 'paid');
});

test('cash payments, partial and full refunds, voids', async () => {
  const s = await setup();
  const inv = await srv.call('POST', '/v1/invoices', { customer_id: s.customerId, amount_cents: 8000, description: 'Extra work' }, s.A);
  assert.equal(inv.status, 201);
  assert.equal((await srv.call('POST', `/v1/invoices/${inv.body.id}/mark-paid`, { method: 'cash' }, s.A)).status, 200);
  assert.equal((await srv.call('POST', `/v1/invoices/${inv.body.id}/mark-paid`, { method: 'cash' }, s.A)).status, 409);
  const part = await srv.call('POST', `/v1/invoices/${inv.body.id}/refund`, { amount_cents: 3000 }, s.A);
  assert.deepEqual(part.body, { refunded_cents: 3000, full: false });
  assert.equal((await srv.call('POST', `/v1/invoices/${inv.body.id}/refund`, { amount_cents: 6000 }, s.A)).status, 400, 'cannot refund more than remains');
  assert.deepEqual((await srv.call('POST', `/v1/invoices/${inv.body.id}/refund`, {}, s.A)).body, { refunded_cents: 5000, full: true });
  assert.equal(pay.refunds.length, 0, 'cash refunds do not touch Stripe');

  const card = await srv.call('POST', '/v1/invoices', { customer_id: s.customerId, amount_cents: 5000, description: 'Add-on' }, s.A);
  await webhook('payment_intent.succeeded', { id: 'pi_card', object: 'payment_intent', amount_received: 5000, payment_method: 'pm_1', metadata: { business_id: s.id, invoice_id: card.body.id, customer_id: s.customerId } });
  await srv.call('POST', `/v1/invoices/${card.body.id}/refund`, {}, s.A);
  assert.deepEqual(pay.refunds[0], { paymentIntent: 'pi_card', amountCents: 5000, idempotencyKey: `refund:${card.body.id}:5000` });

  const v = await srv.call('POST', '/v1/invoices', { customer_id: s.customerId, amount_cents: 1000, description: 'Mistake' }, s.A);
  assert.equal((await srv.call('POST', `/v1/invoices/${v.body.id}/void`, {}, s.A)).status, 200);
  const payVoid = await srv.call('GET', `/pay/${v.body.id}?t=${sign('pay', v.body.id)}`);
  assert.match(String(payVoid.body), /Nothing is owed/);
});

test('invoice numbers count up per business', async () => {
  const s = await setup();
  const a = await srv.call('POST', '/v1/invoices', { customer_id: s.customerId, amount_cents: 100, description: 'a' }, s.A);
  const b = await srv.call('POST', '/v1/invoices', { customer_id: s.customerId, amount_cents: 100, description: 'b' }, s.A);
  assert.equal(b.body.number, a.body.number + 1);
});
