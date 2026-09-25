import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, withSystem } from '../src/db/pool.js';
import { loadBusiness } from '../src/core/business.js';
import { receiveSms } from '../src/core/inbound.js';
import { scheduleWinBacks, scoreHealth } from '../src/core/retention.js';
import { DevPayments, setPaymentsAdapter } from '../src/adapters/payments/index.js';
import { daytime, freshOutbox, settle, tenant } from './helpers.js';
import { ADMIN, startServer, uniquePhone } from './support.js';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => { srv = await startServer(); setPaymentsAdapter(new DevPayments()); });
after(async () => { await srv.close(); await closePool(); });

async function setup(overrides: Record<string, unknown> = {}) {
  const outbox = await freshOutbox();
  const r = await srv.call('POST', '/admin/businesses', { name: 'Keep Co', phone_number: uniquePhone(), pack_overrides: { scheduling: { min_notice_hours: 0, buffer_min: 0 }, ...overrides } }, ADMIN);
  const A = { authorization: `Bearer ${r.body.api_key}` };
  return { id: r.body.business.id as string, A, outbox };
}
async function customer(s: { A: Record<string, string> }, name: string, consent = true) {
  const c = await srv.call('POST', '/v1/customers', { first_name: name, phone: `51255${String(Math.random()).slice(2, 7)}`, ...(consent ? { sms_consent: true, consent_source: 'verbal' } : {}) }, s.A);
  return c.body.customer as { id: string; phone: string };
}
/** Insert a completed visit `daysAgo` days in the past. */
async function pastVisit(businessId: string, customerId: string, daysAgo: number) {
  await tenant(businessId, async (tx) => {
    const at = new Date(Date.now() - daysAgo * 86400_000);
    await tx.query(`insert into bookings (business_id, customer_id, starts_at, ends_at, status, completed_at, price_cents) values ($1, $2, $3, $3::timestamptz + interval '1 hour', 'completed', $3, 10000)`, [businessId, customerId, at]);
    await tx.query(`update customers set status = 'active', last_visit_at = (select max(completed_at) from bookings where customer_id = $1) where id = $1`, [customerId]);
  });
}

test('health: regular customers stay healthy; overdue ones drop, with reasons, and get a suggested check-in', async () => {
  const s = await setup();
  const steady = await customer(s, 'Steady');
  const drifting = await customer(s, 'Drift');
  for (const d of [70, 56, 42, 28, 14]) await pastVisit(s.id, steady.id, d);
  for (const d of [100, 86, 72, 58]) await pastVisit(s.id, drifting.id, d); // every 2 weeks, then silence for 58 days
  await tenant(s.id, async (tx) => scoreHealth(tx, await loadBusiness(tx)));
  const rows = await tenant(s.id, (tx) => tx.query(`select first_name, health_score, health_reasons from customers order by first_name`));
  const byName = Object.fromEntries(rows.rows.map((r) => [r.first_name, r]));
  assert.equal(byName.Steady.health_score, 100);
  assert.ok(byName.Drift.health_score < 50, `drift score ${byName.Drift.health_score}`);
  assert.match(byName.Drift.health_reasons[0], /usually every 14/);
  await settle(daytime());
  const drafts = await tenant(s.id, (tx) => tx.query(`select reason from drafts where playbook = 'at_risk_checkin'`));
  assert.equal(drafts.rowCount, 1);
  assert.match(drafts.rows[0].reason, /^At risk:/);
  const risky = await srv.call('GET', '/v1/customers?risk=1', undefined, s.A);
  assert.deepEqual(risky.body.map((c: any) => c.first_name), ['Drift']);
});

test('lapsed customers get one win-back at the right threshold, never three at once', async () => {
  const s = await setup({ playbooks: { win_back: { trust: 'auto' } } });
  const gone = await customer(s, 'Gone');
  await pastVisit(s.id, gone.id, 200);
  const noConsent = await customer(s, 'Quiet', false);
  await pastVisit(s.id, noConsent.id, 200);
  await tenant(s.id, async (tx) => scheduleWinBacks(tx, await loadBusiness(tx)));
  await tenant(s.id, async (tx) => scheduleWinBacks(tx, await loadBusiness(tx)));
  await settle(daytime());
  const sent = s.outbox.filter((m) => m.to === gone.phone);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /If you ever need us again/);
  assert.equal(s.outbox.filter((m) => m.to === noConsent.phone).length, 0, 'marketing needs consent');
});

