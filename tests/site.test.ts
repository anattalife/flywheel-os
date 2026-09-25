import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { closePool } from '../src/db/pool.js';
import { daytime, freshOutbox, settle, tenant } from './helpers.js';
import { ADMIN, startServer, uniquePhone } from './support.js';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); await closePool(); });

async function business(extra: Record<string, unknown> = {}) {
  const r = await srv.call('POST', '/admin/businesses', {
    name: 'Tidy <Pros>', phone_number: uniquePhone(), timezone: 'America/Chicago',
    pack_overrides: { scheduling: { min_notice_hours: 0, buffer_min: 0 } },
    settings: { site: { headline: 'We clean <script>alert(1)</script> homes', faq: [{ q: 'Do you bring supplies?', a: 'Yes.' }], areas: ['South Austin'] } },
    ...extra,
  }, ADMIN);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.business.id as string, key: r.body.api_key as string };
}

test('home page renders with escaping, structured data and a strict policy', async () => {
  const b = await business();
  const r = await srv.call('GET', `/site/${b.id}`);
  assert.equal(r.status, 200);
  const page = String(r.body);
  assert.match(page, /We clean &lt;script&gt;alert\(1\)&lt;\/script&gt; homes/);
  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /Tidy &lt;Pros&gt;/);
  assert.match(page, /"@type":"FAQPage"/);
  assert.match(page, /href="\/site\/[\w-]+\/book"/);
  assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const css = await srv.call('GET', `/site/${b.id}/theme.css`);
  assert.match(String(css.body), /--accent:#1E6B52/);
  assert.equal((await srv.call('GET', `/site/${b.id}/areas/south-austin`)).status, 200);
  assert.equal((await srv.call('GET', `/site/${b.id}/areas/nowhere`)).status, 404);
  assert.match(String((await srv.call('GET', `/site/${b.id}/privacy`)).body), /Reply STOP to opt out/);
  assert.match(String((await srv.call('GET', `/site/${b.id}/sitemap.xml`)).body), /areas\/south-austin/);
});

test('online booking: pick a service, see times, enter details, booked, confirmation text', async () => {
  const outbox = await freshOutbox();
  const b = await business();
  const quote = await srv.call('POST', `/site/${b.id}/quote`, 'service=hourly&in_minutes=120');
  assert.equal(quote.body.amount_cents, 15000);
  const times = await srv.call('GET', `/site/${b.id}/book/time?service=standard&week=1`);
  assert.equal(times.status, 200);
  const slot = String(times.body).match(/href="(\/site\/[\w-]+\/book\/details\?[^"]+)"/);
  assert.ok(slot, 'at least one open slot next week');
  const detailsUrl = slot![1].replace(/&amp;/g, '&');
  const details = await srv.call('GET', detailsUrl);
  assert.equal(details.status, 200);
  const at = new URL('http://x' + detailsUrl).searchParams.get('at')!;
  const bad = await srv.call('POST', `/site/${b.id}/book`, `service=standard&at=${encodeURIComponent(at)}&first_name=Ana&phone=12345678`);
  assert.match(String(bad.body), /mobile number doesn’t look right/);
  const ok = await srv.call('POST', `/site/${b.id}/book`, `service=standard&at=${encodeURIComponent(at)}&first_name=Ana&last_name=Diaz&phone=5125550400&address=12+Oak+St&notes=Gate+code+1234`);
  assert.equal(ok.status, 303);
  const done = await srv.call('GET', ok.headers.get('location')!);
  assert.match(String(done.body), /You’re booked, Ana/);
  const rows = await tenant(b.id, (tx) => tx.query(`select b.source, b.status, p.address, c.source as found from bookings b join customers c on c.id = b.customer_id left join places p on p.id = b.place_id`));
  assert.deepEqual(rows.rows[0], { source: 'online', status: 'confirmed', address: '12 Oak St', found: 'website' });
  await settle(daytime());
  assert.ok(outbox.some((m) => m.to === '+15125550400' && /You are booked/.test(m.body)), 'confirmation texted');

  // The same slot again is refused and sends the customer back to pick another time.
  const again = await srv.call('POST', `/site/${b.id}/book`, `service=standard&at=${encodeURIComponent(at)}&first_name=Bo&phone=5125550401`);
  assert.equal(again.status, 303);
  assert.match(again.headers.get('location') ?? '', /taken=1/);
});

