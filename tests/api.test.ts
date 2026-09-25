import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/api/app.js';
import { closePool } from '../src/db/pool.js';
import { resetConfigForTests } from '../src/config.js';
import { twilioSignature } from '../src/adapters/messaging/twilio.js';
import { verifyStripeSignature } from '../src/adapters/payments/stripe.js';
import { freshOutbox, settle } from './helpers.js';

let server: Server;
let base: string;
const ADMIN = { authorization: 'Bearer test-admin-token-123456', 'content-type': 'application/json' };

before(async () => {
  server = createApp();
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await closePool(); });

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const isForm = typeof body === 'string';
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
}

async function setupBusiness(extra: Record<string, unknown> = {}) {
  const phone = `+1555020${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const r = await call('POST', '/admin/businesses', { name: 'API Co', phone_number: phone, review_url: 'https://g.page/r/api', ...extra }, ADMIN);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.business.id as string, key: r.body.api_key as string, phone, auth: { authorization: `Bearer ${r.body.api_key}` } };
}

test('health and pack listing', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
  const packs = await call('GET', '/v1/packs');
  assert.equal(packs.body[0].id, 'general-service');
});

test('admin token is required to create a business; bad packs are rejected with a clear message', async () => {
  assert.equal((await call('POST', '/admin/businesses', { name: 'x' })).status, 401);
  const bad = await call('POST', '/admin/businesses', { name: 'x', pack_overrides: { playbooks: { review_request: { delay_hours: -1 } } } }, ADMIN);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /delay_hours/);
});

test('owner API requires a valid key and only sees its own data', async () => {
  const a = await setupBusiness();
  const b = await setupBusiness();
  assert.equal((await call('GET', '/v1/business')).status, 401);
  assert.equal((await call('GET', '/v1/business', undefined, { authorization: 'Bearer nope' })).status, 401);
  const me = await call('GET', '/v1/business', undefined, a.auth);
  assert.equal(me.body.id, a.id);
  const cust = await call('POST', '/v1/customers', { first_name: 'Ada', phone: '5125550201' }, a.auth);
  assert.equal(cust.status, 201);
  // B tries to book A's customer: refused.
  const cross = await call('POST', '/v1/bookings', { customer_id: cust.body.customer.id, service_key: 'standard', starts_at: new Date().toISOString() }, b.auth);
  assert.equal(cross.status, 404);
  const list = await call('GET', '/v1/customers', undefined, b.auth);
  assert.equal(list.body.length, 0);
});

test('website lead form: JSON and form posts, honeypot, validation', async () => {
  await freshOutbox();
  const a = await setupBusiness();
  const ok = await call('POST', `/public/${a.id}/leads`, 'first_name=Lee&phone=512-555-0202&sms_consent=on&utm_source=google');
  assert.equal(ok.status, 201);
  const bot = await call('POST', `/public/${a.id}/leads`, { first_name: 'Bot', phone: '5125550203', website: 'spam.example' });
  assert.equal(bot.status, 202);
  const empty = await call('POST', `/public/${a.id}/leads`, { first_name: 'Nobody' });
  assert.equal(empty.status, 400);
  assert.equal((await call('POST', `/public/00000000-0000-0000-0000-000000000000/leads`, { phone: '5125550204' })).status, 404);
  const customers = await call('GET', '/v1/customers', undefined, a.auth);
  assert.equal(customers.body.length, 1);
  assert.equal(customers.body[0].source, 'utm:google');
});

test('quotes and bookings through the API', async () => {
  const a = await setupBusiness();
  const q = await call('POST', '/v1/quotes', { service_key: 'hourly', inputs: { minutes: 95 } }, a.auth);
  assert.equal(q.body.amount_cents, 7500 * 105 / 60);
  const cust = await call('POST', '/v1/customers', { first_name: 'Bo', phone: '5125550205' }, a.auth);
  const bk = await call('POST', '/v1/bookings', { customer_id: cust.body.customer.id, service_key: 'standard', starts_at: new Date().toISOString(), recurrence_key: 'every_2_weeks' }, a.auth);
  assert.equal(bk.status, 201);
  assert.equal(bk.body.price_cents, 15000);
  const done = await call('POST', `/v1/bookings/${bk.body.id}/complete`, {}, a.auth);
  assert.equal(done.status, 200);
  assert.equal((await call('POST', `/v1/bookings/${bk.body.id}/complete`, {}, a.auth)).status, 409);
  const card = await call('GET', '/v1/scorecard', undefined, a.auth);
  assert.equal(card.body.current.jobs_completed, 1);
  assert.equal(card.body.key_metric.key, 'repeat_rate');
});

test('drafts can be approved with edits through the API', async () => {
  const outbox = await freshOutbox();
  const a = await setupBusiness({ pack_overrides: { playbooks: { missed_call_textback: { trust: 'draft' } } } });
  process.env.MESSAGING_PROVIDER = 'dev';
  const r = await call('POST', '/webhooks/twilio/voice/dial-result', `From=%2B15125550206&To=${encodeURIComponent(a.phone)}&DialCallStatus=no-answer&CallSid=CA1`);
  assert.equal(r.status, 200);
  await settle(new Date(Date.now() + 1000));
  const drafts = await call('GET', '/v1/drafts', undefined, a.auth);
  assert.equal(drafts.body.length, 1);
  const ap = await call('POST', `/v1/drafts/${drafts.body[0].id}/approve`, { body: 'Hi! Sorry I missed you. Call back anytime.' }, a.auth);
  assert.equal(ap.status, 200);
  await settle(new Date(Date.now() + 2000));
  assert.equal(outbox.at(-1)?.body, 'Hi! Sorry I missed you. Call back anytime.');
  assert.equal((await call('POST', `/v1/drafts/${drafts.body[0].id}/approve`, {}, a.auth)).status, 409);
});

test('Twilio webhooks are rejected without a valid signature when Twilio is live', async () => {
  const a = await setupBusiness();
  Object.assign(process.env, { MESSAGING_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC_test', TWILIO_AUTH_TOKEN: 'secret_token' });
  resetConfigForTests();
  try {
    const params = { From: '+15125550207', To: a.phone, Body: 'hello', MessageSid: 'SM1' };
    const form = new URLSearchParams(params).toString();
    const bad = await call('POST', '/webhooks/twilio/sms', form, { 'x-twilio-signature': 'forged' });
    assert.equal(bad.status, 403);
    const sig = twilioSignature('secret_token', 'https://app.example.test/webhooks/twilio/sms', params);
    const good = await call('POST', '/webhooks/twilio/sms', form, { 'x-twilio-signature': sig });
    assert.equal(good.status, 200);
    assert.match(String(good.body), /<Response>/);
  } finally {
    Object.assign(process.env, { MESSAGING_PROVIDER: 'dev' });
    resetConfigForTests();
  }
});

test('Twilio signature matches the documented algorithm', () => {
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  const url = 'https://example.com/myapp.php?foo=1&bar=2';
  const data = url + 'CallSidCA1234567890ABCDECaller+12349013030Digits1234From+12349013030To+18005551212';
  assert.equal(twilioSignature('12345', url, params), createHmac('sha1', '12345').update(data).digest('base64'));
});

test('Stripe signatures: valid, tampered and stale', () => {
  const secret = 'whsec_test';
  const body = '{"type":"checkout.session.completed"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret), true);
  assert.equal(verifyStripeSignature(body + ' ', `t=${t},v1=${sig}`, secret), false);
  assert.equal(verifyStripeSignature(body, `t=${t - 3600},v1=${createHmac('sha256', secret).update(`${t - 3600}.${body}`).digest('hex')}`, secret), false);
});

test('incoming calls ring the owner when a forwarding number is set', async () => {
  const a = await setupBusiness({ settings: { forward_to: '+15125559999' } });
  const r = await call('POST', '/webhooks/twilio/voice/incoming', `From=%2B15125550208&To=${encodeURIComponent(a.phone)}&CallSid=CA2`);
  assert.match(String(r.body), /<Dial timeout="20" action="https:\/\/app\.example\.test\/webhooks\/twilio\/voice\/dial-result">\+15125559999<\/Dial>/);
  const answered = await call('POST', '/webhooks/twilio/voice/dial-result', `From=%2B15125550208&To=${encodeURIComponent(a.phone)}&DialCallStatus=completed&CallSid=CA2`);
  assert.doesNotMatch(String(answered.body), /Say/);
});

test('Caddy domain check only approves domains that belong to a business', async () => {
  await setupBusiness({ custom_domain: 'Book.Example-Pros.com' });
  assert.equal((await call('GET', '/internal/domain-check?domain=book.example-pros.com')).status, 200);
  assert.equal((await call('GET', '/internal/domain-check?domain=evil.example.com')).status, 404);
});
