import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closePool } from '../src/db/pool.js';
import { DevEmail, setEmailAdapter } from '../src/adapters/email/index.js';
import { setAiFactoryForTests } from '../src/adapters/ai/index.js';
import { LocalStorage } from '../src/adapters/storage/local.js';
import { setStorageAdapter } from '../src/adapters/storage/index.js';
import { resetConfigForTests } from '../src/config.js';
import { parseCsv, rowsFromCsv, rowsFromVcard } from '../src/core/importer.js';
import { sign } from '../src/lib/sign.js';
import { daytime, freshOutbox, settle, tenant } from './helpers.js';
import { ADMIN, startServer, uniquePhone } from './support.js';

let srv: Awaited<ReturnType<typeof startServer>>;
let mail: DevEmail;
before(async () => {
  srv = await startServer();
  setStorageAdapter(new LocalStorage(await mkdtemp(path.join(os.tmpdir(), 'fw-ch-'))));
});
after(async () => { await srv.close(); await closePool(); setAiFactoryForTests(undefined); });

async function setup(extra: Record<string, unknown> = {}) {
  mail = new DevEmail(); setEmailAdapter(mail);
  const outbox = await freshOutbox();
  const r = await srv.call('POST', '/admin/businesses', { name: 'Mail Co', phone_number: uniquePhone(), pack_overrides: { scheduling: { min_notice_hours: 0, buffer_min: 0 } }, owner: { email: `m${Date.now()}${Math.random()}@x.com`, password: 'long enough password' }, ...extra }, ADMIN);
  return { id: r.body.business.id as string, A: { authorization: `Bearer ${r.body.api_key}` }, outbox };
}