test('quote-only services go to a request form, which creates a lead', async () => {
  const b = await business();
  const page = await srv.call('GET', `/site/${b.id}/book?service=custom`);
  assert.match(String(page.body), /Get a quote/);
  const sent = await srv.call('POST', `/site/${b.id}/contact`, 'service=custom&first_name=Lu&phone=5125550402&message=Big+job');
  assert.equal(sent.status, 303);
  const lead = await tenant(b.id, (tx) => tx.query(`select source from customers`));
  assert.equal(lead.rows[0].source, 'website_quote');
});

test('a custom domain serves the business site at its root', async () => {
  const b = await business({ custom_domain: 'book.tidypros.test' });
  const get = (host: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(srv.base);
    const req = http.request({ host: u.hostname, port: u.port, path: '/', headers: { host } }, (res) => {
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.end();
  });
  const r = await get('book.tidypros.test');
  assert.equal(r.status, 200);
  assert.match(r.body, /href="\/book"/);
  const unknown = await get('nobody.test');
  assert.equal(unknown.status, 302, 'unknown hosts fall through to the app');
  void b;
});

test('customer portal: see bookings, move one, skip a plan visit, pause and resume, cancel with a reason', async () => {
  const outbox = await freshOutbox();
  const b = await business();
  const A = { authorization: `Bearer ${b.key}` };
  const c = await srv.call('POST', '/v1/customers', { first_name: 'Rosa', phone: '5125550410', sms_consent: true, consent_source: 'verbal' }, A);
  const cid = c.body.customer.id;
  const slots = await srv.call('GET', `/v1/availability?service=standard&days=14`, undefined, A);
  const open = slots.body.flatMap((d: any) => d.slots);
  const one = await srv.call('POST', '/v1/bookings', { customer_id: cid, service_key: 'standard', starts_at: open[open.length - 1] }, A);
  assert.equal(one.status, 201, JSON.stringify(one.body));
  const plan = await srv.call('POST', '/v1/bookings', { customer_id: cid, service_key: 'standard', starts_at: open[2], recurrence_key: 'weekly' }, A);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  await settle(daytime());
  const link = outbox.map((m) => m.body.match(/(\/m\/[\w-]+)/)?.[1]).find(Boolean)!;
  assert.ok(link);
  const home = await srv.call('GET', link);
  assert.equal(home.status, 200);
  assert.match(String(home.body), /Hi Rosa/);
  assert.match(String(home.body), /Your plan/);

  // Move the one-off booking to another open time.
  const movePage = await srv.call('GET', `${link}/b/${one.body.id}/move`);
  const targets = [...String(movePage.body).matchAll(/name="at" value="([^"]+)"/g)].map((m) => m[1]);
  const target = targets[targets.length - 2]; // well beyond the 24-hour change window
  const moved = await srv.call('POST', `${link}/b/${one.body.id}/move`, `at=${encodeURIComponent(target)}`);
  assert.equal(moved.status, 303);
  const after = await tenant(b.id, (tx) => tx.query(`select starts_at from bookings where id = $1`, [one.body.id]));
  assert.equal(new Date(after.rows[0].starts_at).toISOString(), target);

  // Skip the second visit of the plan.
  const visits = await tenant(b.id, (tx) => tx.query(`select id from bookings where series_id = $1 order by starts_at`, [plan.body.series_id]));
  assert.equal((await srv.call('POST', `${link}/b/${visits.rows[1].id}/skip`, '')).status, 303);
  const skipped = await tenant(b.id, (tx) => tx.query(`select skipped from bookings where id = $1`, [visits.rows[1].id]));
  assert.equal(skipped.rows[0].skipped, true);

  // Pause and resume.
  await srv.call('POST', `${link}/s/${plan.body.series_id}/pause`, 'weeks=4');
  assert.match(String((await srv.call('GET', link)).body), /Paused/);
  await srv.call('POST', `${link}/s/${plan.body.series_id}/resume`, '');
  assert.doesNotMatch(String((await srv.call('GET', link)).body), /Paused until/);

  // Cancel the one-off with a reason: recorded for the scorecard.
  await srv.call('POST', `${link}/b/${one.body.id}/cancel`, 'reason=schedule');
  const reason = await tenant(b.id, (tx) => tx.query(`select code from reasons where kind = 'cancel'`));
  assert.equal(reason.rows[0].code, 'schedule');

  // Someone else's booking id through this link is refused.
  const other = await srv.call('POST', '/v1/customers', { first_name: 'Other', phone: '5125550411' }, A);
  const otherBk = await srv.call('POST', '/v1/bookings', { customer_id: other.body.customer.id, service_key: 'standard', starts_at: open[5] }, A);
  assert.equal((await srv.call('POST', `${link}/b/${otherBk.body.id}/cancel`, 'reason=price')).status, 404);
  assert.equal((await srv.call('GET', '/m/not-a-real-token-at-all-000000')).status, 410);
});
