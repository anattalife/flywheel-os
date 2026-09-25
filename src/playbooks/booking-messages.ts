import { templateData } from '../core/business.js';
import { getCustomer } from '../core/customers.js';
import { enqueue } from '../core/jobs.js';
import { sendOrDraft } from '../core/messaging.js';
import { portalLink } from '../core/portal.js';
import { render } from '../lib/template.js';
import { friendlyWhen } from '../lib/tz.js';
import type { Playbook, PlaybookContext } from './types.js';

async function bookingText(ctx: PlaybookContext, bookingId: string, templateKey: string) {
  const { tx, business } = ctx;
  const b = (await tx.query<{ id: string; customer_id: string; starts_at: Date; status: string; service: string | null }>(
    `select b.id, b.customer_id, b.starts_at, b.status, s.name as service from bookings b left join services s on s.id = b.service_id where b.id = $1`,
    [bookingId])).rows[0];
  if (!b || !['confirmed', 'requested'].includes(b.status)) return null;
  const customer = await getCustomer(tx, b.customer_id);
  if (!customer) return null;
  const data = templateData(business, { ...customer }) as Record<string, any>;
  data.booking = { when: friendlyWhen(new Date(b.starts_at), business.timezone), service: b.service ?? '' };
  data.links.manage = await portalLink(tx, business, customer.id);
  return { booking: b, body: render(business.pack.templates[templateKey] ?? '', data) };
}

/** Confirm a new booking by text. Series-generated visits are not confirmed one by one. */
export const bookingConfirmation: Playbook = {
  key: 'booking_confirmation',
  on: ['booking.created', 'booking.rescheduled'],
  async handle(ctx, event) {
    if (event.data.source === 'series' || event.data.source === 'import') return;
    const t = await bookingText(ctx, event.subject_id!, 'booking_confirmation');
    if (!t?.body) return;
    await sendOrDraft(ctx.tx, ctx.business.id, {
      customerId: t.booking.customer_id, body: t.body, kind: 'transactional', playbook: this.key,
      trust: ctx.business.pack.playbooks.booking_confirmation.trust, reason: event.type === 'booking.rescheduled' ? 'Booking moved' : 'New booking',
    });
  },
};

/** Remind before every visit; a moved booking gets a fresh reminder at its new time. */
export const bookingReminder: Playbook = {
  key: 'booking_reminder',
  on: ['booking.created', 'booking.rescheduled'],
  async handle({ tx, business, now }, event) {
    const b = (await tx.query<{ starts_at: Date }>(`select starts_at from bookings where id = $1`, [event.subject_id])).rows[0];
    if (!b) return;
    const startsAt = new Date(b.starts_at);
    const at = new Date(startsAt.getTime() - business.pack.playbooks.booking_reminder.hours_before * 3_600_000);
    if (at <= now) return;
    await enqueue(tx, business.id, 'playbook_step', { playbook: this.key, step: 'remind', booking_id: event.subject_id, starts_at: startsAt.toISOString() }, {
      runAt: at, dedupeKey: `reminder:${event.subject_id}:${startsAt.toISOString()}`,
    });
  },
  steps: {
    async remind(ctx, payload) {
      const t = await bookingText(ctx, payload.booking_id as string, 'booking_reminder');
      if (!t?.body || new Date(t.booking.starts_at).toISOString() !== payload.starts_at) return; // moved or cancelled since
      await sendOrDraft(ctx.tx, ctx.business.id, {
        customerId: t.booking.customer_id, body: t.body, kind: 'transactional', playbook: 'booking_reminder',
        trust: ctx.business.pack.playbooks.booking_reminder.trust, reason: 'Visit reminder',
      });
    },
  },
};
