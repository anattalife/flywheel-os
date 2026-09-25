import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, withSystem } from '../src/db/pool.js';
import { receiveLead, receiveSms, recordMissedCall } from '../src/core/inbound.js';
import { upsertCustomer } from '../src/core/customers.js';
import { completeBooking, createBooking } from '../src/core/bookings.js';
import { approveDraft } from '../src/core/messaging.js';
import { setAiFactoryForTests } from '../src/adapters/ai/index.js';
import { daytime, freshOutbox, newBusiness, settle, tenant, timezoneWhereItIsLateNight } from './helpers.js';

after(closePool);

test('tenancy: one business can never read another business\'s customers', async () => {
  const a = await newBusiness();
  const b = await newBusiness();
  await tenant(a.id, (tx) => upsertCustomer(tx, a.id, { first_name: 'Only-A', phone: '5125550101', source: 'test' }));
  const seenByB = await tenant(b.id, (tx) => tx.query(`select * from customers where first_name = 'Only-A'`));
  assert.equal(seenByB.rowCount, 0);
  const seenByA = await tenant(a.id, (tx) => tx.query(`select * from customers where first_name = 'Only-A'`));
  assert.equal(seenByA.rowCount, 1);
  // No tenant set: nothing visible at all.
  const none = await withSystem((tx) => tx.query(`select * from customers`));
  assert.equal(none.rowCount, 0);
  // Writing into another tenant is refused by the policy.
  await assert.rejects(tenant(b.id, (tx) => tx.query(`insert into customers (business_id, first_name) values ($1, 'sneaky')`, [a.id])));
});

test('events are append-only', async () => {
  const a = await newBusiness();
  await assert.rejects(tenant(a.id, (tx) => tx.query(`update events set type = 'x'`)), /append-only/);
});

test('missed call → instant text back, but only once a day', async () => {
  const outbox = await freshOutbox();
  const b = await newBusiness();
  await tenant(b.id, (tx) => recordMissedCall(tx, b.id, '+15125550102'));
  await settle();
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].body, /Sorry we missed your call/);
  assert.equal(outbox[0].to, '+15125550102');
  assert.equal(outbox[0].from, b.phone);
  await tenant(b.id, (tx) => recordMissedCall(tx, b.id, '+15125550102'));
  await settle();
  assert.equal(outbox.length, 1, 'second missed call the same day gets no second text');
});

test('missed call text-back still goes out at night, because they just called', async () => {
  const outbox = await freshOutbox();
  const b = await newBusiness({ timezone: timezoneWhereItIsLateNight() });
  await tenant(b.id, (tx) => recordMissedCall(tx, b.id, '+15125550103'));
  await settle(new Date(Date.now() + 1000));
  assert.equal(outbox.length, 1);
  // Someone who just sent the website form also gets the instant reply at night.
  await tenant(b.id, (tx) => receiveLead(tx, b.id, { first_name: 'Night', phone: '5125550199', sms_consent: true }));
  await settle(new Date(Date.now() + 2000));
  assert.equal(outbox.length, 2);
  // (Messages to people who haven't just contacted us wait for morning: see the quiet-hours test.)
});

test('lead: instant reply, follow-ups on day 1/3/7 as drafts, all cancelled when the lead replies', async () => {
  const outbox = await freshOutbox();
  const b = await newBusiness();
  const { customerId } = await tenant(b.id, (tx) => receiveLead(tx, b.id, { first_name: 'Dana', phone: '(512) 555-0104', sms_consent: true, source: 'website' }));
  await settle();
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].body, /^Hi Dana, thanks for reaching out/);

  const pending = await withSystem((tx) => tx.query(`select run_at from jobs where cancel_key = $1 and status = 'pending' order by run_at`, [`lead_followup:${customerId}`]));
  assert.equal(pending.rowCount, 3);

  // Day 1 arrives: follow-up becomes a draft for the owner (follow_up_trust = draft).
  await settle(daytime(1.2));
  const drafts = await tenant(b.id, (tx) => tx.query(`select body, reason from drafts where customer_id = $1`, [customerId]));
  assert.equal(drafts.rowCount, 1);
  assert.match(drafts.rows[0].reason, /Lead follow-up 1/);

  // The lead texts back: remaining follow-ups are cancelled.
  await tenant(b.id, (tx) => receiveSms(tx, b.id, '+15125550104', 'Yes, do you have Friday?'));
  await settle(daytime(1.3));
  const left = await withSystem((tx) => tx.query(`select 1 from jobs where cancel_key = $1 and status = 'pending'`, [`lead_followup:${customerId}`]));
  assert.equal(left.rowCount, 0);
});