test('first-visit check-in: a low 1-5 reply is private feedback and suggests an apology; high replies do not change the review ask', async () => {
  const s = await setup({ playbooks: { payment_request: { enabled: false }, review_request: { trust: 'auto', delay_hours: 0 } } });
  const c = await customer(s, 'Fay');
  const bk = await srv.call('POST', '/v1/bookings', { customer_id: c.id, service_key: 'standard', starts_at: new Date(Date.now() - 7200_000).toISOString() }, s.A);
  await srv.call('POST', `/v1/bookings/${bk.body.id}/complete`, {}, s.A);
  await settle(daytime()); // the job completes now; the check-in is scheduled 20 hours later
  await settle(new Date(daytime().getTime() + 21 * 3600_000));
  assert.ok(s.outbox.some((m) => /Reply with a number from 1 to 5/.test(m.body)), 'check-in sent');
  assert.ok(s.outbox.some((m) => /review helps/.test(m.body)), 'review request goes out regardless');
  const r = await tenant(s.id, (tx) => receiveSms(tx, s.id, c.phone, '2'));
  assert.equal(r.action, 'feedback');
  await settle(new Date(daytime().getTime() + 22 * 3600_000));
  const fb = await tenant(s.id, (tx) => tx.query(`select rating, is_private_feedback from reviews`));
  assert.deepEqual(fb.rows[0], { rating: 2, is_private_feedback: true });
  const apology = await tenant(s.id, (tx) => tx.query(`select reason from drafts where playbook = 'first_visit_checkin'`));
  assert.match(apology.rows[0].reason, /Rated their first visit 2\/5/);
  // Later "3" is just a message, not a second rating.
  const again = await tenant(s.id, (tx) => receiveSms(tx, s.id, c.phone, '3'));
  assert.equal(again.action, 'received');
});

test('referrals: share link → friend books with credit off their first invoice → referrer rewarded after the first job', async () => {
  const s = await setup({ playbooks: { payment_request: { trust: 'auto' } } });
  const fan = await customer(s, 'Maria');
  const ref = await srv.call('GET', `/v1/customers/${fan.id}/referral`, undefined, s.A);
  assert.match(ref.body.code, /^MARIA\d{2,3}$/);
  const go = await srv.call('GET', new URL(ref.body.link).pathname);
  assert.equal(go.status, 303);
  assert.match(go.headers.get('location')!, /book\?ref=MARIA/);
  const page = await srv.call('GET', go.headers.get('location')!);
  assert.match(String(page.body), /A friend sent you: \$50 off/);

  // Friend books online through the link.
  const times = await srv.call('GET', `/site/${s.id}/book/time?service=standard&week=1&ref=${ref.body.code}`);
  const at = decodeURIComponent(String(times.body).match(/at=([^"&]+)/)![1]);
  const booked = await srv.call('POST', `/site/${s.id}/book`, `service=standard&ref=${ref.body.code}&at=${encodeURIComponent(at)}&first_name=Nia&phone=5125550888`);
  assert.equal(booked.status, 303);
  const friend = await tenant(s.id, (tx) => tx.query(`select id, source from customers where first_name = 'Nia'`));
  assert.equal(friend.rows[0].source, 'referral');
  const bk = await tenant(s.id, (tx) => tx.query(`select id from bookings where customer_id = $1`, [friend.rows[0].id]));
  await srv.call('POST', `/v1/bookings/${bk.rows[0].id}/complete`, {}, s.A);
  await settle(daytime());
  const inv = await srv.call('GET', `/v1/invoices?customer_id=${friend.rows[0].id}`, undefined, s.A);
  assert.equal(inv.body[0].amount_cents, 10000, '$150 minus $50 friend credit');
  assert.match(inv.body[0].description, /credit applied: \$50/);
  const fanRef = await srv.call('GET', `/v1/customers/${fan.id}/referral`, undefined, s.A);
  assert.equal(fanRef.body.credit_cents, 5000, 'referrer earned $50');
  assert.equal(fanRef.body.referrals[0].status, 'rewarded');
  // A referrer's own credit covers a small invoice fully: marked paid, nothing to collect.
  const small = await srv.call('POST', '/v1/invoices', { customer_id: fan.id, amount_cents: 3000, description: 'Add-on' }, s.A);
  assert.equal(small.body.status, 'paid');
  const left = await srv.call('GET', `/v1/customers/${fan.id}/referral`, undefined, s.A);
  assert.equal(left.body.credit_cents, 2000);
});

test('the Nth visit triggers a referral ask with the customer\'s link', async () => {
  const s = await setup({ playbooks: { payment_request: { enabled: false }, referral_ask: { trust: 'auto', after_visits: 2 }, first_visit_checkin: { enabled: false }, review_request: { enabled: false } } });
  const c = await customer(s, 'Lee');
  for (let i = 0; i < 2; i++) {
    const bk = await srv.call('POST', '/v1/bookings', { customer_id: c.id, service_key: 'standard', starts_at: new Date(Date.now() - (i + 2) * 86400_000).toISOString() }, s.A);
    await srv.call('POST', `/v1/bookings/${bk.body.id}/complete`, {}, s.A);
  }
  await settle(daytime());
  const ask = s.outbox.find((m) => /Share your link/.test(m.body));
  assert.ok(ask);
  assert.match(ask!.body, /\/r\/LEE\d+/);
  void withSystem;
});
