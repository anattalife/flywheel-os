import type { Tx } from '../db/pool.js';
import { enqueue } from './jobs.js';

export type EventType =
  | 'business.created'
  | 'customer.created' | 'customer.consent_changed' | 'customer.erased'
  | 'lead.created'
  | 'call.missed'
  | 'message.received' | 'message.sent' | 'message.blocked' | 'message.deferred' | 'message.failed'
  | 'draft.created' | 'draft.approved' | 'draft.rejected'
  | 'booking.created' | 'booking.cancelled' | 'booking.rescheduled' | 'booking.skipped'
  | 'series.paused' | 'series.resumed' | 'series.ended' | 'series.conflict'
  | 'job.completed'
  | 'payment.succeeded' | 'payment.failed' | 'payment.refunded'
  | 'invoice.created' | 'invoice.paid' | 'invoice.voided' | 'card.saved'
  | 'photo.added' | 'post.drafted' | 'google.connected' | 'owner.command'
  | 'customer.at_risk' | 'customer.lapsed' | 'feedback.received' | 'referral.created' | 'referral.converted' | 'credit.granted'
  | 'review.received'
  | 'reason.recorded';

export interface AppEvent {
  id: string;
  business_id: string;
  type: EventType;
  subject_type: string | null;
  subject_id: string | null;
  data: Record<string, unknown>;
  occurred_at: Date;
}

/**
 * Record something that happened and, in the same transaction, queue its dispatch
 * to playbooks. Either both happen or neither does.
 */
export async function emit(tx: Tx, businessId: string, type: EventType, subject: { type: string; id: string } | null, data: Record<string, unknown> = {}, occurredAt?: Date) {
  const r = await tx.query<{ id: string }>(
    `insert into events (business_id, type, subject_type, subject_id, data, occurred_at)
     values ($1, $2, $3, $4, $5, coalesce($6, now())) returning id`,
    [businessId, type, subject?.type ?? null, subject?.id ?? null, data, occurredAt ?? null],
  );
  const eventId = r.rows[0].id;
  await enqueue(tx, businessId, 'dispatch_event', { event_id: eventId }, { dedupeKey: `dispatch:${eventId}` });
  return eventId;
}

export async function loadEvent(tx: Tx, id: string): Promise<AppEvent | null> {
  const r = await tx.query<AppEvent>(`select id, business_id, type, subject_type, subject_id, data, occurred_at from events where id = $1`, [id]);
  return r.rows[0] ?? null;
}
