import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, withSystem } from '../src/db/pool.js';
import { resetConfigForTests } from '../src/config.js';
import { aiFor } from '../src/adapters/ai/index.js';
import { alertOperator, heartbeat, systemHealth } from '../src/core/ops.js';
import { freshOutbox, tenant } from './helpers.js';
import { ADMIN, startServer, uniquePhone } from './support.js';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  process.env.MONITOR_TOKEN = 'monitor-token-abcdefgh';
  resetConfigForTests();
  srv = await startServer();
});
after(async () => {
  delete process.env.MONITOR_TOKEN; delete process.env.ALERT_PHONE;
  resetConfigForTests();
  await srv.close(); await closePool();
});

async function setup() {
  const r = await srv.call('POST', '/admin/businesses', {
    name: 'Ops Co', phone_number: uniquePhone(),
    owner: { email: `o${Date.now()}${Math.random()}@x.com`, password: 'long enough password', phone: '+15125550999' },
  }, ADMIN);
  return { id: r.body.business.id as string, A: { authorization: `Bearer ${r.body.api_key}` } };
}

test('deep health: hidden without the token, reports worker and queue state with it', async () => {
  assert.equal((await srv.call('GET', '/health/deep')).status, 404);
  assert.equal((await srv.call('GET', '/health/deep?token=wrong-token-xxxxxxxx')).status, 404);
  await withSystem((tx) => tx.query(`delete from heartbeats`));
  const down = await srv.call('GET', '/health/deep?token=monitor-token-abcdefgh');
  assert.equal(down.status, 503);
  assert.match(down.body.problems.join(' '), /worker has never checked in/);
  await freshOutbox(); // clears any due jobs left by earlier tests
  await heartbeat('worker', { pid: 1 });
  const up = await srv.call('GET', '/health/deep?token=monitor-token-abcdefgh');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.ok, true);
  assert.ok((await systemHealth()).worker_seconds_ago! < 5);
});

test('operator alerts are rate limited per kind', async () => {
  const outbox = await freshOutbox();
  assert.equal(await alertOperator('test_kind_a', 'nobody to tell'), false, 'no alert contact configured');
  process.env.ALERT_PHONE = '+15125550100'; resetConfigForTests();
  assert.equal(await alertOperator('test_kind_a', 'first'), true);
  assert.equal(await alertOperator('test_kind_a', 'second'), false, 'same kind within the window is held back');
  assert.equal(await alertOperator('test_kind_b', 'other kind'), true);
  assert.deepEqual(outbox.filter((m) => m.to === '+15125550100').map((m) => m.body), ['Flywheel alert (test_kind_a): first', 'Flywheel alert (test_kind_b): other kind']);
  await withSystem((tx) => tx.query(`update alerts_sent set sent_at = now() - interval '2 hours' where kind = 'test_kind_a'`));
  assert.equal(await alertOperator('test_kind_a', 'later'), true, 'sends again once the window has passed');
  delete process.env.ALERT_PHONE; resetConfigForTests();
});

test('export: everything as JSON with no secrets, and customers as CSV', async () => {
  const s = await setup();
  await srv.call('PATCH', '/v1/business/ai-key', { api_key: 'sk-ant-secret-key-9876' }, s.A);
  await srv.call('POST', '/v1/customers', { first_name: 'Ann, "The" Tester', phone: '5125550321', email: 'ann@example.com' }, s.A);
  const r = await srv.call('GET', '/v1/export', undefined, s.A);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="flywheel-export-/);
  const text = JSON.stringify(r.body);
  assert.equal(r.body.format, 'flywheel-export-v1');
  assert.equal(r.body.customers.length, 1);
  assert.ok(Array.isArray(r.body.bookings) && Array.isArray(r.body.messages));
  assert.equal(r.body.business.settings.ai_key_last4, '9876');
  assert.doesNotMatch(text, /ai_key_sealed|password_hash|api_key_hash|secret-key/);
  const csv = await srv.call('GET', '/v1/export/customers.csv', undefined, s.A);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  const lines = String(csv.body).trim().split('\n');
  assert.equal(lines[0].split(',')[0], 'first_name');
  assert.match(lines[1], /^"Ann, ""The"" Tester",,\+15125550321,ann@example.com,/);
  // Another business sees only its own data.
  const other = await setup();
  assert.equal((await srv.call('GET', '/v1/export', undefined, other.A)).body.customers.length, 0);
});

