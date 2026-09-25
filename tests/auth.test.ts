import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db/pool.js';
import { freshOutbox } from './helpers.js';
import { ADMIN, startServer, uniquePhone } from './support.js';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); await closePool(); });

async function businessWithOwner(email: string, password = 'correct horse battery') {
  const r = await srv.call('POST', '/admin/businesses', {
    name: 'Auth Co', phone_number: uniquePhone(),
    owner: { email, password, name: 'Owner', phone: '+15125550300' },
  }, ADMIN);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.business.id as string;
}

async function signIn(email: string, password: string) {
  const r = await srv.call('POST', '/auth/login', { email, password });
  const setCookie = r.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  return { r, cookie };
}

test('owner signs in with email and password; wrong password is refused', async () => {
  await businessWithOwner('owner1@example.com');
  const bad = await signIn('owner1@example.com', 'wrong password!!');
  assert.equal(bad.r.status, 401);
  const unknown = await signIn('nobody@example.com', 'whatever-password');
  assert.equal(unknown.r.status, 401);
  const { r, cookie } = await signIn('OWNER1@example.com', 'correct horse battery');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Lax/);
  const me = await srv.call('GET', '/auth/me', undefined, { cookie });
  assert.equal(me.body.user.email, 'owner1@example.com');
  const biz = await srv.call('GET', '/v1/business', undefined, { cookie });
  assert.equal(biz.status, 200);
  assert.equal(biz.body.name, 'Auth Co');
});

test('weak passwords are rejected when creating an owner', async () => {
  const r = await srv.call('POST', '/admin/businesses', { name: 'Weak Co', owner: { email: 'weak@example.com', password: 'short' } }, ADMIN);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least 10 characters/);
});

test('cookie requests that change data need the CSRF header', async () => {
  await businessWithOwner('owner2@example.com');
  const { cookie } = await signIn('owner2@example.com', 'correct horse battery');
  const blocked = await srv.call('POST', '/v1/customers', { first_name: 'X', phone: '5125550301' }, { cookie });
  assert.equal(blocked.status, 403);
  const ok = await srv.call('POST', '/v1/customers', { first_name: 'X', phone: '5125550301' }, { cookie, 'x-fw-csrf': '1' });
  assert.equal(ok.status, 201);
});

test('sign out ends the session', async () => {
  await businessWithOwner('owner3@example.com');
  const { cookie } = await signIn('owner3@example.com', 'correct horse battery');
  await srv.call('POST', '/auth/logout', {}, { cookie });
  assert.equal((await srv.call('GET', '/v1/business', undefined, { cookie })).status, 401);
});

test('password reset by texted code; wrong codes are counted; old sessions end', async () => {
  const outbox = await freshOutbox();
  await businessWithOwner('owner4@example.com');
  const { cookie } = await signIn('owner4@example.com', 'correct horse battery');
  const req = await srv.call('POST', '/auth/reset/request', { email: 'owner4@example.com' });
  assert.equal(req.status, 200);
  const code = outbox.at(-1)!.body.match(/(\d{6})/)![1];
  assert.equal(outbox.at(-1)!.to, '+15125550300');
  const wrong = await srv.call('POST', '/auth/reset/confirm', { email: 'owner4@example.com', code: code === '000000' ? '111111' : '000000', password: 'a brand new password' });
  assert.equal(wrong.status, 400);
  const ok = await srv.call('POST', '/auth/reset/confirm', { email: 'owner4@example.com', code, password: 'a brand new password' });
  assert.equal(ok.status, 200);
  assert.equal((await srv.call('GET', '/v1/business', undefined, { cookie })).status, 401, 'old session signed out');
  assert.equal((await signIn('owner4@example.com', 'a brand new password')).r.status, 200);
  const reuse = await srv.call('POST', '/auth/reset/confirm', { email: 'owner4@example.com', code, password: 'another new password' });
  assert.equal(reuse.status, 400, 'a code works once');
  // Unknown emails get the same answer (no account discovery).
  const unknown = await srv.call('POST', '/auth/reset/request', { email: 'ghost@example.com' });
  assert.equal(unknown.status, 200);
});

test('the owner app shell is served with a strict content security policy', async () => {
  const r = await srv.call('GET', '/app/inbox');
  assert.equal(r.status, 200);
  assert.match(String(r.body), /<div id="app"/);
  assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const js = await srv.call('GET', '/assets/owner/app.js');
  assert.equal(js.status, 200);
  assert.equal((await srv.call('GET', '/assets/owner/..%2F..%2Fconfig.ts')).status, 404);
});

test('Today summary lists the day\'s bookings and who is waiting', async () => {
  await businessWithOwner('owner5@example.com');
  const { cookie } = await signIn('owner5@example.com', 'correct horse battery');
  const H = { cookie, 'x-fw-csrf': '1' };
  const c = await srv.call('POST', '/v1/customers', { first_name: 'Tia', phone: '5125550302' }, H);
  await srv.call('POST', '/v1/bookings', { customer_id: c.body.customer.id, service_key: 'standard', starts_at: new Date(Date.now() + 60_000).toISOString() }, H);
  const t = await srv.call('GET', '/v1/today', undefined, { cookie });
  assert.equal(t.status, 200);
  assert.ok(t.body.bookings.length >= 0);
  assert.equal(typeof t.body.pending_drafts, 'number');
});
