import { z } from 'zod';
import { config } from '../../config.js';
import { storage } from '../../adapters/storage/index.js';
import { withSystem, withTenant } from '../../db/pool.js';
import { encryptJson } from '../../lib/crypto.js';
import { HttpError } from '../../lib/http.js';
import { safeEqual } from '../../lib/secrets.js';
import { systemHealth } from '../../core/ops.js';
import { customersCsv, eraseCustomer, exportBusiness } from '../../core/privacy.js';
import { admin, owner, parse, router } from '../context.js';

/** For an uptime monitor: 200 when healthy, 503 with the problems when not. Needs MONITOR_TOKEN. */
router.add('GET', '/health/deep', async (req) => {
  const token = config().MONITOR_TOKEN;
  if (!token || !safeEqual(req.query.get('token') ?? '', token)) throw new HttpError(404, 'not found');
  const h = await systemHealth();
  return { status: h.ok ? 200 : 503, json: h };
});

router.add('GET', '/v1/export', owner(async (req) => {
  const data = await withTenant(req.businessId, exportBusiness);
  return {
    text: JSON.stringify(data, null, 1), contentType: 'application/json; charset=utf-8',
    headers: { 'content-disposition': `attachment; filename="flywheel-export-${new Date().toISOString().slice(0, 10)}.json"`, 'cache-control': 'no-store' },
  };
}, { ownerOnly: true }));

router.add('GET', '/v1/export/customers.csv', owner(async (req) => ({
  text: await withTenant(req.businessId, customersCsv), contentType: 'text/csv; charset=utf-8',
  headers: { 'content-disposition': 'attachment; filename="customers.csv"', 'cache-control': 'no-store' },
}), { ownerOnly: true }));

router.add('POST', '/v1/customers/:id/erase', owner(async (req) => {
  if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(404, 'not found');
  await withTenant(req.businessId, (tx) => eraseCustomer(tx, req.businessId, req.params.id));
  return { json: { ok: true } };
}, { ownerOnly: true }));

/** Bring your own AI key. Stored encrypted; never shown again, only its last four characters. */
router.add('PATCH', '/v1/business/ai-key', owner(async (req) => {
  const { api_key } = parse(z.object({ api_key: z.string().min(10).max(300).nullable() }), req.body);
  await withTenant(req.businessId, (tx) => api_key
    ? tx.query(`update businesses set settings = settings || jsonb_build_object('ai_key_sealed', $1::text, 'ai_key_last4', $2::text) where id = app_business_id()`, [encryptJson({ key: api_key }), api_key.slice(-4)])
    : tx.query(`update businesses set settings = settings - 'ai_key_sealed' - 'ai_key_last4' where id = app_business_id()`));
  return { json: { ok: true, last4: api_key ? api_key.slice(-4) : null } };
}, { ownerOnly: true }));

/** Remove a business and everything it owns, including stored photos. Cannot be undone. */
router.add('DELETE', '/admin/businesses/:id', admin(async (req) => {
  const id = req.params.id;
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'not found');
  if (req.query.get('confirm') !== id) throw new HttpError(400, 'Add ?confirm=<business id> to confirm. This cannot be undone.');
  const keys = await withTenant(id, async (tx) => (await tx.query<{ storage_key: string }>(`select storage_key from photos`)).rows.map((r) => r.storage_key));
  await withSystem((tx) => tx.query(`select purge_business($1)`, [id]));
  for (const k of keys) await storage().delete(k).catch(() => {});
  return { json: { ok: true, photos_deleted: keys.length } };
}));
