import { config } from '../config.js';
import { messaging } from '../adapters/messaging/index.js';
import type { Tx } from '../db/pool.js';
import { checkOutbound, type MessageKind } from '../guardrails/messaging.js';
import type { Trust } from '../packs/schema.js';
import { links, loadBusiness, type Business } from './business.js';
import { email } from '../adapters/email/index.js';
import { sign } from '../lib/sign.js';
import { getCustomer, type Customer } from './customers.js';
import { executeAction, type DraftAction } from './actions.js';
import { emit } from './events.js';
import { enqueue, type Job } from './jobs.js';

export interface OutboundRequest {
  customerId: string;
  body: string;
  kind: MessageKind;
  playbook: string | null;   // null = typed by the owner
  trust: Trust;              // suggest | draft -> owner approves; auto -> sent
  reason?: string;           // shown to the owner next to a draft
}

/**
 * The single door every outbound message goes through. Depending on trust it
 * becomes a draft for the owner, or is queued for delivery. Delivery (and all
 * guardrails) happens in a separate job so provider calls never sit inside the
 * transaction that decided to send.
 */
export async function sendOrDraft(tx: Tx, businessId: string, req: OutboundRequest & { action?: DraftAction | null; mediaUrls?: string[] }) {
  // A proposed booking change always waits for the owner, whatever the trust level.
  if (req.trust !== 'auto' || req.action) {
    const r = await tx.query<{ id: string }>(
      `insert into drafts (business_id, customer_id, body, kind, playbook, reason, action) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [businessId, req.customerId, req.body, req.kind, req.playbook, req.reason ?? null, req.action ?? null],
    );
    await emit(tx, businessId, 'draft.created', { type: 'draft', id: r.rows[0].id }, { playbook: req.playbook, customer_id: req.customerId });
    return { status: 'drafted' as const, id: r.rows[0].id };
  }
  const id = await queueMessage(tx, businessId, { ...req, draftId: null, mediaUrls: req.mediaUrls });
  return { status: 'queued' as const, id };
}

export async function queueMessage(tx: Tx, businessId: string, m: { customerId: string; body: string; kind: MessageKind; playbook: string | null; draftId: string | null; channel?: 'sms' | 'email'; subject?: string | null; mediaUrls?: string[] }) {
  // Foreign keys bypass row-level security, so confirm the customer is visible to this tenant.
  if (!(await getCustomer(tx, m.customerId))) throw Object.assign(new Error('customer not found'), { status: 404 });
  const r = await tx.query<{ id: string }>(
    `insert into messages (business_id, customer_id, direction, channel, body, kind, status, playbook, draft_id, subject, media_urls)
     values ($1, $2, 'out', $7, $3, $4, 'queued', $5, $6, $8, $9) returning id`,
    [businessId, m.customerId, m.body, m.kind, m.playbook, m.draftId, m.channel ?? 'sms', m.subject ?? null, m.mediaUrls ?? []],
  );
  await enqueue(tx, businessId, 'deliver_message', { message_id: r.rows[0].id }, { dedupeKey: `deliver:${r.rows[0].id}` });
  return r.rows[0].id;
}

/** Owner approves a draft, optionally editing the text first. */
export async function approveDraft(tx: Tx, businessId: string, draftId: string, editedBody?: string, opts: { skipAction?: boolean } = {}) {
  const d = (await tx.query<{ id: string; customer_id: string; body: string; kind: MessageKind; playbook: string | null; status: string; action: DraftAction | null }>(
    `select id, customer_id, body, kind, playbook, status, action from drafts where id = $1 for update`, [draftId],
  )).rows[0];
  if (!d) throw Object.assign(new Error('draft not found'), { status: 404 });
  if (d.status !== 'pending') throw Object.assign(new Error(`draft is already ${d.status}`), { status: 409 });
  const body = editedBody?.trim() || d.body;
  if (d.action && !opts.skipAction) await executeAction(tx, await loadBusiness(tx), d.customer_id, d.action);
  await tx.query(`update drafts set status = 'approved', body = $2, decided_at = now() where id = $1`, [draftId, body]);
  const messageId = await queueMessage(tx, businessId, { customerId: d.customer_id, body, kind: d.kind, playbook: d.playbook, draftId });
  await emit(tx, businessId, 'draft.approved', { type: 'draft', id: draftId }, { edited: body !== d.body, playbook: d.playbook });
  return messageId;
}

export async function rejectDraft(tx: Tx, businessId: string, draftId: string) {
  const r = await tx.query<{ playbook: string | null }>(`update drafts set status = 'rejected', decided_at = now() where id = $1 and status = 'pending' returning playbook`, [draftId]);
  if (!r.rowCount) throw Object.assign(new Error('no pending draft with that id'), { status: 404 });
  await emit(tx, businessId, 'draft.rejected', { type: 'draft', id: draftId }, { playbook: r.rows[0].playbook });
}

export class DeferJob extends Error {
  constructor(public until: Date) { super('deferred'); }
}

const OPT_OUT_FOOTER = ' Reply STOP to opt out.';

/** Job handler: apply guardrails at the moment of sending, then hand to the provider. */
export async function deliverMessage(tx: Tx, job: Job, now: Date) {
  const messageId = job.payload.message_id as string;
  const m = (await tx.query<{ id: string; customer_id: string; body: string; kind: MessageKind; status: string; playbook: string | null; draft_id: string | null; channel: 'sms' | 'email'; subject: string | null; media_urls: string[] }>(
    `select id, customer_id, body, kind, status, playbook, draft_id, channel, subject, media_urls from messages where id = $1 for update`, [messageId],
  )).rows[0];
  if (!m || m.status !== 'queued') return;
  const business: Business = await loadBusiness(tx);
  const customer = await getCustomer(tx, m.customer_id);
  if (!customer) return;
  const block = async (reason: string) => {
    await tx.query(`update messages set status = 'blocked', block_reason = $2 where id = $1`, [m.id, reason]);
    if (m.draft_id) await tx.query(`update drafts set status = 'blocked' where id = $1`, [m.draft_id]);
    await emit(tx, business.id, 'message.blocked', { type: 'message', id: m.id }, { reason, playbook: m.playbook });
  };

  let channel = m.channel;
  if (channel === 'sms') {
    const decision = await checkOutbound(tx, business, customer, { kind: m.kind, automated: m.playbook !== null, ownerApproved: m.draft_id !== null }, now);
    if (decision.action === 'defer') {
      await emit(tx, business.id, 'message.deferred', { type: 'message', id: m.id }, { reason: decision.reason, until: decision.until.toISOString() });
      throw new DeferJob(decision.until);
    }
    if (decision.action === 'block') {
      // No texting allowed, but they have an email we may use: send it there instead.
      const fallback = ['no_phone', 'no_consent', 'no_marketing_consent'].includes(decision.reason) && (await checkEmail(tx, customer, m.kind)) === null;
      if (!fallback) return block(decision.reason);
      channel = 'email';
      await tx.query(`update messages set channel = 'email' where id = $1`, [m.id]);
    }
  } else {
    const reason = await checkEmail(tx, customer, m.kind);
    if (reason) return block(reason);
  }

  let body = m.body;
  let providerId: string;
  if (channel === 'email') {
    const ownerEmail = (await tx.query<{ email: string }>(`select email from users where role = 'owner' order by created_at limit 1`)).rows[0]?.email;
    const unsub = unsubscribeLink(business, customer.id);
    const address = (business.settings?.address as string | undefined) ?? '';
    const text = [body, '', '—', business.name, address, m.kind === 'marketing' ? `Unsubscribe: ${unsub}` : ''].filter((x) => x !== undefined).join('\n').trim();
    const r = await email().send({
      from: config().EMAIL_FROM, fromName: business.name, to: customer.email!, replyTo: ownerEmail,
      subject: m.subject ?? `${business.name}: ${body.split(/[.!?\n]/)[0].slice(0, 70)}`, text,
      listUnsubscribe: m.kind === 'marketing' ? unsub : undefined,
    });
    providerId = r.providerId;
    body = text;
  } else {
    if (!business.phone_number && !config().TWILIO_MESSAGING_SERVICE_SID && messaging().name !== 'dev') {
      throw new Error('business has no phone number to send from');
    }
    if (m.kind === 'marketing') {
      const prior = (await tx.query<{ n: number }>(
        `select count(*)::int as n from messages where customer_id = $1 and direction = 'out' and status in ('sent','delivered') and kind = 'marketing' and channel = 'sms'`, [customer.id],
      )).rows[0].n;
      if (prior === 0 && !/reply stop/i.test(body)) body += OPT_OUT_FOOTER;
    }
    const result = await messaging().sendSms({
      from: business.phone_number ?? '',
      to: customer.phone!,
      body,
      mediaUrls: m.media_urls?.length ? m.media_urls : undefined,
      statusCallback: `${config().PUBLIC_BASE_URL}/webhooks/twilio/status`,
    });
    providerId = result.providerId;
  }
  await tx.query(`update messages set status = 'sent', body = $2, provider_id = $3, created_at = $4 where id = $1`, [m.id, body, providerId, now]);
  if (m.draft_id) await tx.query(`update drafts set status = 'sent' where id = $1`, [m.draft_id]);
  await emit(tx, business.id, 'message.sent', { type: 'message', id: m.id }, { playbook: m.playbook, kind: m.kind, channel });
}

/** Email rules: an address, and for marketing an explicit yes; service emails go to anyone who booked or contacted us. */
async function checkEmail(tx: Tx, customer: Customer, kind: MessageKind): Promise<string | null> {
  if (!customer.email) return 'no_email';
  const c = (await tx.query<{ email_consent: boolean }>(`select email_consent from customers where id = $1`, [customer.id])).rows[0];
  if (c?.email_consent) return null;
  if (kind === 'marketing') return 'no_email_consent';
  const known = await tx.query(`select 1 from bookings where customer_id = $1 union all select 1 from messages where customer_id = $1 and direction = 'in' limit 1`, [customer.id]);
  return known.rowCount ? null : 'no_consent';
}

export const unsubscribeLink = (b: Business, customerId: string) => `${links(b).origin}/u/${customerId}?t=${sign('unsub', customerId)}`;
