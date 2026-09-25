import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db/pool.js';
import { resetConfigForTests } from '../src/config.js';
import { aiFor } from '../src/adapters/ai/index.js';
import { upsertCustomer } from '../src/core/customers.js';
import { isPrivateAddress } from '../src/lib/net.js';
import { freshOutbox, settle, tenant } from './helpers.js';
import { ADMIN, startServer, uniquePhone } from './support.js';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); await closePool(); });

async function setup() {
  const phone = `+1512${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const email = `s${Date.now()}${Math.random()}@x.com`;
  const r = await srv.call('POST', '/admin/businesses', { name: 'Safe Co', phone_number: uniquePhone(), owner: { email, password: 'long enough password', phone } }, ADMIN);
  return { id: r.body.business.id as string, A: { authorization: `Bearer ${r.body.api_key}` }, email, ownerPhone: phone };
}

test('AI address: must be public https, and never receives the platform key', async () => {
  const s = await setup();
  for (const base_url of ['http://example.com/v1', 'https://127.0.0.1/v1', 'https://169.254.169.254/latest', 'https://[::1]/v1', 'https://localhost/v1']) {
    const r = await srv.call('PATCH', '/v1/business/settings', { ai: { provider: 'openai_compatible', base_url } }, s.A);
    assert.equal(r.status, 400, base_url);
  }
  assert.ok(isPrivateAddress('10.1.2.3') && isPrivateAddress('172.20.0.1') && isPrivateAddress('100.64.0.1') && isPrivateAddress('::ffff:127.0.0.1') && isPrivateAddress('fd00::1'));
  assert.ok(!isPrivateAddress('8.8.8.8') && !isPrivateAddress('2606:4700::1111'));
  Object.assign(process.env, { OPENAI_COMPATIBLE_API_KEY: 'platform-secret', AI_BASE_URL: 'https://models.operator.example/v1' });
  resetConfigForTests();
  try {
    const theirs = aiFor({ ai: { provider: 'openai_compatible', base_url: 'https://attacker.example/v1' } }) as any;
    assert.equal(theirs.apiKey, undefined, 'platform key is not sent to a business-chosen address');
    assert.equal(theirs.untrusted, true);
    const platform = aiFor({ ai: { provider: 'openai_compatible' } }) as any;
    assert.equal(platform.apiKey, 'platform-secret');
    assert.equal(platform.untrusted, false);
    await assert.rejects(theirs.complete({ system: 'x', messages: [{ role: 'user', content: 'hi' }] }).catch((e: Error) => { throw e; }), /could not be found|not public/);
  } finally {
    delete process.env.OPENAI_COMPATIBLE_API_KEY; delete process.env.AI_BASE_URL; resetConfigForTests();
  }
});

test('public forms cannot take over an existing customer or their contact details', async () => {
  const s = await setup();
  const victim = (await srv.call('POST', '/v1/customers', { first_name: 'Vera', email: 'vera@example.com' }, s.A)).body.customer;
  const withPhone = (await srv.call('POST', '/v1/customers', { first_name: 'Paul', phone: '5125550801' }, s.A)).body.customer;
  const r = await tenant(s.id, (tx) => upsertCustomer(tx, s.id, { first_name: 'Attacker', phone: '5125550999', email: 'vera@example.com' }, { untrusted: true }));
  assert.equal(r.created, true);
  assert.notEqual(r.customer.id, victim.id);
  assert.equal(r.customer.email, null, 'an email that belongs to someone else is not copied');
  const v = (await tenant(s.id, (tx) => tx.query(`select phone, email, first_name from customers where id = $1`, [victim.id]))).rows[0];
  assert.deepEqual(v, { phone: null, email: 'vera@example.com', first_name: 'Vera' });
  // Same phone: it's the same person's line, so it matches, but no fields are overwritten or filled.
  const same = await tenant(s.id, (tx) => upsertCustomer(tx, s.id, { first_name: 'X', phone: '5125550801', email: 'new@evil.example' }, { untrusted: true }));
  assert.equal(same.customer.id, withPhone.id);
  assert.equal(same.customer.email, null);
  // The owner's own entry still fills in blanks as before.
  const trusted = await tenant(s.id, (tx) => upsertCustomer(tx, s.id, { phone: '5125550333', email: 'vera@example.com' }));
  assert.equal(trusted.customer.id, victim.id);
});

test('lead form: US numbers only, no links in names, and a flood is held for the owner', async () => {
  const s = await setup();
  const outbox = await freshOutbox();
  const post = (body: Record<string, unknown>) => srv.call('POST', `/public/${s.id}/leads`, body, { 'x-forwarded-for': `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  assert.equal((await post({ first_name: 'Al', phone: '+447700900123', sms_consent: true })).status, 400);
  assert.equal((await post({ first_name: 'Parcel held: http://evil.example/x', phone: '5125550811', sms_consent: true })).status, 400);
  assert.equal((await post({ first_name: 'Go to bit.ly', phone: '5125550811', sms_consent: true })).status, 400);
  assert.equal((await post({ first_name: 'Mary-Jo', phone: '5125550811', sms_consent: true })).status, 201);
  // Simulate a burst of form leads in the last hour.
  await tenant(s.id, (tx) => tx.query(`insert into events (business_id, type, subject_type, subject_id, data) select $1, 'lead.created', 'customer', gen_random_uuid(), '{}' from generate_series(1, 25)`, [s.id]));
  const before = outbox.length;
  await post({ first_name: 'Flood', phone: '5125550812', sms_consent: true });
  await settle(new Date(Date.now() + 1000));
  assert.ok(!outbox.slice(before).some((m) => m.to === '+15125550812'), 'not texted automatically');
  const d = (await tenant(s.id, (tx) => tx.query(`select d.reason from drafts d join customers c on c.id = d.customer_id where c.phone = '+15125550812'`))).rows[0];
  assert.match(d.reason, /held/);
});

