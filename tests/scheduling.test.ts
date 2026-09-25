import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, withSystem } from '../src/db/pool.js';
import { loadBusiness } from '../src/core/business.js';
import { upsertCustomer } from '../src/core/customers.js';
import { createBooking } from '../src/core/bookings.js';
import { availableSlots, pauseSeries, rescheduleBooking, resumeSeries, setHours, skipBooking } from '../src/core/scheduling.js';
import { resolvePortalToken } from '../src/core/portal.js';
import { addLocalDays, localParts, zonedTime } from '../src/lib/tz.js';
import { daytime, freshOutbox, newBusiness, settle, tenant } from './helpers.js';

after(closePool);
const TZ = 'America/Chicago';

/** Next local weekday (Mon=1) at least `minDays` ahead, as YYYY-MM-DD in Chicago. */
function nextWeekday(target: number, minDays = 2) {
  let d = addLocalDays(localParts(new Date(), TZ).date, minDays);
  while (new Date(d + 'T12:00:00Z').getUTCDay() !== target) d = addLocalDays(d, 1);
  return d;
}

async function setup(overrides: Record<string, unknown> = {}) {
  const b = await newBusiness({ pack_overrides: { scheduling: { buffer_min: 0, min_notice_hours: 0, ...overrides } } });
  const customerId = await tenant(b.id, async (tx) => (await upsertCustomer(tx, b.id, { first_name: 'Sam', phone: `51255${String(Math.random()).slice(2, 7)}`, sms_consent: true, consent_source: 'verbal' })).customer.id);
  return { ...b, customerId };
}

test('slots follow opening hours in the business timezone and skip taken times', async () => {
  const b = await setup();
  const monday = nextWeekday(1);
  const nine = zonedTime(monday, '09:00', TZ);
  await tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: nine }));
  const days = await tenant(b.id, async (tx) => availableSlots(tx, await loadBusiness(tx), { durationMin: 60, fromDate: monday, days: 1 }));
  const local = days[0].slots.map((s) => localParts(new Date(s), TZ).time);
  assert.equal(local[0], '08:00');
  assert.ok(!local.includes('09:00') && !local.includes('08:30') && !local.includes('09:30'), 'the booked hour and overlaps are gone');
  assert.ok(local.includes('10:00'));
  assert.equal(local.at(-1), '16:00', 'last 60-minute slot ends at closing (17:00)');
  const sunday = await tenant(b.id, async (tx) => availableSlots(tx, await loadBusiness(tx), { durationMin: 60, fromDate: nextWeekday(0), days: 1 }));
  assert.equal(sunday[0].slots.length, 0, 'closed on Sunday by default');
});

test('travel buffer keeps space between jobs', async () => {
  const b = await setup({ buffer_min: 30 });
  const monday = nextWeekday(1);
  await tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: zonedTime(monday, '10:00', TZ) }));
  const local = (await tenant(b.id, async (tx) => availableSlots(tx, await loadBusiness(tx), { durationMin: 60, fromDate: monday, days: 1 })))[0].slots.map((s) => localParts(new Date(s), TZ).time);
  assert.ok(!local.includes('11:00'), '11:00 is inside the 30 minute buffer');
  assert.ok(local.includes('11:30'));
  assert.ok(!local.includes('09:00'), '09:00-10:00 leaves no travel time before 10:00');
  assert.ok(local.includes('08:30'), '08:30-09:30 leaves exactly 30 minutes');
});

test('double booking is refused; capacity 2 allows two at once; the owner can force', async () => {
  const b = await setup();
  const at = zonedTime(nextWeekday(2), '13:00', TZ);
  await tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: at }));
  await assert.rejects(tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: at })), /just taken/);
  await tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: at, force: true }));
  const two = await setup({ capacity: 2 });
  await tenant(two.id, (tx) => createBooking(tx, two.id, { customer_id: two.customerId, service_key: 'standard', starts_at: at }));
  await tenant(two.id, (tx) => createBooking(tx, two.id, { customer_id: two.customerId, service_key: 'standard', starts_at: at }));
  await assert.rejects(tenant(two.id, (tx) => createBooking(tx, two.id, { customer_id: two.customerId, service_key: 'standard', starts_at: at })));
});

test('online bookings must be inside hours and after the minimum notice', async () => {
  const b = await setup({ min_notice_hours: 12 });
  const monday = nextWeekday(1);
  await assert.rejects(tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: zonedTime(monday, '20:00', TZ), source: 'online' })), /outside opening hours/);
  await assert.rejects(tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: new Date(Date.now() + 3600_000), source: 'online' })), /too soon/);
  await tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: zonedTime(monday, '10:00', TZ), source: 'online' }));
});

