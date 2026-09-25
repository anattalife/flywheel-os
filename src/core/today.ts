import type { Tx } from '../db/pool.js';
import { loadBusiness } from './business.js';
import { scorecard } from './scorecard.js';
import { dayBounds } from '../lib/tz.js';

/** What the owner needs on opening the app: today's work, who's waiting, and the one priority. */
export async function today(tx: Tx, now = new Date()) {
  const business = await loadBusiness(tx);
  const { start, end, label } = dayBounds(now, business.timezone);
  const bookings = (await tx.query(
    `select b.id, b.starts_at, b.ends_at, b.status, b.price_cents, b.notes, s.name as service,
            c.id as customer_id, c.first_name, c.last_name, c.phone, p.address
     from bookings b join customers c on c.id = b.customer_id
     left join services s on s.id = b.service_id left join places p on p.id = b.place_id
     where b.starts_at >= $1 and b.starts_at < $2 and b.status <> 'cancelled'
     order by b.starts_at`, [start, end])).rows;
  const waiting = (await tx.query(
    `select c.id as customer_id, c.first_name, c.last_name, c.phone, m.body, m.created_at
     from customers c
     join lateral (select body, created_at, direction from messages m where m.customer_id = c.id and m.channel in ('sms','web')
                   order by created_at desc limit 1) m on true
     where m.direction = 'in'
     order by m.created_at`)).rows;
  const drafts = (await tx.query<{ n: number }>(`select count(*)::int as n from drafts where status = 'pending'`)).rows[0].n;
  const card = await scorecard(tx, now, 30);
  const unpaid = (await tx.query<{ n: number; cents: number; failed: number }>(
    `select count(*)::int as n, coalesce(sum(amount_cents), 0)::int as cents, count(*) filter (where status = 'failed')::int as failed
     from invoices where status in ('open','failed')`)).rows[0];
  const booked = bookings.reduce((sum: number, b: any) => sum + (b.price_cents ?? 0), 0);
  return {
    date: label,
    business: { name: business.name, vocabulary: business.pack.vocabulary },
    bookings,
    booked_cents: booked,
    waiting_for_reply: waiting,
    pending_drafts: drafts,
    unpaid,
    review_replies: (await tx.query<{ n: number }>(`select count(*)::int as n from reviews where reply_status in ('drafted','failed')`)).rows[0].n
      + (await tx.query<{ n: number }>(`select count(*)::int as n from gbp_posts where status = 'draft'`)).rows[0].n,
    at_risk: (await tx.query<{ n: number }>(`select count(*)::int as n from customers where status = 'active' and health_score < $1`, [business.pack.retention.at_risk_below])).rows[0].n,
    bottleneck: card.bottleneck,
    key_metric: card.key_metric,
  };
}