test('a web lead without SMS consent gets no texts at all', async () => {
  const outbox = await freshOutbox();
  const b = await newBusiness();
  await tenant(b.id, (tx) => receiveLead(tx, b.id, { first_name: 'Noconsent', phone: '5125550105', sms_consent: false }));
  await settle();
  assert.equal(outbox.length, 0);
  const blocked = await tenant(b.id, (tx) => tx.query(`select block_reason from messages where status = 'blocked'`));
  assert.equal(blocked.rows[0]?.block_reason, 'no_consent');
});

test('job completed → review request drafted after the delay → owner approves → sent with STOP footer', async () => {
  const outbox = await freshOutbox();
  const b = await newBusiness({ pack_overrides: { playbooks: { payment_request: { enabled: false } } } });
  const bookingId = await tenant(b.id, async (tx) => {
    const { customer } = await upsertCustomer(tx, b.id, { first_name: 'Rae', phone: '5125550106', sms_consent: true, consent_source: 'web_form', source: 'referral' });
    const bk = await createBooking(tx, b.id, { customer_id: customer.id, service_key: 'standard', starts_at: daytime(-1) });
    return bk.id;
  });
  const completedAt = daytime();
  await tenant(b.id, (tx) => completeBooking(tx, b.id, bookingId, completedAt));
  await settle(completedAt);
  let drafts = await tenant(b.id, (tx) => tx.query(`select id from drafts where playbook = 'review_request'`));
  assert.equal(drafts.rowCount, 0, 'nothing before the delay');
  await settle(new Date(completedAt.getTime() + 2.1 * 3_600_000));
  drafts = await tenant(b.id, (tx) => tx.query(`select id, body from drafts where playbook = 'review_request'`));
  assert.equal(drafts.rowCount, 1);
  assert.match(drafts.rows[0].body, /https:\/\/g\.page\/r\/test/);
  await tenant(b.id, (tx) => approveDraft(tx, b.id, drafts.rows[0].id));
  await settle(new Date(completedAt.getTime() + 2.2 * 3_600_000));
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].body, /Reply STOP to opt out\.$/);
});

test('STOP opts out and blocks everything after; START opts back in', async () => {
  const outbox = await freshOutbox();
  const b = await newBusiness();
  await tenant(b.id, (tx) => receiveSms(tx, b.id, '+15125550107', 'STOP'));
  const c = await tenant(b.id, (tx) => tx.query(`select id, sms_opted_out from customers where phone = '+15125550107'`));
  assert.equal(c.rows[0].sms_opted_out, true);
  await tenant(b.id, (tx) => recordMissedCall(tx, b.id, '+15125550107'));
  await settle(new Date(Date.now() + 1000));
  assert.equal(outbox.length, 0);
  await tenant(b.id, (tx) => receiveSms(tx, b.id, '+15125550107', 'start'));
  const c2 = await tenant(b.id, (tx) => tx.query(`select sms_opted_out from customers where phone = '+15125550107'`));
  assert.equal(c2.rows[0].sms_opted_out, false);
});