test('opening hours can be edited', async () => {
  const b = await setup();
  const sat = nextWeekday(6);
  await tenant(b.id, (tx) => setHours(tx, b.id, [{ weekday: 6, opens: '10:00', closes: '12:00' }]));
  const slots = (await tenant(b.id, async (tx) => availableSlots(tx, await loadBusiness(tx), { durationMin: 60, fromDate: sat, days: 1 })))[0].slots;
  assert.deepEqual(slots.map((s) => localParts(new Date(s), TZ).time), ['10:00', '10:30', '11:00']);
  await assert.rejects(tenant(b.id, (tx) => setHours(tx, b.id, [{ weekday: 1, opens: '12:00', closes: '09:00' }])));
});

test('a recurring plan fills 8 weeks ahead at the same local time, across daylight saving', async () => {
  const b = await setup();
  const first = zonedTime(nextWeekday(2), '10:00', TZ);
  const r = await tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: first, recurrence_key: 'weekly' }));
  const visits = await tenant(b.id, (tx) => tx.query(`select starts_at, status, source from bookings where series_id = $1 order by starts_at`, [r.series_id]));
  assert.ok(visits.rowCount! >= 7 && visits.rowCount! <= 9, `got ${visits.rowCount}`);
  for (const v of visits.rows) assert.equal(localParts(new Date(v.starts_at), TZ).time, '10:00');
  assert.ok(visits.rows.every((v) => v.status === 'confirmed'));
});

test('skip one visit, pause for a month, resume', async () => {
  const b = await setup();
  const first = zonedTime(nextWeekday(3), '11:00', TZ);
  const r = await tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: first, recurrence_key: 'weekly' }));
  const ids = (await tenant(b.id, (tx) => tx.query(`select id from bookings where series_id = $1 order by starts_at`, [r.series_id]))).rows.map((x) => x.id);
  await tenant(b.id, async (tx) => skipBooking(tx, await loadBusiness(tx), ids[1]));
  const skipped = await tenant(b.id, (tx) => tx.query(`select status, skipped from bookings where id = $1`, [ids[1]]));
  assert.deepEqual(skipped.rows[0], { status: 'cancelled', skipped: true });
  const until = new Date(first.getTime() + 29 * 86400_000);
  await tenant(b.id, async (tx) => pauseSeries(tx, await loadBusiness(tx), r.series_id!, until));
  const during = await tenant(b.id, (tx) => tx.query(`select count(*)::int as n from bookings where series_id = $1 and status = 'confirmed' and starts_at > now() and starts_at < $2`, [r.series_id, until]));
  assert.equal(during.rows[0].n, 0);
  await tenant(b.id, async (tx) => resumeSeries(tx, await loadBusiness(tx), r.series_id!));
  const plan = await tenant(b.id, (tx) => tx.query(`select status from series where id = $1`, [r.series_id]));
  assert.equal(plan.rows[0].status, 'active');
  // Resuming does not bring back skipped or paused visits: they were the customer's choice.
  const noShowAgain = await tenant(b.id, (tx) => tx.query(`select count(*)::int as n from bookings where series_id = $1 and starts_at = $2 and status = 'confirmed'`, [r.series_id, zonedTime(addLocalDays(localParts(first, TZ).date, 7), '11:00', TZ)]));
  assert.equal(noShowAgain.rows[0].n, 0);
});

test('confirmation and reminder texts carry a working manage link; moving a booking re-times the reminder', async () => {
  const outbox = await freshOutbox();
  const b = await setup();
  const at = zonedTime(nextWeekday(4, 3), '14:00', TZ);
  const bk = await tenant(b.id, (tx) => createBooking(tx, b.id, { customer_id: b.customerId, service_key: 'standard', starts_at: at }));
  await settle(daytime()); // texts wait for business hours if it's night right now
  const confirmation = outbox.find((m) => /You are booked/.test(m.body));
  assert.ok(confirmation, 'confirmation sent');
  const token = confirmation!.body.match(/\/m\/([\w-]+)/)![1];
  const who = await resolvePortalToken(token);
  assert.equal(who?.customerId, b.customerId);

  const moved = new Date(at.getTime() + 86400_000);
  await tenant(b.id, async (tx) => rescheduleBooking(tx, await loadBusiness(tx), bk.id, moved, { enforceHours: false, by: 'owner' }));
  await settle(daytime());
  // Old reminder time: nothing is sent, because the booking moved.
  const before = outbox.length;
  await settle(new Date(at.getTime() - 24 * 3600_000 + 60_000));
  assert.equal(outbox.filter((m) => /Reminder/.test(m.body)).length, 0);
  // New reminder time: one reminder.
  await settle(new Date(moved.getTime() - 24 * 3600_000 + 60_000));
  const reminders = outbox.slice(before).filter((m) => /Reminder/.test(m.body));
  assert.equal(reminders.length, 1);
  const jobs = await withSystem((tx) => tx.query(`select count(*)::int as n from jobs where dedupe_key like $1`, [`reminder:${bk.id}:%`]));
  assert.equal(jobs.rows[0].n, 2);
});
