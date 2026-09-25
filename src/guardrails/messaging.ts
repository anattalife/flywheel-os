import type { Tx } from '../db/pool.js';
import type { Business } from '../core/business.js';
import type { Customer } from '../core/customers.js';
import { inQuietHours, nextAllowedTime } from '../lib/time.js';

export type MessageKind = 'conversational' | 'transactional' | 'marketing';
export type Decision =
  | { action: 'send' }
  | { action: 'defer'; until: Date; reason: string }
  | { action: 'block'; reason: string };

/** How recently the customer must have contacted us for a reply to count as conversational. */
const RECENT_CONTACT_MIN = 60;

/**
 * Rules every outbound text passes, whoever wrote it. Encodes: opt-out wins,
 * marketing needs recorded consent, other messages need consent or a customer who
 * contacted us first, quiet hours in the business's timezone, and a weekly cap on
 * automated messages. (Rules are conservative defaults; have counsel review before launch.)
 */
export async function checkOutbound(
  tx: Tx,
  business: Business,
  customer: Customer,
  msg: { kind: MessageKind; automated: boolean; ownerApproved: boolean },
  now: Date,
): Promise<Decision> {
  if (!customer.phone) return { action: 'block', reason: 'no_phone' };
  if (customer.sms_opted_out) return { action: 'block', reason: 'opted_out' };

  const contact = (await tx.query<{ phone_or_text: Date | null; any_channel: Date | null }>(
    `select max(created_at) filter (where channel in ('sms','voice')) as phone_or_text,
            max(created_at) as any_channel
     from messages where customer_id = $1 and direction = 'in'`,
    [customer.id],
  )).rows[0];
  // Texting or calling us counts toward consent to reply; any channel (incl. a web form
  // they just sent) makes an immediate reply welcome even during quiet hours.
  const everContactedUs = !!contact?.phone_or_text;
  const lastAny = contact?.any_channel ? new Date(contact.any_channel).getTime() : null;
  const recentlyContactedUs = lastAny !== null && now.getTime() - lastAny < RECENT_CONTACT_MIN * 60_000;

  if (msg.kind === 'marketing' && !customer.sms_consent) return { action: 'block', reason: 'no_marketing_consent' };
  if (msg.kind !== 'marketing' && !customer.sms_consent && !everContactedUs) {
    // Service messages (confirmations, reminders) are allowed to someone who booked with us.
    const booked = msg.kind === 'transactional'
      && (await tx.query(`select 1 from bookings where customer_id = $1 limit 1`, [customer.id])).rowCount;
    if (!booked) return { action: 'block', reason: 'no_consent' };
  }

  if (msg.automated && !msg.ownerApproved && msg.kind !== 'transactional') {
    const sent = (await tx.query<{ n: number }>(
      `select count(*)::int as n from messages
       where customer_id = $1 and direction = 'out' and status in ('sent','delivered') and playbook is not null
         and draft_id is null and kind <> 'transactional' and created_at > $2::timestamptz - interval '7 days'`,
      [customer.id, now],
    )).rows[0].n;
    if (sent >= business.pack.guardrails.max_automated_per_week) return { action: 'block', reason: 'weekly_cap' };
  }

  const quiet = business.pack.guardrails.quiet_hours;
  if (!recentlyContactedUs && inQuietHours(now, business.timezone, quiet)) {
    return { action: 'defer', until: nextAllowedTime(now, business.timezone, quiet), reason: 'quiet_hours' };
  }
  return { action: 'send' };
}

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt out']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);

export function keyword(body: string): 'stop' | 'start' | null {
  const w = body.trim().toLowerCase().replace(/[.!]+$/, '');
  if (STOP_WORDS.has(w)) return 'stop';
  if (START_WORDS.has(w)) return 'start';
  return null;
}
