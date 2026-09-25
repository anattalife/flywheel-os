import type { Tx } from '../db/pool.js';
import { toE164 } from '../lib/phone.js';
import { emit } from './events.js';

export interface Customer {
  id: string;
  business_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  sms_consent: boolean;
  sms_opted_out: boolean;
  status: 'lead' | 'active' | 'lapsed' | 'lost';
  source: string | null;
  created_at: Date;
  last_visit_at: Date | null;
}

const COLS = `id, business_id, first_name, last_name, phone, email, sms_consent, sms_opted_out, status, source, created_at, last_visit_at`;

export async function getCustomer(tx: Tx, id: string): Promise<Customer | null> {
  const r = await tx.query<Customer>(`select ${COLS} from customers where id = $1`, [id]);
  return r.rows[0] ?? null;
}

export interface NewCustomer {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
  sms_consent?: boolean;
  consent_source?: string;
  source?: string;
  source_detail?: Record<string, unknown>;
  notes?: string | null;
}

/**
 * Find a customer by phone or email, or create one. Source is first-touch: it is
 * set on creation and never overwritten. Consent is only ever upgraded here.
 */
export async function upsertCustomer(tx: Tx, businessId: string, input: NewCustomer, opts: { untrusted?: boolean } = {}): Promise<{ customer: Customer; created: boolean }> {
  const phone = toE164(input.phone ?? null);
  let email = input.email?.trim().toLowerCase() || null;
  if (!phone && !email && !input.first_name) throw new Error('a customer needs a phone, email or name');
  if (opts.untrusted) {
    // A public form proves nothing about who is typing. Match only on the phone
    // messages go to, never write new contact details onto an existing record,
    // and never borrow an email that already belongs to someone else.
    const match = phone
      ? (await tx.query<Customer>(`select ${COLS} from customers where phone = $1`, [phone])).rows[0]
      : email ? (await tx.query<Customer>(`select ${COLS} from customers where email = $1 and phone is null`, [email])).rows[0] : undefined;
    if (match) {
      const r = await tx.query<Customer>(
        `update customers set
           sms_consent = sms_consent or ($2 and not sms_opted_out),
           sms_consent_at = case when not sms_consent and $2 and not sms_opted_out then now() else sms_consent_at end,
           sms_consent_source = case when not sms_consent and $2 and not sms_opted_out then $3 else sms_consent_source end
         where id = $1 returning ${COLS}`, [match.id, input.sms_consent ?? false, input.consent_source ?? null]);
      return { customer: r.rows[0], created: false };
    }
    if (email && (await tx.query(`select 1 from customers where email = $1`, [email])).rowCount) email = null;
    return insertCustomer(tx, businessId, { ...input, phone, email });
  }
  const existing = phone || email
    ? (await tx.query<Customer>(`select ${COLS} from customers where ($1::text is not null and phone = $1) or ($2::text is not null and email = $2) limit 1`, [phone, email])).rows[0]
    : undefined;
  if (existing) {
    const r = await tx.query<Customer>(
      `update customers set
         first_name = coalesce(first_name, $2), last_name = coalesce(last_name, $3),
         phone = coalesce(phone, $4), email = coalesce(email, $5),
         sms_consent = sms_consent or ($6 and not sms_opted_out),
         sms_consent_at = case when not sms_consent and $6 and not sms_opted_out then now() else sms_consent_at end,
         sms_consent_source = case when not sms_consent and $6 and not sms_opted_out then $7 else sms_consent_source end
       where id = $1 returning ${COLS}`,
      [existing.id, input.first_name ?? null, input.last_name ?? null, phone, email, input.sms_consent ?? false, input.consent_source ?? null],
    );
    return { customer: r.rows[0], created: false };
  }
  return insertCustomer(tx, businessId, { ...input, phone, email });
}

async function insertCustomer(tx: Tx, businessId: string, input: NewCustomer & { phone: string | null; email: string | null }) {
  const { phone, email } = input;
  const r = await tx.query<Customer>(
    `insert into customers (business_id, first_name, last_name, phone, email, sms_consent, sms_consent_at, sms_consent_source, source, source_detail, notes)
     values ($1, $2, $3, $4, $5, $6, case when $6 then now() end, case when $6 then $7 end, $8, $9, $10)
     returning ${COLS}`,
    [businessId, input.first_name ?? null, input.last_name ?? null, phone, email, input.sms_consent ?? false,
      input.consent_source ?? null, input.source ?? 'unknown', input.source_detail ?? {}, input.notes ?? null],
  );
  await emit(tx, businessId, 'customer.created', { type: 'customer', id: r.rows[0].id }, { source: input.source ?? 'unknown' });
  return { customer: r.rows[0], created: true };
}

/** STOP / START handling. Opt-out always wins over any stored consent. */
export async function setOptOut(tx: Tx, businessId: string, customerId: string, optedOut: boolean) {
  await tx.query(
    `update customers set sms_opted_out = $2, sms_consent = case when $2 then false else sms_consent end where id = $1`,
    [customerId, optedOut],
  );
  await emit(tx, businessId, 'customer.consent_changed', { type: 'customer', id: customerId }, { sms_opted_out: optedOut });
}
