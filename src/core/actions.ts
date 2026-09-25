import { z } from 'zod';
import type { Tx } from '../db/pool.js';
import { friendlyWhen } from '../lib/tz.js';
import type { Business } from './business.js';
import { cancelBooking, createBooking } from './bookings.js';
import { rescheduleBooking } from './scheduling.js';

/** Something the AI proposes to do along with its reply. It only happens when the owner approves. */
export const DraftAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('book'), service_key: z.string(), starts_at: z.string() }),
  z.object({ type: z.literal('reschedule'), booking_id: z.string().uuid(), starts_at: z.string() }),
  z.object({ type: z.literal('cancel'), booking_id: z.string().uuid() }),
]);
export type DraftAction = z.infer<typeof DraftAction> & { summary?: string };

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * Check a proposed action against real data before showing it to the owner:
 * the service exists, the time is one we offered, the booking is this customer's.
 * Returns the action with a plain summary, or null if it doesn't hold up.
 */
export async function validateAction(tx: Tx, business: Business, customerId: string, raw: unknown, offeredSlots: string[]): Promise<DraftAction | null> {
  const p = DraftAction.safeParse(raw);
  if (!p.success) return null;
  const a = p.data;
  const tz = business.timezone;
  if (a.type === 'book') {
    const svc = (await tx.query<{ name: string }>(`select name from services where key = $1 and active`, [a.service_key])).rows[0];
    const at = new Date(a.starts_at);
    if (!svc || !offeredSlots.includes(at.toISOString())) return null;
    return { ...a, starts_at: at.toISOString(), summary: `Book ${svc.name}, ${friendlyWhen(at, tz)}` };
  }
  const b = (await tx.query<{ customer_id: string; starts_at: Date; status: string }>(`select customer_id, starts_at, status from bookings where id = $1`, [a.booking_id])).rows[0];
  if (!b || b.customer_id !== customerId || !['confirmed', 'requested'].includes(b.status)) return null;
  if (a.type === 'reschedule') {
    const at = new Date(a.starts_at);
    if (!offeredSlots.includes(at.toISOString())) return null;
    return { ...a, starts_at: at.toISOString(), summary: `Move ${friendlyWhen(new Date(b.starts_at), tz)} to ${friendlyWhen(at, tz)}` };
  }
  return { ...a, summary: `Cancel ${friendlyWhen(new Date(b.starts_at), tz)}` };
}

/** Carry out an approved action. Availability is checked again, since time has passed. */
export async function executeAction(tx: Tx, business: Business, customerId: string, a: DraftAction) {
  if (a.type === 'book') {
    await createBooking(tx, business.id, { customer_id: customerId, service_key: a.service_key, starts_at: a.starts_at, source: 'ai' });
  } else if (a.type === 'reschedule') {
    await rescheduleBooking(tx, business, a.booking_id, new Date(a.starts_at), { enforceHours: false, by: 'ai' });
  } else if (a.type === 'cancel') {
    await cancelBooking(tx, business.id, a.booking_id);
  } else {
    throw err(400, 'unknown action');
  }
}
