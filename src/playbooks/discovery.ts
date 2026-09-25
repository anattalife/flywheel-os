import { draftReviewReply, mediaUrl, postReviewReply } from '../core/discovery.js';
import { templateData } from '../core/business.js';
import { getCustomer } from '../core/customers.js';
import { enqueue } from '../core/jobs.js';
import { sendOrDraft } from '../core/messaging.js';
import { render } from '../lib/template.js';
import type { Playbook } from './types.js';

/** New Google review: draft a reply for the owner, or post it straight away if they trust it. */
export const reviewReply: Playbook = {
  key: 'review_reply',
  on: ['review.received'],
  async handle({ tx, business }, event) {
    if (event.data.platform !== 'google' || event.data.has_reply) return;
    const text = await draftReviewReply(tx, business, event.subject_id!);
    if (text && business.pack.playbooks.review_reply.trust === 'auto') await postReviewReply(tx, event.subject_id!, text);
  },
};

/** After a job with photos: text the customer a short photo report (MMS). */
export const jobPhotoReport: Playbook = {
  key: 'job_photo_report',
  on: ['job.completed'],
  async handle({ tx, business, now }, event) {
    await enqueue(tx, business.id, 'playbook_step', { playbook: this.key, step: 'send', booking_id: event.subject_id, customer_id: event.data.customer_id }, {
      runAt: new Date(now.getTime() + business.pack.playbooks.job_photo_report.delay_minutes * 60_000), dedupeKey: `photo_report:${event.subject_id}`,
    });
  },
  steps: {
    async send({ tx, business }, payload) {
      const photos = (await tx.query<{ id: string }>(`select id from photos where booking_id = $1 order by created_at limit 3`, [payload.booking_id])).rows;
      if (!photos.length) return;
      const c = await getCustomer(tx, payload.customer_id as string);
      if (!c) return;
      const body = render(business.pack.templates.job_photo_report ?? '', templateData(business, { ...c }));
      await sendOrDraft(tx, business.id, { customerId: c.id, body, kind: 'transactional', playbook: 'job_photo_report', trust: business.pack.playbooks.job_photo_report.trust, reason: 'Photo report', mediaUrls: photos.map((p) => mediaUrl(business, p.id)) });
    },
  },
};
