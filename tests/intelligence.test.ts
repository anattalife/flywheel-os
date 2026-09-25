import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db/pool.js';
import { setAiFactoryForTests } from '../src/adapters/ai/index.js';
import { loadBusiness } from '../src/core/business.js';
import { receiveSms } from '../src/core/inbound.js';
import { approveDraft } from '../src/core/messaging.js';
import { runDueJobs } from '../src/worker/runner.js';
import { daytime, freshOutbox, settle, tenant } from './helpers.js';
import { ADMIN, startServer, uniquePhone } from './support.js';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); await closePool(); setAiFactoryForTests(undefined); });

const OWNER_PHONE = () => `+1512${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

async function setup(settings: Record<string, unknown> = {}) {
  const outbox = await freshOutbox();
  const ownerPhone = OWNER_PHONE();
  const r = await srv.call('POST', '/admin/businesses', {
    name: 'Smart Co', phone_number: uniquePhone(), settings, pack_overrides: { scheduling: { min_notice_hours: 0, buffer_min: 0 } },
    owner: { email: `s${Date.now()}${Math.random()}@x.com`, password: 'long enough password', phone: ownerPhone },
  }, ADMIN);
  const A = { authorization: `Bearer ${r.body.api_key}` };
  return { id: r.body.business.id as string, A, outbox, ownerPhone };
}

test('owner texts: help, today, drafts and approve by number', async () => {
  const s = await setup();
  await tenant(s.id, (tx) => receiveSms(tx, s.id, s.ownerPhone, 'help'));
  assert.match(s.outbox.at(-1)!.body, /today - your day at a glance/);
  assert.equal(s.outbox.at(-1)!.to, s.ownerPhone);
  await tenant(s.id, (tx) => receiveSms(tx, s.id, s.ownerPhone, 'today'));
  assert.match(s.outbox.at(-1)!.body, /Good morning! Smart Co today/);
  // A customer's missed call creates a draft (trust draft), which the owner approves by text.
  await srv.call('PATCH', '/v1/business/pack', { playbooks: { missed_call_textback: { trust: 'draft' } } }, s.A);
  await srv.call('POST', '/webhooks/twilio/voice/dial-result', `From=%2B15125550700&To=${encodeURIComponent((await srv.call('GET', '/v1/business', undefined, s.A)).body.phone_number)}&DialCallStatus=no-answer`);
  await settle(new Date(Date.now() + 1000));
  await tenant(s.id, (tx) => receiveSms(tx, s.id, s.ownerPhone, 'drafts'));
  assert.match(s.outbox.at(-1)!.body, /^1\) To /);
  await tenant(s.id, (tx) => receiveSms(tx, s.id, s.ownerPhone, 'approve 1'));
  assert.match(s.outbox.at(-1)!.body, /Approved 1 of 1/);
  await settle(new Date(Date.now() + 2000));
  assert.ok(s.outbox.some((m) => m.to === '+15125550700' && /missed your call/.test(m.body)));
  const customers = await tenant(s.id, (tx) => tx.query(`select 1 from customers where phone = $1`, [s.ownerPhone]));
  assert.equal(customers.rowCount, 0, 'the owner is never filed as a customer');
});

test('owner texts in plain words (AI): move a booking, confirmed with YES', async () => {
  const s = await setup({ ai: { provider: 'anthropic' } });
  const c = await srv.call('POST', '/v1/customers', { first_name: 'Maria', last_name: 'Lopez', phone: '5125550711', sms_consent: true, consent_source: 'verbal' }, s.A);
  const start = new Date(Date.now() + 3 * 86400_000); start.setUTCHours(15, 0, 0, 0);
  const bk = await srv.call('POST', '/v1/bookings', { customer_id: c.body.customer.id, service_key: 'standard', starts_at: start.toISOString() }, s.A);
  const target = new Date(start.getTime() + 86400_000);
  const localTarget = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(target).replace(', ', 'T');
  setAiFactoryForTests((ch) => ch.provider === 'none' ? null : { name: 'fake', async complete() { return JSON.stringify({ intent: 'move_booking', booking_id: bk.body.id, new_start_local: localTarget }); } });
  await tenant(s.id, (tx) => receiveSms(tx, s.id, s.ownerPhone, 'move Maria to the next day same time'));
  assert.match(s.outbox.at(-1)!.body, /Move Maria from [\s\S]*Reply YES/);
  const before = await tenant(s.id, (tx) => tx.query(`select starts_at from bookings where id = $1`, [bk.body.id]));
  assert.equal(new Date(before.rows[0].starts_at).toISOString(), start.toISOString(), 'nothing changes before YES');
  await tenant(s.id, (tx) => receiveSms(tx, s.id, s.ownerPhone, 'YES'));
  assert.match(s.outbox.at(-1)!.body, /^Done\. Moved/);
  const after = await tenant(s.id, (tx) => tx.query(`select starts_at from bookings where id = $1`, [bk.body.id]));
  assert.equal(new Date(after.rows[0].starts_at).toISOString(), target.toISOString());
  await tenant(s.id, (tx) => receiveSms(tx, s.id, s.ownerPhone, 'yes'));
  assert.match(s.outbox.at(-1)!.body, /Nothing is waiting/);
  setAiFactoryForTests(undefined);
});

test('AI proposes a booking from a customer text; it only happens when the owner approves, and only at a real open time', async () => {
  const s = await setup({ ai: { provider: 'anthropic' } });
  let offered: string | null = null;
  setAiFactoryForTests((ch) => ch.provider === 'none' ? null : { name: 'fake', async complete(req) {
    offered = req.system.match(/- (\d{4}-\d\d-\d\dT[\d:.]+Z)/)?.[1] ?? null;
    return `Sure! {"reply": "You're booked. See you then!", "action": {"type": "book", "service_key": "standard", "starts_at": "${offered}"}}`;
  } });
  await tenant(s.id, (tx) => receiveSms(tx, s.id, '+15125550720', 'Can I get a standard visit this week?'));
  await settle(new Date(Date.now() + 1000));
  const drafts = await tenant(s.id, (tx) => tx.query(`select id, body, action, reason from drafts where playbook = 'inbox_assist'`));
  assert.equal(drafts.rowCount, 1);
  assert.equal(drafts.rows[0].body, "You're booked. See you then!");
  assert.equal(drafts.rows[0].action.type, 'book');
  assert.match(drafts.rows[0].reason, /^Book Standard visit/);
  assert.equal((await tenant(s.id, (tx) => tx.query(`select 1 from bookings`))).rowCount, 0, 'nothing booked yet');
  await tenant(s.id, (tx) => approveDraft(tx, s.id, drafts.rows[0].id));
  const b = await tenant(s.id, (tx) => tx.query(`select starts_at, source from bookings`));
  assert.equal(b.rows[0].source, 'ai');
  assert.equal(new Date(b.rows[0].starts_at).toISOString(), offered);

  // A made-up time is dropped: the reply stays a draft with no action.
  setAiFactoryForTests((ch) => ch.provider === 'none' ? null : { name: 'fake', async complete() { return '{"reply": "Booked for 3am!", "action": {"type": "book", "service_key": "standard", "starts_at": "2030-01-01T09:00:00.000Z"}}'; } });
  await tenant(s.id, (tx) => receiveSms(tx, s.id, '+15125550721', 'Book me 3am please'));
  await settle(new Date(Date.now() + 2000));
  const d2 = await tenant(s.id, (tx) => tx.query(`select action from drafts d join customers c on c.id = d.customer_id where c.phone = '+15125550721'`));
  assert.equal(d2.rows[0].action, null);
  setAiFactoryForTests(undefined);
});

test('insights: dollar impact on the bottleneck, capacity forecast, earned autonomy', async () => {
  const s = await setup();
  await tenant(s.id, async (tx) => {
    // Previous 30 days: 10 leads, 8 booked. Last 30 days: 10 leads, 3 booked.
    for (let i = 0; i < 20; i++) {
      const recent = i < 10;
      const at = new Date(Date.now() - (recent ? 5 : 40) * 86400_000);
      const c = await tx.query<{ id: string }>(`insert into customers (business_id, first_name, phone, created_at) values ($1, $2, $3, $4) returning id`, [s.id, `L${i}`, `+1512555${String(1000 + i)}`, at]);
      await tx.query(`insert into events (business_id, type, subject_type, subject_id, occurred_at) values ($1, 'lead.created', 'customer', $2, $3)`, [s.id, c.rows[0].id, at]);
      if ((recent && i < 3) || (!recent && i < 18)) await tx.query(`insert into bookings (business_id, customer_id, starts_at, ends_at, status, completed_at, price_cents, created_at) values ($1, $2, $3, $3::timestamptz + interval '1 hour', 'completed', $3, 20000, $3)`, [s.id, c.rows[0].id, at]);
    }
    for (const code of ['price', 'price', 'timing']) await tx.query(`insert into reasons (business_id, kind, code) values ($1, 'lost_quote', $2)`, [s.id, code]);
  });
  await tenant(s.id, (tx) => tx.query(`delete from jobs`).catch(() => null));
  const r = await srv.call('GET', '/v1/insights', undefined, s.A);
  assert.equal(r.body.bottleneck.metric, 'lead_to_booking');
  assert.equal(r.body.bottleneck.impact_cents, 100000, '(80% - 30%) x 10 leads x $200');
  assert.match(r.body.bottleneck.hints[0], /Price: 2 of 3 lost quotes/);
  assert.equal(r.body.capacity.weeks.length, 4);
  assert.ok(r.body.capacity.advice);

  // Ten unchanged approvals of review requests → suggestion → accept → now automatic.
  await tenant(s.id, async (tx) => {
    for (let i = 0; i < 10; i++) await tx.query(`insert into events (business_id, type, data) values ($1, 'draft.approved', '{"playbook":"review_request","edited":false}')`, [s.id]);
  });
  const again = await srv.call('GET', '/v1/insights', undefined, s.A);
  assert.deepEqual(again.body.autonomy, [{ playbook: 'review_request', approved_unchanged: 10 }]);
  await srv.call('POST', '/v1/autonomy/accept', { playbook: 'review_request' }, s.A);
  const b = await tenant(s.id, (tx) => loadBusiness(tx));
  assert.equal(b.pack.playbooks.review_request.trust, 'auto');
});

test('the morning brief is queued for the owner and texted at their hour', async () => {
  const s = await setup();
  await tenant(s.id, (tx) => tx.query(`insert into jobs (business_id, type, payload) values ($1, 'daily_maintenance', '{}')`, [s.id]));
  await runDueJobs({ now: new Date() });
  const job = await tenant(s.id, (tx) => tx.query(`select run_at from jobs where type = 'owner_brief'`));
  assert.equal(job.rowCount, 1);
  await runDueJobs({ now: new Date(new Date(job.rows[0].run_at).getTime() + 1000) });
  assert.ok(s.outbox.some((m) => m.to === s.ownerPhone && /Good morning/.test(m.body)));
  void daytime;
});
