import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePack } from '../src/packs/registry.js';
import { priceService } from '../src/packs/pricing.js';
import { generalService } from '../src/packs/general-service.js';
import { render } from '../src/lib/template.js';
import { inQuietHours, nextAllowedTime } from '../src/lib/time.js';

test('general pack resolves with defaults filled in', () => {
  const p = resolvePack({ packId: 'general-service' });
  assert.equal(p.vocabulary.customer.one, 'customer');
  assert.equal(p.playbooks.review_request.delay_hours, 2);
  assert.equal(p.guardrails.max_automated_per_week, 3);
});

test('owner overrides change words and timing without touching code', () => {
  const p = resolvePack({ packId: 'general-service', overrides: {
    vocabulary: { customer: { one: 'member', many: 'members' }, job: { one: 'class', many: 'classes' } },
    playbooks: { lead_response: { follow_up_days: [2, 5] } },
  } });
  assert.equal(p.vocabulary.customer.many, 'members');
  assert.equal(p.vocabulary.provider.one, 'team member');
  assert.deepEqual(p.playbooks.lead_response.follow_up_days, [2, 5]);
});

test('a fully custom pack works and a broken one is rejected', () => {
  const custom = structuredClone(generalService);
  custom.id = 'my-custom-trade';
  custom.services = [{ key: 'visit', name: 'Visit', duration_min: 45, price_rule: { type: 'formula', base_cents: 5000,
    inputs: [{ kind: 'number', key: 'units', label: 'Units', per_unit_cents: 2500 }] } }];
  assert.equal(resolvePack({ custom }).id, 'my-custom-trade');
  assert.throws(() => resolvePack({ packId: 'general-service', overrides: { key_metric: { key: 'not_a_metric' } } }));
  assert.throws(() => resolvePack({ packId: 'nope' }));
});

test('pricing: fixed, hourly rounding, formula inputs, recurrence discount, quote', () => {
  assert.equal(priceService({ type: 'fixed', amount_cents: 15000 }).amount_cents, 15000);
  assert.equal(priceService({ type: 'hourly', rate_cents: 6000, min_minutes: 60, increment_minutes: 15 }, { minutes: 70 }).amount_cents, 7500);
  assert.equal(priceService({ type: 'hourly', rate_cents: 6000, min_minutes: 60, increment_minutes: 15 }, { minutes: 20 }).amount_cents, 6000);
  const formula = { type: 'formula' as const, base_cents: 8000, minimum_cents: 0, inputs: [
    { kind: 'number' as const, key: 'rooms', label: 'Rooms', per_unit_cents: 2000, min: 1, max: 10, default: 1 },
    { kind: 'select' as const, key: 'size', label: 'Size', options: [{ key: 's', label: 'Small', add_cents: 0 }, { key: 'l', label: 'Large', add_cents: 3000 }] },
  ] };
  assert.equal(priceService(formula, { rooms: 3, size: 'l' }).amount_cents, 8000 + 6000 + 3000);
  assert.equal(priceService(formula, { rooms: 99 }).amount_cents, 8000 + 20000);
  const q = priceService(formula, { rooms: 2 }, { key: 'w', label: 'Weekly', interval_days: 7, discount_pct: 10 });
  assert.equal(q.amount_cents, 10800);
  assert.equal(priceService({ type: 'quote' }).needs_owner_quote, true);
});

test('templates render values and fallbacks', () => {
  assert.equal(render('Hi {{customer.first_name|there}}, from {{business.name}}', { customer: {}, business: { name: 'Acme' } }), 'Hi there, from Acme');
  assert.equal(render('Hi {{customer.first_name|there}}!', { customer: { first_name: 'Ana' } }), 'Hi Ana!');
});

test('quiet hours wrap past midnight in the business timezone', () => {
  const quiet = { start: '20:00', end: '08:00' };
  const tz = 'America/Chicago';
  const lateNight = new Date('2026-06-10T04:00:00Z'); // 23:00 CDT
  const afternoon = new Date('2026-06-10T20:00:00Z'); // 15:00 CDT
  assert.equal(inQuietHours(lateNight, tz, quiet), true);
  assert.equal(inQuietHours(afternoon, tz, quiet), false);
  assert.equal(nextAllowedTime(lateNight, tz, quiet).toISOString(), '2026-06-10T13:00:00.000Z'); // 08:00 CDT
});
