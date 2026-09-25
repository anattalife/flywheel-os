import { storage } from '../adapters/storage/index.js';
import type { Tx } from '../db/pool.js';
import { emit } from './events.js';

const TABLES = ['customers', 'places', 'staff', 'services', 'business_hours', 'time_off', 'series', 'bookings', 'messages', 'drafts',
  'invoices', 'payments', 'credits', 'reviews', 'referrals', 'reasons', 'photos', 'gbp_posts', 'ai_checks', 'insights'] as const;

/** Everything this business has, as plain JSON. Secrets (password hashes, tokens, keys) are left out. */
export async function exportBusiness(tx: Tx) {
  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), format: 'flywheel-export-v1' };
  out.business = (await tx.query(`select id, name, pack_id, pack, timezone, phone_number, custom_domain, review_url, settings - 'ai_key_sealed' as settings, created_at from businesses where id = app_business_id()`)).rows[0];
  out.users = (await tx.query(`select id, email, name, phone, role, created_at, last_login_at from users`)).rows;
  for (const t of TABLES) out[t] = (await tx.query(`select * from ${t}`)).rows;
  return out;
}

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // Spreadsheets run cells starting with these as formulas; names come from public forms.
  if (/^[=+\-@\t\r]/.test(s) && !/^\+1\d{10}$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export async function customersCsv(tx: Tx) {
  const rows = (await tx.query(`select first_name, last_name, phone, email, status, source, sms_consent, sms_opted_out, email_consent, last_visit_at, created_at, notes from customers order by created_at`)).rows;
  const cols = ['first_name', 'last_name', 'phone', 'email', 'status', 'source', 'sms_consent', 'sms_opted_out', 'email_consent', 'last_visit_at', 'created_at', 'notes'];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

/**
 * A customer asked to be forgotten: remove who they are, keep the anonymous
 * business records (amounts, dates) that bookkeeping and taxes need.
 */
export async function eraseCustomer(tx: Tx, businessId: string, customerId: string) {
  const c = await tx.query(`select 1 from customers where id = $1`, [customerId]);
  if (!c.rowCount) throw Object.assign(new Error('customer not found'), { status: 404 });
  const photos = (await tx.query<{ storage_key: string }>(`delete from photos where customer_id = $1 returning storage_key`, [customerId])).rows;
  for (const p of photos) await storage().delete(p.storage_key).catch(() => {});
  await tx.query(`update customers set first_name = 'Deleted', last_name = null, phone = null, email = null, notes = null, tags = '{}',
    source_detail = '{}', stripe_customer_id = null, default_payment_method = null, card_brand = null, card_last4 = null, referral_code = null,
    sms_consent = false, email_consent = false, sms_opted_out = true, health_reasons = '{}' where id = $1`, [customerId]);
  await tx.query(`update places set address = null, access_notes = null, details = '{}', label = null where customer_id = $1`, [customerId]);
  await tx.query(`update messages set body = '[removed]', media_urls = '{}' where customer_id = $1`, [customerId]);
  await tx.query(`delete from drafts where customer_id = $1`, [customerId]);
  await tx.query(`update reviews set body = null, reviewer_name = null where customer_id = $1 and is_private_feedback`, [customerId]);
  await tx.query(`update bookings set notes = null, inputs = '{}' where customer_id = $1`, [customerId]);
  await tx.query(`update reasons set note = null where customer_id = $1`, [customerId]);
  await emit(tx, businessId, 'customer.erased', { type: 'customer', id: customerId });
}
