import { z } from 'zod';
import { aiFor } from '../adapters/ai/index.js';
import type { Tx } from '../db/pool.js';
import { PriceRule } from '../packs/schema.js';
import { loadBusiness, updatePackOverrides, type Business } from './business.js';
import { setHours } from './scheduling.js';
import { parseModelJson } from '../playbooks/inbox-assist.js';

const Word = z.object({ one: z.string().min(1).max(30), many: z.string().min(1).max(30) });
export const SetupProposal = z.object({
  vocabulary: z.object({ customer: Word, job: Word, provider: Word, booking_verb: z.string().min(1).max(20).optional() }),
  services: z.array(z.object({ name: z.string().min(1).max(60), description: z.string().max(200).optional(), duration_min: z.number().int().min(5).max(24 * 60), price_rule: PriceRule })).min(1).max(12),
  recurrence: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]+$/), label: z.string().max(40), interval_days: z.number().int().min(1).max(365) })).max(6).default([]),
  hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), opens: z.string().regex(/^\d\d:\d\d$/), closes: z.string().regex(/^\d\d:\d\d$/) })).max(21).optional(),
  headline: z.string().max(90).optional(),
  subline: z.string().max(220).optional(),
  faq: z.array(z.object({ q: z.string().max(200), a: z.string().max(1000) })).max(8).default([]),
});
export type SetupProposal = z.infer<typeof SetupProposal>;

/** From one or two sentences about the business, propose words, services, prices, hours and website copy. */
export async function proposeSetup(business: Business, description: string): Promise<SetupProposal> {
  const ai = aiFor(business.settings);
  if (!ai) throw Object.assign(new Error('Turn on AI in Settings to set up from a description, or add services by hand.'), { status: 409 });
  const out = await ai.complete({
    system: [
      'You set up software for a small service business from the owner\'s description. Reply with JSON only, matching:',
      '{"vocabulary":{"customer":{"one","many"},"job":{"one","many"},"provider":{"one","many"},"booking_verb"},',
      ' "services":[{"name","description","duration_min","price_rule"}], "recurrence":[{"key","label","interval_days"}],',
      ' "hours":[{"weekday":0-6 (0=Sunday),"opens":"HH:MM","closes":"HH:MM"}], "headline", "subline", "faq":[{"q","a"}]}',
      'price_rule is one of {"type":"fixed","amount_cents"}, {"type":"hourly","rate_cents","min_minutes":60,"increment_minutes":15}, {"type":"quote"},',
      ' or {"type":"formula","base_cents","minimum_cents":0,"inputs":[{"kind":"number","key","label","per_unit_cents","min":0,"default":1}]}.',
      'Use prices the owner gave; if none, use typical US prices and keep them round. Use the owner\'s own words for things. Headline: what, where, why them, under 70 characters. 3-4 FAQ entries customers really ask. No emoji.',
    ].join('\n'),
    messages: [{ role: 'user', content: `Business name: ${business.name}\n${description}` }],
    tier: 'strong', maxTokens: 1500,
  });
  const p = SetupProposal.safeParse(parseModelJson(out));
  if (!p.success) throw Object.assign(new Error('The AI\'s suggestion didn\'t come out right. Try describing the business again, a little more specifically.'), { status: 502 });
  return p.data;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'service';

/** Apply a (possibly edited) proposal: words and repeat options into the pack, services, hours and website copy. */
export async function applySetup(tx: Tx, p: SetupProposal) {
  const business = await loadBusiness(tx);
  await updatePackOverrides(tx, {
    vocabulary: { ...p.vocabulary, booking_verb: p.vocabulary.booking_verb ?? 'book' },
    ...(p.recurrence.length ? { recurrence: { enabled: true, options: p.recurrence.map((r) => ({ ...r, discount_pct: 0 })) } } : {}),
  });
  await tx.query(`update services set active = false`);
  for (const [i, s] of p.services.entries()) {
    const key = slug(s.name);
    await tx.query(
      `insert into services (business_id, key, name, description, duration_min, price_rule, position, active) values ($1, $2, $3, $4, $5, $6, $7, true)
       on conflict (business_id, key) do update set name = excluded.name, description = excluded.description, duration_min = excluded.duration_min,
         price_rule = excluded.price_rule, position = excluded.position, active = true`,
      [business.id, key, s.name, s.description ?? null, s.duration_min, s.price_rule, i]);
  }
  if (p.hours?.length) await setHours(tx, business.id, p.hours);
  const site = { ...(business.settings?.site ?? {}), ...(p.headline ? { headline: p.headline } : {}), ...(p.subline ? { subline: p.subline } : {}), ...(p.faq.length ? { faq: p.faq } : {}) };
  await tx.query(`update businesses set settings = jsonb_set(settings, '{site}', $1::jsonb) || jsonb_build_object('onboarding', coalesce(settings->'onboarding', '{}'::jsonb) || '{"described": true}'::jsonb) where id = app_business_id()`, [site]);
}

/** Which setup steps are done, so the owner app can show a short checklist until everything is ready. */
export async function setupStatus(tx: Tx) {
  const b = await loadBusiness(tx);
  const q = async (sql: string) => ((await tx.query(sql)).rowCount ?? 0) > 0;
  const steps = {
    services: b.settings?.onboarding?.described || await q(`select 1 from services where active and key not in ('standard','hourly','custom')`),
    hours: await q(`select 1 from business_hours`),
    website: !!b.settings?.site?.headline,
    customers: await q(`select 1 from customers where source = 'import' limit 1`) || await q(`select 1 from customers offset 4 limit 1`),
    phone: !!b.phone_number,
    forwarding: !!b.settings?.forward_to,
    google: await q(`select 1 from integrations where provider = 'google' and status = 'connected'`),
    payments: await q(`select 1 from invoices limit 1`),
  };
  return { steps, done: Object.values(steps).every(Boolean), dismissed: !!b.settings?.onboarding?.dismissed };
}
