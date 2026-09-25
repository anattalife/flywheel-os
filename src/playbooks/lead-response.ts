import { templateData } from '../core/business.js';
import { getCustomer } from '../core/customers.js';
import { cancelJobs, enqueue } from '../core/jobs.js';
import { sendOrDraft } from '../core/messaging.js';
import { addDays } from '../lib/time.js';
import { render } from '../lib/template.js';
import type { Playbook } from './types.js';

const LEAD_BURST_PER_HOUR = 20;
const cancelKey = (customerId: string) => `lead_followup:${customerId}`;

/**
 * Convert: an instant reply to every new lead, then follow-ups on the pack's
 * schedule (default day 1, 3, 7). Any reply or booking cancels the rest.
 */
export const leadResponse: Playbook = {
  key: 'lead_response',
  on: ['lead.created', 'message.received', 'booking.created'],
  async handle({ tx, business, now }, event) {
    const customerId = (event.data.customer_id as string) ?? (event.subject_id as string);
    if (event.type !== 'lead.created') {
      await cancelJobs(tx, cancelKey(customerId));
      return;
    }
    const customer = await getCustomer(tx, customerId);
    if (!customer) return;
    const cfg = business.pack.playbooks.lead_response;
    // A sudden flood of form leads looks like abuse, not demand: hold replies for the owner to check.
    const burst = (await tx.query<{ n: number }>(`select count(*)::int as n from events where type = 'lead.created' and occurred_at > $1::timestamptz - interval '1 hour'`, [now])).rows[0].n > LEAD_BURST_PER_HOUR;
    await sendOrDraft(tx, business.id, {
      customerId,
      body: render(business.pack.templates.lead_instant_reply, templateData(business, { ...customer })),
      kind: 'conversational',
      playbook: this.key,
      trust: burst && cfg.trust === 'auto' ? 'draft' : cfg.trust,
      reason: burst ? 'New lead (held: unusually many form submissions this hour)' : 'New lead',
    });
    for (const [i, days] of cfg.follow_up_days.entries()) {
      await enqueue(tx, business.id, 'playbook_step', { playbook: this.key, step: 'follow_up', customer_id: customerId, n: i + 1, lead_event_id: event.id }, {
        runAt: addDays(now, days),
        cancelKey: cancelKey(customerId),
        dedupeKey: `lead_followup:${event.id}:${i + 1}`,
      });
    }
  },
  steps: {
    async follow_up({ tx, business }, payload) {
      const customerId = payload.customer_id as string;
      const n = Number(payload.n);
      // Belt and braces: skip if they've booked or written since the lead came in.
      const engaged = await tx.query(
        `select 1 from bookings where customer_id = $1 and status <> 'cancelled'
         union all
         select 1 from messages m where m.customer_id = $1 and m.direction = 'in' and m.channel in ('sms','voice')
           and m.created_at > (select occurred_at from events where id = $2)
         limit 1`,
        [customerId, payload.lead_event_id],
      );
      if (engaged.rowCount) return;
      const template = business.pack.templates[`lead_follow_up_${n}`];
      if (!template) return;
      const customer = await getCustomer(tx, customerId);
      if (!customer) return;
      await sendOrDraft(tx, business.id, {
        customerId,
        body: render(template, templateData(business, { ...customer })),
        kind: 'marketing',
        playbook: 'lead_response',
        trust: business.pack.playbooks.lead_response.follow_up_trust,
        reason: `Lead follow-up ${n}: no reply yet`,
      });
    },
  },
};
