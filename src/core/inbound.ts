import type { Tx } from '../db/pool.js';
import { keyword } from '../guardrails/messaging.js';
import { setOptOut, upsertCustomer, type NewCustomer } from './customers.js';
import { emit } from './events.js';
import { toE164 } from '../lib/phone.js';
import { loadBusiness } from './business.js';
import { handleOwnerText } from './commands.js';

/** An inbound text: record it, honor STOP/START, otherwise hand it to the playbooks. */
export async function receiveSms(tx: Tx, businessId: string, from: string, body: string, providerId?: string): Promise<{ customerId: string | null; action: string }> {
  // Texts from the owner's own phone are commands, not customer messages.
  const owner = (await tx.query<{ id: string; phone: string }>(`select id, phone from users where phone = $1 limit 1`, [toE164(from)])).rows[0];
  if (owner) {
    await handleOwnerText(tx, await loadBusiness(tx), owner, body);
    return { customerId: null, action: 'owner_command' };
  }
  const { customer } = await upsertCustomer(tx, businessId, { phone: from, source: 'inbound_text' });
  const m = await tx.query<{ id: string }>(
    `insert into messages (business_id, customer_id, direction, channel, body, status, provider_id) values ($1, $2, 'in', 'sms', $3, 'received', $4) returning id`,
    [businessId, customer.id, body, providerId ?? null],
  );
  const kw = keyword(body);
  if (kw === 'stop') {
    await setOptOut(tx, businessId, customer.id, true);
    return { customerId: customer.id, action: 'opted_out' as const };
  }
  if (kw === 'start' && customer.sms_opted_out) {
    await setOptOut(tx, businessId, customer.id, false);
    return { customerId: customer.id, action: 'opted_in' as const };
  }
  // A bare 1-5 soon after we asked "how did it go?" is private feedback, not a chat message.
  const rating = body.trim().match(/^([1-5])(\s*(stars?|\/\s*5))?[.!]?$/i);
  if (rating) {
    const asked = await tx.query(
      `select 1 from messages where customer_id = $1 and direction = 'out' and playbook = 'first_visit_checkin' and status in ('sent','delivered') and created_at > now() - interval '7 days'
         and not exists (select 1 from reviews where customer_id = $1 and is_private_feedback and created_at > now() - interval '7 days') limit 1`, [customer.id]);
    if (asked.rowCount) {
      const r = await tx.query<{ id: string }>(`insert into reviews (business_id, customer_id, platform, rating, is_private_feedback) values ($1, $2, 'sms', $3, true) returning id`, [businessId, customer.id, Number(rating[1])]);
      await emit(tx, businessId, 'feedback.received', { type: 'review', id: r.rows[0].id }, { customer_id: customer.id, rating: Number(rating[1]) });
      return { customerId: customer.id, action: 'feedback' as const };
    }
  }
  await emit(tx, businessId, 'message.received', { type: 'message', id: m.rows[0].id }, { customer_id: customer.id, channel: 'sms' });
  return { customerId: customer.id, action: 'received' as const };
}

/** A call nobody answered: record it and let the text-back playbook respond. */
export async function recordMissedCall(tx: Tx, businessId: string, from: string, callSid?: string) {
  const { customer } = await upsertCustomer(tx, businessId, { phone: from, source: 'phone' });
  const m = await tx.query<{ id: string }>(
    `insert into messages (business_id, customer_id, direction, channel, body, status, provider_id) values ($1, $2, 'in', 'voice', 'Missed call', 'missed', $3) returning id`,
    [businessId, customer.id, callSid ?? null],
  );
  await emit(tx, businessId, 'call.missed', { type: 'message', id: m.rows[0].id }, { customer_id: customer.id });
  return { customerId: customer.id };
}

/** A website form: create or update the customer (first-touch source kept) and raise a lead. */
export async function receiveLead(tx: Tx, businessId: string, input: NewCustomer & { message?: string | null }) {
  const { customer, created } = await upsertCustomer(tx, businessId, { ...input, consent_source: input.sms_consent ? 'web_form' : undefined }, { untrusted: true });
  // Always recorded: submitting the form is contact, so an instant reply is welcome even at night.
  await tx.query(`insert into messages (business_id, customer_id, direction, channel, body, status) values ($1, $2, 'in', 'web', $3, 'received')`,
    [businessId, customer.id, input.message?.trim() || 'Sent the website form']);
  await emit(tx, businessId, 'lead.created', { type: 'customer', id: customer.id }, { source: input.source ?? 'website', new_customer: created });
  return { customerId: customer.id, created };
}