test('no text consent but an email: service messages go by email; marketing email needs consent and carries unsubscribe', async () => {
  const s = await setup();
  const c = await srv.call('POST', '/v1/customers', { first_name: 'Eve', email: 'eve@example.com' }, s.A);
  const start = new Date(Date.now() + 3 * 86400_000);
  await srv.call('POST', '/v1/bookings', { customer_id: c.body.customer.id, service_key: 'standard', starts_at: start.toISOString() }, s.A);
  await settle(daytime());
  assert.equal(s.outbox.length, 0, 'no text: no phone');
  const conf = mail.outbox.find((m) => /You are booked/.test(m.text));
  assert.ok(conf, 'confirmation emailed');
  assert.equal(conf!.to, 'eve@example.com');
  assert.match(conf!.subject, /^Mail Co:/);
  assert.equal(conf!.listUnsubscribe, undefined, 'service email has no unsubscribe');
  // Marketing email without consent is blocked; with consent it has an unsubscribe link that works.
  await tenant(s.id, (tx) => tx.query(`insert into messages (business_id, customer_id, direction, channel, body, kind, status, playbook) values ($1, $2, 'out', 'email', 'Spring special!', 'marketing', 'queued', 'win_back')`, [s.id, c.body.customer.id]));
  await tenant(s.id, (tx) => tx.query(`insert into jobs (business_id, type, payload) select $1, 'deliver_message', jsonb_build_object('message_id', id) from messages where body = 'Spring special!'`, [s.id]));
  await settle(daytime());
  const blocked = await tenant(s.id, (tx) => tx.query(`select block_reason from messages where body = 'Spring special!'`));
  assert.equal(blocked.rows[0].block_reason, 'no_email_consent');
  await tenant(s.id, (tx) => tx.query(`update customers set email_consent = true where id = $1`, [c.body.customer.id]));
  await tenant(s.id, (tx) => tx.query(`insert into messages (business_id, customer_id, direction, channel, body, kind, status, playbook) values ($1, $2, 'out', 'email', 'Spring special 2!', 'marketing', 'queued', 'win_back')`, [s.id, c.body.customer.id]));
  await tenant(s.id, (tx) => tx.query(`insert into jobs (business_id, type, payload) select $1, 'deliver_message', jsonb_build_object('message_id', id) from messages where body = 'Spring special 2!'`, [s.id]));
  await settle(daytime());
  const promo = mail.outbox.find((m) => /Spring special 2/.test(m.text))!;
  assert.match(promo.text, /Unsubscribe: .*\/u\//);
  const unsub = new URL(promo.listUnsubscribe!);
  const page = await srv.call('GET', unsub.pathname + unsub.search);
  assert.match(String(page.body), /unsubscribed/);
  const after = await tenant(s.id, (tx) => tx.query(`select email_consent from customers where id = $1`, [c.body.customer.id]));
  assert.equal(after.rows[0].email_consent, false);
  assert.equal((await srv.call('GET', `/u/${c.body.customer.id}?t=wrong`)).status, 404);
});

test('delivery results: delivered and failed are recorded; carrier opt-out stops texts', async () => {
  const s = await setup();
  const c = await srv.call('POST', '/v1/customers', { first_name: 'Del', phone: '5125550800', sms_consent: true, consent_source: 'verbal' }, s.A);
  await srv.call('POST', `/v1/customers/${c.body.customer.id}/messages`, { body: 'Hello!' }, s.A);
  await settle(daytime());
  const m = await tenant(s.id, (tx) => tx.query(`select provider_id from messages where body = 'Hello!'`));
  const sid = m.rows[0].provider_id;
  await srv.call('POST', '/webhooks/twilio/status', `MessageSid=${sid}&MessageStatus=delivered`);
  assert.equal((await tenant(s.id, (tx) => tx.query(`select status from messages where provider_id = $1`, [sid]))).rows[0].status, 'delivered');
  await srv.call('POST', '/webhooks/twilio/status', `MessageSid=${sid}&MessageStatus=undelivered&ErrorCode=21610`);
  const row = (await tenant(s.id, (tx) => tx.query(`select status, error_code from messages where provider_id = $1`, [sid]))).rows[0];
  assert.deepEqual(row, { status: 'failed', error_code: '21610' });
  const cust = await tenant(s.id, (tx) => tx.query(`select sms_opted_out from customers where id = $1`, [c.body.customer.id]));
  assert.equal(cust.rows[0].sms_opted_out, true);
});

test('a job with photos sends a photo report by MMS', async () => {
  const s = await setup({ pack_overrides: { scheduling: { min_notice_hours: 0, buffer_min: 0 }, playbooks: { payment_request: { enabled: false }, review_request: { enabled: false }, first_visit_checkin: { enabled: false } } } });
  const c = await srv.call('POST', '/v1/customers', { first_name: 'Pia', phone: '5125550801', sms_consent: true, consent_source: 'verbal' }, s.A);
  const bk = await srv.call('POST', '/v1/bookings', { customer_id: c.body.customer.id, service_key: 'standard', starts_at: new Date(Date.now() - 7200_000).toISOString() }, s.A);
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  await fetch(`${srv.base}/v1/photos?booking_id=${bk.body.id}`, { method: 'POST', headers: { ...s.A, 'content-type': 'image/jpeg' }, body: jpeg });
  await srv.call('POST', `/v1/bookings/${bk.body.id}/complete`, {}, s.A);
  await settle(daytime());
  await settle(new Date(daytime().getTime() + 31 * 60_000));
  const report = s.outbox.find((m) => /Here is how it turned out/.test(m.body));
  assert.ok(report);
  assert.equal(report!.mediaUrls?.length, 1);
  assert.match(report!.mediaUrls![0], /\/media\/[\w-]+\?t=/);
});

test('CSV and vCard parsing handle real-world files', () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\n1,2,3\r\n'), [['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
  const rows = rowsFromCsv('Full Name,Mobile Phone,E-mail,Last Visit,Notes\n"Lopez, Maria",(512) 555-0901,maria@x.com,2026-05-01,"Gate code 12"\nJohn Smith,5125550902,,,\n');
  assert.equal(rows[1].first_name, 'John');
  assert.equal(rows[1].last_name, 'Smith');
  assert.equal(rows[0].phone, '(512) 555-0901');
  assert.equal(rows[0].last_visit, '2026-05-01');
  const cards = rowsFromVcard('BEGIN:VCARD\nVERSION:3.0\nN:Diaz;Ana;;;\nFN:Ana Diaz\nTEL;TYPE=HOME:5125550000\nTEL;TYPE=CELL:5125550903\nEMAIL:ana@x.com\nEND:VCARD\nBEGIN:VCARD\nFN:Bo\nEND:VCARD\n');
  assert.deepEqual(cards[0], { first_name: 'Ana', last_name: 'Diaz', phone: '5125550903', email: 'ana@x.com' });
  assert.equal(cards[1].first_name, 'Bo');
});