test('customer CSV neutralises spreadsheet formulas', async () => {
  const s = await setup();
  await srv.call('POST', '/v1/customers', { first_name: '=HYPERLINK("http://x")', phone: '5125550821' }, s.A);
  const csv = String((await srv.call('GET', '/v1/export/customers.csv', undefined, s.A)).body);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(csv, /,\+15125550821,/, 'phone numbers are left alone');
});

test('an invoice cannot point at another business\'s booking', async () => {
  const a = await setup(); const b = await setup();
  const cb = (await srv.call('POST', '/v1/customers', { first_name: 'B', phone: '5125550831' }, b.A)).body.customer;
  const start = new Date(Date.now() + 5 * 86400_000); start.setUTCHours(16, 0, 0, 0);
  const bk = await srv.call('POST', '/v1/bookings', { customer_id: cb.id, service_key: 'standard', starts_at: start.toISOString() }, b.A);
  const ca = (await srv.call('POST', '/v1/customers', { first_name: 'A', phone: '5125550832' }, a.A)).body.customer;
  const r = await srv.call('POST', '/v1/invoices', { customer_id: ca.id, booking_id: bk.body.id, amount_cents: 5000, description: 'x' }, a.A);
  assert.equal(r.status, 404, JSON.stringify(r.body));
});

test('sign-in only accepts JSON; reset codes are limited per account in the database', async () => {
  const s = await setup();
  const form = await srv.call('POST', '/auth/login', `email=${encodeURIComponent(s.email)}&password=long+enough+password`);
  assert.equal(form.status, 415);
  const outbox = await freshOutbox();
  for (let i = 0; i < 5; i++) {
    await srv.call('POST', '/auth/reset/request', { email: s.email }, { 'x-forwarded-for': `10.9.${i}.1` });
  }
  assert.equal(outbox.filter((m) => m.to === s.ownerPhone).length, 3, 'at most three codes an hour');
});

test('in production, Twilio webhooks refuse unsigned requests when Twilio is not configured', async () => {
  Object.assign(process.env, { NODE_ENV: 'production', ADMIN_TOKEN: 'a'.repeat(40), APP_SECRET: 'b'.repeat(40) });
  resetConfigForTests();
  try {
    const r = await srv.call('POST', '/webhooks/twilio/sms', 'From=%2B15125550000&To=%2B15125550001&Body=approve+all');
    assert.equal(r.status, 403);
    const st = await srv.call('POST', '/webhooks/twilio/status', 'MessageSid=SM1&MessageStatus=delivered');
    assert.equal(st.status, 403);
  } finally {
    Object.assign(process.env, { NODE_ENV: 'test', ADMIN_TOKEN: 'test-admin-token-123456' }); delete process.env.APP_SECRET;
    resetConfigForTests();
  }
});
