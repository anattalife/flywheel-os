import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closePool } from '../src/db/pool.js';
import { FakeGoogle, setGoogleAdapter } from '../src/adapters/google/index.js';
import { LocalStorage } from '../src/adapters/storage/local.js';
import { setStorageAdapter } from '../src/adapters/storage/index.js';
import { setAiFactoryForTests } from '../src/adapters/ai/index.js';
import { signS3 } from '../src/adapters/storage/s3.js';
import { decryptJson, encryptJson } from '../src/lib/crypto.js';
import { daytime, freshOutbox, settle, tenant } from './helpers.js';
import { ADMIN, startServer, uniquePhone } from './support.js';

let srv: Awaited<ReturnType<typeof startServer>>;
let g: FakeGoogle;
before(async () => {
  srv = await startServer();
  setStorageAdapter(new LocalStorage(await mkdtemp(path.join(os.tmpdir(), 'fw-photos-'))));
});
after(async () => { await srv.close(); await closePool(); setAiFactoryForTests(undefined); });

async function setup(extra: Record<string, unknown> = {}) {
  g = new FakeGoogle(); setGoogleAdapter(g);
  await freshOutbox();
  const email = `o${Date.now()}${Math.random()}@x.com`;
  const r = await srv.call('POST', '/admin/businesses', { name: 'Shine Co', phone_number: uniquePhone(), owner: { email, password: 'long enough password' }, settings: { site: { service_area: 'Austin', areas: ['South Austin'] } }, ...extra }, ADMIN);
  const login = await srv.call('POST', '/auth/login', { email, password: 'long enough password' });
  const cookie = { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] };
  return { id: r.body.business.id as string, A: { authorization: `Bearer ${r.body.api_key}` }, cookie };
}

/** Google sign-in from the owner's browser session, then Google's redirect back with the same cookie. */
async function connect(s: { cookie: Record<string, string> }) {
  const start = await srv.call('GET', '/v1/google/connect', undefined, s.cookie);
  const cb = new URL(start.body.url);
  return srv.call('GET', cb.pathname + cb.search, undefined, s.cookie);
}

test('secrets round-trip through encryption and tampering is detected', () => {
  const sealed = encryptJson({ refresh_token: 'abc' });
  assert.deepEqual(decryptJson(sealed), { refresh_token: 'abc' });
  const parts = sealed.split('.');
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => decryptJson(parts.join('.')));
});