test('quiet hours defer an automated message to the next morning', async () => {
  const outbox = await freshOutbox();
  const b = await newBusiness({ pack_overrides: { playbooks: { review_request: { trust: 'auto', delay_hours: 0 }, payment_request: { enabled: false } } } });
  const bookingId = await tenant(b.id, async (tx) => {
    const { customer } = await upsertCustomer(tx, b.id, { first_name: 'Quinn', phone: '5125550108', sms_consent: true, consent_source: 'web_form' });
    return (await createBooking(tx, b.id, { customer_id: customer.id, service_key: 'standard', starts_at: daytime(-1) })).id;
  });
  const lateNight = new Date(daytime().getTime() + 8 * 3_600_000); // 23:00 local
  await tenant(b.id, (tx) => completeBooking(tx, b.id, bookingId, lateNight));
  await settle(lateNight);
  assert.equal(outbox.length, 0, 'held overnight');
  const deferred = await tenant(b.id, (tx) => tx.query(`select data from events where type = 'message.deferred'`));
  assert.equal(deferred.rowCount, 1);
  await settle(new Date(lateNight.getTime() + 10 * 3_600_000)); // 09:00 local next day
  assert.equal(outbox.length, 1);
});

test('weekly cap stops a customer getting more than N automated messages', async () => {
  const outbox = await freshOutbox();
  const b = await newBusiness({ pack_overrides: { guardrails: { max_automated_per_week: 1 }, playbooks: { lead_response: { follow_up_trust: 'auto', follow_up_days: [1] } } } });
  await tenant(b.id, (tx) => receiveLead(tx, b.id, { first_name: 'Cap', phone: '5125550109', sms_consent: true }));
  await settle();
  await settle(daytime(1.2));
  assert.equal(outbox.length, 1, 'instant reply sent, follow-up blocked by the cap');
  const blocked = await tenant(b.id, (tx) => tx.query(`select block_reason from messages where status = 'blocked'`));
  assert.equal(blocked.rows[0].block_reason, 'weekly_cap');
});

test('a disabled playbook does nothing', async () => {
  const outbox = await freshOutbox();
  const b = await newBusiness({ pack_overrides: { playbooks: { missed_call_textback: { enabled: false } } } });
  await tenant(b.id, (tx) => recordMissedCall(tx, b.id, '+15125550110'));
  await settle(new Date(Date.now() + 1000));
  assert.equal(outbox.length, 0);
});

test('inbox assist: the chosen AI model drafts a reply for approval; AI off drafts nothing', async () => {
  await freshOutbox();
  const seen: string[] = [];
  setAiFactoryForTests((choice) => choice.provider === 'none' ? null : {
    name: 'fake',
    async complete(req) { seen.push(req.system); return 'Friday at 10am works. Want me to book it?'; },
  });
  const withAi = await newBusiness({ settings: { ai: { provider: 'anthropic' } } });
  await tenant(withAi.id, (tx) => receiveSms(tx, withAi.id, '+15125550111', 'Do you have time Friday?'));
  await settle(new Date(Date.now() + 1000));
  const drafts = await tenant(withAi.id, (tx) => tx.query(`select body, playbook from drafts`));
  assert.equal(drafts.rows[0]?.body, 'Friday at 10am works. Want me to book it?');
  assert.match(seen[0], /Never invent prices/);

  const noAi = await newBusiness({ settings: { ai: { provider: 'none' } } });
  await tenant(noAi.id, (tx) => receiveSms(tx, noAi.id, '+15125550112', 'Hello?'));
  await settle(new Date(Date.now() + 1000));
  const none = await tenant(noAi.id, (tx) => tx.query(`select 1 from drafts`));
  assert.equal(none.rowCount, 0);
  setAiFactoryForTests(undefined);
});

test('a failing job retries with backoff and records the error', async () => {
  const b = await newBusiness();
  await withSystem((tx) => tx.query(`insert into jobs (business_id, type, payload) values ($1, 'no_such_type', '{}')`, [b.id]));
  const origError = console.error;
  console.error = () => {};
  await settle(new Date(Date.now() + 1000));
  console.error = origError;
  const j = await withSystem((tx) => tx.query(`select status, attempts, last_error, run_at from jobs where type = 'no_such_type'`));
  assert.equal(j.rows[0].status, 'pending');
  assert.equal(j.rows[0].attempts, 1);
  assert.match(j.rows[0].last_error, /no handler/);
});
