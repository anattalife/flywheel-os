import type { Tx } from '../db/pool.js';
import { render } from '../lib/template.js';
import { templateData, type Business } from './business.js';
import { sendOrDraft } from './messaging.js';

/**
 * One-off "first wins" for a new account: ask recent customers for a review, or
 * invite lapsed ones back. Always drafts, so the owner sees every message first.
 */
export async function draftCampaign(tx: Tx, business: Business, kind: 'review_ask' | 'win_back', limit = 50) {
  const sql = kind === 'review_ask'
    ? `select c.* from customers c where c.last_visit_at > now() - interval '180 days' and c.sms_consent and not c.sms_opted_out
         and not exists (select 1 from drafts d where d.customer_id = c.id and d.playbook = 'review_request' and d.created_at > now() - interval '90 days')
         and not exists (select 1 from messages m where m.customer_id = c.id and m.playbook = 'review_request' and m.created_at > now() - interval '90 days')
       order by c.last_visit_at desc limit $1`
    : `select c.* from customers c where c.last_visit_at < now() - interval '60 days' and c.sms_consent and not c.sms_opted_out
         and not exists (select 1 from bookings b where b.customer_id = c.id and b.status in ('confirmed','requested') and b.starts_at > now())
         and not exists (select 1 from drafts d where d.customer_id = c.id and d.playbook = 'win_back' and d.status = 'pending')
       order by c.last_visit_at desc limit $1`;
  const rows = (await tx.query(sql, [limit])).rows;
  const template = business.pack.templates[kind === 'review_ask' ? 'review_request' : 'win_back_60'] ?? '';
  for (const c of rows) {
    await sendOrDraft(tx, business.id, {
      customerId: c.id, body: render(template, templateData(business, c)), kind: 'marketing',
      playbook: kind === 'review_ask' ? 'review_request' : 'win_back', trust: 'draft',
      reason: kind === 'review_ask' ? 'Review request (getting started)' : 'Invite back (getting started)',
    });
  }
  return { drafted: rows.length };
}
