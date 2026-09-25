import { templateData } from '../core/business.js';
import { getCustomer } from '../core/customers.js';
import { sendOrDraft } from '../core/messaging.js';
import { render } from '../lib/template.js';
import type { Playbook } from './types.js';

/** Capture: a missed call gets a text back within seconds, at most once a day per caller. */
export const missedCallTextback: Playbook = {
  key: 'missed_call_textback',
  on: ['call.missed'],
  async handle({ tx, business, now }, event) {
    const customerId = event.data.customer_id as string;
    const recent = await tx.query(
      `select 1 from messages where customer_id = $1 and direction = 'out' and playbook = 'missed_call_textback'
         and status in ('queued','sent','delivered') and created_at > $2::timestamptz - interval '24 hours' limit 1`,
      [customerId, now],
    );
    if (recent.rowCount) return;
    const customer = await getCustomer(tx, customerId);
    if (!customer) return;
    const cfg = business.pack.playbooks.missed_call_textback;
    await sendOrDraft(tx, business.id, {
      customerId,
      body: render(business.pack.templates.missed_call_textback, templateData(business, { ...customer })),
      kind: 'conversational',
      playbook: this.key,
      trust: cfg.trust,
      reason: 'Missed call',
    });
  },
};