test('erase a customer: identity gone, money records kept', async () => {
  const s = await setup();
  const c = await srv.call('POST', '/v1/customers', { first_name: 'Forget', last_name: 'Me', phone: '5125550444', email: 'f@example.com', sms_consent: true, consent_source: 'verbal' }, s.A);
  const id = c.body.customer.id;
  await tenant(s.id, (tx) => tx.query(`insert into messages (business_id, customer_id, channel, direction, body, status) values ($1, $2, 'sms', 'in', 'my address is 1 Main St', 'received')`, [s.id, id]));
  await tenant(s.id, (tx) => tx.query(`insert into bookings (business_id, customer_id, starts_at, ends_at, status, price_cents) values ($1, $2, now() - interval '3 days', now() - interval '3 days' + interval '1 hour', 'completed', 12000)`, [s.id, id]));
  assert.equal((await srv.call('POST', '/v1/customers/not-a-uuid/erase', {}, s.A)).status, 404);
  const other = await setup();
  assert.equal((await srv.call('POST', `/v1/customers/${id}/erase`, {}, other.A)).status, 404, 'cannot erase another business\'s customer');
  const r = await srv.call('POST', `/v1/customers/${id}/erase`, {}, s.A);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (await tenant(s.id, (tx) => tx.query(`select first_name, last_name, phone, email, sms_opted_out from customers where id = $1`, [id]))).rows[0];
  assert.deepEqual(row, { first_name: 'Deleted', last_name: null, phone: null, email: null, sms_opted_out: true });
  const msgs = (await tenant(s.id, (tx) => tx.query(`select body from messages where customer_id = $1`, [id]))).rows;
  assert.ok(msgs.length && msgs.every((m) => m.body === '[removed]'));
  const money = (await tenant(s.id, (tx) => tx.query(`select price_cents from bookings where customer_id = $1`, [id]))).rows;
  assert.deepEqual(money, [{ price_cents: 12000 }]);
  const ev = (await tenant(s.id, (tx) => tx.query(`select 1 from events where type = 'customer.erased'`))).rowCount;
  assert.equal(ev, 1);
});

test('own AI key: stored sealed, never returned, used by aiFor', async () => {
  const s = await setup();
  assert.equal(aiFor({ ai: { provider: 'anthropic' } }), null, 'no platform key in tests, so AI is off');
  const r = await srv.call('PATCH', '/v1/business/ai-key', { api_key: 'sk-ant-my-own-key-1234' }, s.A);
  assert.deepEqual(r.body, { ok: true, last4: '1234' });
  const stored = (await tenant(s.id, (tx) => tx.query(`select settings from businesses`))).rows[0].settings;
  assert.ok(stored.ai_key_sealed && !String(stored.ai_key_sealed).includes('my-own-key'));
  const biz = await srv.call('GET', '/v1/business', undefined, s.A);
  assert.equal(biz.body.settings.ai_key_sealed, undefined);
  assert.equal(biz.body.settings.ai_key_last4, '1234');
  const ai = aiFor({ ai: { provider: 'anthropic' }, ai_key_sealed: stored.ai_key_sealed });
  assert.ok(ai, 'the business key turns AI on');
  assert.equal(aiFor({ ai: { provider: 'anthropic' }, ai_key_sealed: 'tampered' }), null);
  await srv.call('PATCH', '/v1/business/ai-key', { api_key: null }, s.A);
  const after = (await tenant(s.id, (tx) => tx.query(`select settings from businesses`))).rows[0].settings;
  assert.equal(after.ai_key_sealed, undefined);
  assert.equal(after.ai_key_last4, undefined);
});

test('admin purge removes a business completely, only with confirmation', async () => {
  const s = await setup();
  await srv.call('POST', '/v1/customers', { first_name: 'Gone', phone: '5125550555' }, s.A);
  assert.equal((await srv.call('DELETE', `/admin/businesses/${s.id}`, undefined, s.A)).status, 401);
  assert.equal((await srv.call('DELETE', `/admin/businesses/${s.id}`, undefined, ADMIN)).status, 400);
  const r = await srv.call('DELETE', `/admin/businesses/${s.id}?confirm=${s.id}`, undefined, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const left = await withSystem((tx) => tx.query(`select (select count(*)::int from businesses where id = $1) as b, (select count(*)::int from customers where business_id = $1) as c, (select count(*)::int from events where business_id = $1) as e`, [s.id]));
  assert.deepEqual(left.rows[0], { b: 0, c: 0, e: 0 });
  assert.equal((await srv.call('GET', '/v1/business', undefined, s.A)).status, 401, 'old key no longer works');
});
