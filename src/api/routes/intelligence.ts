import { z } from 'zod';
import { withTenant } from '../../db/pool.js';
import { HttpError } from '../../lib/http.js';
import { loadBusiness, updatePackOverrides } from '../../core/business.js';
import { autonomySuggestions, bottleneckDetail, capacityForecast, dailyBrief, reasonsSummary } from '../../core/intelligence.js';
import { scorecard } from '../../core/scorecard.js';
import { owner, parse, router } from '../context.js';

router.add('GET', '/v1/insights', owner(async (req) => ({
  json: await withTenant(req.businessId, async (tx) => {
    const b = await loadBusiness(tx);
    const card = await scorecard(tx, new Date(), 30);
    return {
      bottleneck: card.bottleneck ? { ...card.bottleneck, ...(await bottleneckDetail(tx, b, card)) } : null,
      capacity: await capacityForecast(tx, b),
      autonomy: await autonomySuggestions(tx, b),
    };
  }),
})));

router.add('GET', '/v1/insights/reasons', owner(async (req) => ({
  json: await withTenant(req.businessId, async (tx) => {
    const saved = (await tx.query(`select body, created_at from insights where kind = 'reasons' order by created_at desc limit 1`)).rows[0];
    return saved ? { ...saved.body, created_at: saved.created_at } : null;
  }),
})));

router.add('POST', '/v1/insights/reasons', owner(async (req) => {
  const b = parse(z.object({ days: z.number().int().min(7).max(365).optional() }), req.body);
  return { json: await withTenant(req.businessId, async (tx) => reasonsSummary(tx, await loadBusiness(tx), b.days ?? 90)) };
}));

router.add('GET', '/v1/brief', owner(async (req) => ({
  json: { text: await withTenant(req.businessId, async (tx) => dailyBrief(tx, await loadBusiness(tx))) },
})));

/** Accept an earned-autonomy suggestion: that playbook now sends on its own. */
router.add('POST', '/v1/autonomy/accept', owner(async (req) => {
  const { playbook } = parse(z.object({ playbook: z.string().regex(/^[a-z_]+$/) }), req.body);
  return {
    json: await withTenant(req.businessId, async (tx) => {
      const b = await loadBusiness(tx);
      if (!(playbook in b.pack.playbooks)) throw new HttpError(404, 'unknown automation');
      const pack = await updatePackOverrides(tx, { playbooks: { [playbook]: { trust: 'auto' } } });
      return { playbook, trust: (pack.playbooks as Record<string, { trust: string }>)[playbook].trust };
    }),
  };
}, { ownerOnly: true }));

const Me = z.object({
  name: z.string().max(80).optional(),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'use E.164 format, e.g. +15125550100').nullable().optional(),
  notify_brief: z.boolean().optional(),
  brief_hour: z.number().int().min(0).max(23).optional(),
}).strict();

router.add('GET', '/v1/me', owner(async (req) => {
  if (!req.userId) throw new HttpError(400, 'Sign in as a person to see your profile.');
  return { json: (await withTenant(req.businessId, (tx) => tx.query(`select id, email, name, phone, role, notify_brief, brief_hour from users where id = $1`, [req.userId]))).rows[0] };
}));

router.add('PATCH', '/v1/me', owner(async (req) => {
  if (!req.userId) throw new HttpError(400, 'Sign in as a person to change your profile.');
  const m = parse(Me, req.body);
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `update users set name = coalesce($2, name), phone = case when $3 then $4 else phone end,
       notify_brief = coalesce($5, notify_brief), brief_hour = coalesce($6, brief_hour)
     where id = $1 returning id, email, name, phone, role, notify_brief, brief_hour`,
    [req.userId, m.name ?? null, 'phone' in m, m.phone ?? null, m.notify_brief ?? null, m.brief_hour ?? null]));
  return { json: r.rows[0] };
}));