test('S3 signing matches the AWS published example', () => {
  const r = signS3({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', amzDate: '20130524T000000Z', region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('connect Google through sign-in; forged states are refused; tokens are stored encrypted', async () => {
  const s = await setup();
  assert.equal((await srv.call('GET', '/v1/google/connect', undefined, s.A)).status, 400, 'API keys cannot start a browser sign-in');
  // A sign-in link started by one owner cannot be completed by someone else (or no one).
  const start = await srv.call('GET', '/v1/google/connect', undefined, s.cookie);
  const cb = new URL(start.body.url);
  const other = await setup();
  const stolen = await srv.call('GET', cb.pathname + cb.search, undefined, other.cookie);
  assert.match(stolen.headers.get('location')!, /google=expired/);
  assert.match((await srv.call('GET', cb.pathname + cb.search)).headers.get('location')!, /google=expired/);
  assert.equal((await srv.call('GET', '/v1/google', undefined, other.A)).body.connected, false);
  const ok = await srv.call('GET', cb.pathname + cb.search, undefined, s.cookie);
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get('location')!, /google=connected/);
  const status = await srv.call('GET', '/v1/google', undefined, s.A);
  assert.equal(status.body.connected, true);
  assert.equal(status.body.location, 'My business');
  const stored = await tenant(s.id, (tx) => tx.query(`select credentials from integrations`));
  assert.match(stored.rows[0].credentials, /^v1\./);
  assert.doesNotMatch(stored.rows[0].credentials, /fake-refresh/);
  const forged = await srv.call('GET', `/oauth/google/callback?code=x&state=${s.id}.${Date.now() + 60000}.bad`);
  assert.match(forged.headers.get('location')!, /google=expired/);
});

test('Google reviews sync in once; replies are drafted (template without AI) and posted after approval', async () => {
  const s = await setup();
  await connect(s);
  g.reviews = [
    { id: 'r1', reviewer: 'Ana Ruiz', rating: 5, comment: 'Spotless kitchen!', createdAt: new Date().toISOString(), reply: null },
    { id: 'r2', reviewer: 'Bob K', rating: 2, comment: 'Late and rushed.', createdAt: new Date().toISOString(), reply: null },
    { id: 'r3', reviewer: 'Cy', rating: 4, comment: 'Good', createdAt: new Date().toISOString(), reply: 'Thanks Cy!' },
  ];
  const first = await srv.call('POST', '/v1/google/sync', {}, s.A);
  assert.deepEqual(first.body, { added: 3, total: 3 });
  const again = await srv.call('POST', '/v1/google/sync', {}, s.A);
  assert.equal(again.body.added, 0);
  await settle(daytime());
  const reviews = (await srv.call('GET', '/v1/reviews', undefined, s.A)).body;
  const ana = reviews.find((r: any) => r.reviewer_name === 'Ana Ruiz');
  const bob = reviews.find((r: any) => r.reviewer_name === 'Bob K');
  assert.equal(ana.reply_status, 'drafted');
  assert.match(ana.reply_draft, /Thank you so much, Ana/);
  assert.match(bob.reply_draft, /sorry we fell short/);
  assert.equal(reviews.find((r: any) => r.reviewer_name === 'Cy').reply_status, 'posted');
  await srv.call('POST', `/v1/reviews/${ana.id}/reply`, { text: 'Thank you, Ana! That kitchen was a fun one.' }, s.A);
  assert.deepEqual(g.replies, [{ reviewId: 'r1', comment: 'Thank you, Ana! That kitchen was a fun one.' }]);
  const site = await srv.call('GET', `/site/${s.id}`);
  assert.match(String(site.body), /Spotless kitchen!/, '5-star reviews with text appear on the website');
});

test('AI drafts review replies in the owner\'s voice when AI is on', async () => {
  const s = await setup({ settings: { ai: { provider: 'anthropic' } } });
  setAiFactoryForTests((c) => c.provider === 'none' ? null : { name: 'fake', async complete() { return 'Thanks Dee, we loved working on your patio!'; } });
  await connect(s);
  g.reviews = [{ id: 'd1', reviewer: 'Dee', rating: 5, comment: 'Patio looks new', createdAt: new Date().toISOString(), reply: null }];
  await srv.call('POST', '/v1/google/sync', {}, s.A);
  await settle(daytime());
  const r = (await srv.call('GET', '/v1/reviews', undefined, s.A)).body[0];
  assert.equal(r.reply_draft, 'Thanks Dee, we loved working on your patio!');
  setAiFactoryForTests(undefined);
});

test('photos: upload, signed media links, and a Business Profile post only from customer-approved photos', async () => {
  const s = await setup();
  await connect(s);
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  const up = async (publicOk: boolean) => fetch(`${srv.base}/v1/photos?public_ok=${publicOk ? 1 : 0}&caption=Kitchen`, { method: 'POST', headers: { ...s.A, 'content-type': 'image/jpeg' }, body: jpeg }).then((r) => r.json());
  const priv = await up(false);
  assert.equal((await srv.call('POST', '/v1/posts/draft', {}, s.A)).status, 409, 'private photos are never posted');
  const pub = await up(true);
  assert.ok(pub.id && priv.id);
  const bad = await fetch(`${srv.base}/v1/photos`, { method: 'POST', headers: { ...s.A, 'content-type': 'application/pdf' }, body: jpeg });
  assert.equal(bad.status, 415);
  const photos = (await srv.call('GET', '/v1/photos', undefined, s.A)).body;
  const res = await fetch(srv.base + new URL(photos[0].url).pathname + new URL(photos[0].url).search);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${srv.base}/media/${photos[0].id}?t=nope`)).status, 404);
  const draft = await srv.call('POST', '/v1/posts/draft', {}, s.A);
  assert.equal(draft.status, 201);
  await srv.call('POST', `/v1/posts/${draft.body.id}/publish`, { body: 'Fresh, bright kitchen for a South Austin family.' }, s.A);
  assert.equal(g.posts.length, 1);
  assert.equal(g.posts[0].summary, 'Fresh, bright kitchen for a South Austin family.');
  assert.match(g.posts[0].photoUrl!, new RegExp(`/media/${pub.id}\\?t=`));
  assert.match(g.posts[0].bookUrl!, /\/book$/);
});

test('AI visibility check records whether the business is named', async () => {
  const s = await setup({ settings: { ai: { provider: 'anthropic' }, site: { areas: ['South Austin'] } } });
  setAiFactoryForTests((c) => c.provider === 'none' ? null : { name: 'fake', async complete() { return ''; }, async searchAnswer(q: string) { return q.includes('South Austin') ? 'Top picks: Shine Co and Sparkle Bros.' : 'Sparkle Bros.'; } });
  const r = await srv.call('POST', '/v1/ai-visibility/check', {}, s.A);
  assert.deepEqual(r.body.results.map((x: any) => x.mentioned), [true]);
  const list = await srv.call('GET', '/v1/ai-visibility', undefined, s.A);
  assert.match(list.body[0].excerpt, /Shine Co/);
  setAiFactoryForTests(undefined);
});
