import { templateData } from '../core/business.js';
import { getCustomer } from '../core/customers.js';
import { enqueue } from '../core/jobs.js';
import { sendOrDraft } from '../core/messaging.js';
import { addHours } from '../lib/time.js';
import { render } from '../lib/template.js';
import type { Playbook } from './types.js';

/**
 * Advocate: after a completed job, ask for a review. Everyone gets the ask (no
 * filtering by how happy they seemed, per Google's policy), at most once in 90 days.
 */
export const reviewRequest: Playbook = {
  key: 'review_request',
  on: ['job.completed'],
  async handle({ tx, business, now }, event) {
    const delay = business.pack.playbooks.review_request.delay_hours;
    await enqueue(tx, business.id, 'playbook_step', { playbook: this.key, step: 'ask', customer_id: event.data.customer_id, booking_id: event.subject_id }, {
      runAt: addHours(now, delay),
      dedupeKey: `review_request:${event.subject_id}`,
    });
  },
  steps: {
    async ask({ tx, business, now }, payload) {
      const customerId = payload.customer_id as string;
      const asked = await tx.query(
        `select 1 from drafts where customer_id = $1 and playbook = 'review_request' and status <> 'rejected' and created_at > $2::timestamptz - interval '90 days'
         union all
         select 1 from messages where customer_id = $1 and playbook = 'review_request' and status in ('queued','sent','delivered') and created_at > $2::timestamptz - interval '90 days'
         limit 1`,
        [customerId, now],
      );
      if (asked.rowCount) return;
      const customer = await getCustomer(tx, customerId);
      if (!customer) return;
      await sendOrDraft(tx, business.id, {
        customerId,
        body: render(business.pack.templates.review_request, templateData(business, { ...customer })),
        kind: 'marketing',
        playbook: 'review_request',
        trust: business.pack.playbooks.review_request.trust,
        reason: `${business.pack.vocabulary.job.one[0].toUpperCase()}${business.pack.vocabulary.job.one.slice(1)} completed`,
      });
    },
  },
};