test('import customers with consent choice, then draft first-win review asks', async () => {
  const s = await setup();
  const csv = 'Name,Phone,Email,Last visit\nMaria Lopez,512-555-0911,maria@x.com,2026-08-01\nJohn Smith,5125550912,,2026-07-15\nBad Row,123,,\n';
  const res = await fetch(`${srv.base}/v1/import/customers?consent=verbal`, { method: 'POST', headers: { ...s.A, 'content-type': 'text/csv' }, body: csv }).then((r) => r.json());
  assert.equal(res.created, 2);
  assert.equal(res.skipped, 1);
  assert.match(res.errors[0], /Row 4/);
  const again = await fetch(`${srv.base}/v1/import/customers?consent=verbal`, { method: 'POST', headers: { ...s.A, 'content-type': 'text/csv' }, body: csv }).then((r) => r.json());
  assert.equal(again.updated, 2, 'importing twice updates instead of duplicating');
  const cust = await tenant(s.id, (tx) => tx.query(`select first_name, sms_consent, sms_consent_source, source, status from customers order by first_name`));
  assert.deepEqual(cust.rows[0], { first_name: 'John', sms_consent: true, sms_consent_source: 'verbal', source: 'import', status: 'active' });
  const wins = await srv.call('POST', '/v1/campaigns', { kind: 'review_ask' }, s.A);
  assert.equal(wins.body.drafted, 2);
  const again2 = await srv.call('POST', '/v1/campaigns', { kind: 'review_ask' }, s.A);
  assert.equal(again2.body.drafted, 0, 'no double asks');
  const status = await srv.call('GET', '/v1/setup', undefined, s.A);
  assert.equal(status.body.steps.customers, true);
});

test('AI setup from a description proposes words, services and hours; the owner applies it', async () => {
  const s = await setup({ settings: { ai: { provider: 'anthropic' } } });
  const proposal = {
    vocabulary: { customer: { one: 'student', many: 'students' }, job: { one: 'class', many: 'classes' }, provider: { one: 'teacher', many: 'teachers' }, booking_verb: 'book' },
    services: [{ name: 'Group class', duration_min: 60, price_rule: { type: 'fixed', amount_cents: 2000 } }, { name: 'Private session', duration_min: 60, price_rule: { type: 'fixed', amount_cents: 9000 } }],
    recurrence: [{ key: 'weekly', label: 'Every week', interval_days: 7 }],
    hours: [{ weekday: 2, opens: '06:00', closes: '20:00' }],
    headline: 'Yoga for runners in East Austin', subline: 'Small classes that fix tight hips.', faq: [{ q: 'Do I need a mat?', a: 'We have spares.' }],
  };
  setAiFactoryForTests((ch) => ch.provider === 'none' ? null : { name: 'fake', async complete() { return '```json\n' + JSON.stringify(proposal) + '\n```'; } });
  const sug = await srv.call('POST', '/v1/setup/suggest', { description: 'I teach yoga for runners, group classes and privates, in East Austin.' }, s.A);
  assert.equal(sug.status, 200, JSON.stringify(sug.body));
  assert.equal(sug.body.vocabulary.customer.many, 'students');
  const applied = await srv.call('POST', '/v1/setup/apply', sug.body, s.A);
  assert.equal(applied.body.steps.services, true);
  const svcs = await srv.call('GET', '/v1/services', undefined, s.A);
  assert.deepEqual(svcs.body.filter((x: any) => x.active).map((x: any) => x.name).sort(), ['Group class', 'Private session']);
  const biz = await srv.call('GET', '/v1/business', undefined, s.A);
  assert.equal(biz.body.pack.vocabulary.job.many, 'classes');
  assert.equal(biz.body.settings.site.headline, 'Yoga for runners in East Austin');
  const site = await srv.call('GET', `/site/${s.id}`);
  assert.match(String(site.body), /Group class/);
  setAiFactoryForTests(undefined);
});

test('services can be added and edited; sign-up is off unless enabled', async () => {
  const s = await setup();
  const add = await srv.call('POST', '/v1/services', { name: 'Deep clean', duration_min: 180, price_rule: { type: 'formula', base_cents: 20000, minimum_cents: 0, inputs: [{ kind: 'number', key: 'rooms', label: 'Rooms', per_unit_cents: 3000, min: 1, default: 3 }] } }, s.A);
  assert.equal(add.body.key, 'deep_clean');
  const q = await srv.call('POST', '/v1/quotes', { service_key: 'deep_clean', inputs: { rooms: 4 } }, s.A);
  assert.equal(q.body.amount_cents, 32000);
  await srv.call('PATCH', '/v1/services/deep_clean', { active: false }, s.A);
  assert.equal((await srv.call('POST', '/v1/quotes', { service_key: 'deep_clean' }, s.A)).status, 404);
  assert.equal((await srv.call('POST', '/signup', { business_name: 'X', email: 'x@x.com', password: 'long enough password' })).status, 404);
  process.env.ALLOW_SIGNUP = 'true'; resetConfigForTests();
  const su = await srv.call('POST', '/signup', { business_name: 'New Biz', email: `new${Date.now()}@x.com`, password: 'long enough password' });
  assert.equal(su.status, 201);
  assert.match(su.headers.get('set-cookie') ?? '', /fw_session=/);
  process.env.ALLOW_SIGNUP = 'false'; resetConfigForTests();
  void sign;
});
