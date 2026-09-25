import type { Tx } from '../db/pool.js';
import { loadBusiness } from './business.js';

type Rate = number | null;
export interface Metrics {
  leads: number;
  lead_to_booking: Rate;
  jobs_completed: number;
  revenue_cents: number;
  repeat_rate: Rate;
  second_visit_7d: Rate;
  review_rate: Rate;
  referral_share: Rate;
  missed_calls: number;
  missed_calls_recovered: number;
}

const ratio = (n: number, d: number): Rate => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);

async function metrics(tx: Tx, from: Date, to: Date): Promise<Metrics> {
  // $1 = period start, $2 = period end
  const one = async (sql: string) => (await tx.query(sql, [from, to])).rows[0];
  const leads = await one(`
    select count(*)::int as leads,
           count(*) filter (where exists (select 1 from bookings b where b.customer_id = e.subject_id and b.status <> 'cancelled' and b.created_at < $2::timestamptz))::int as booked
    from events e where e.type = 'lead.created' and e.occurred_at >= $1::timestamptz and e.occurred_at < $2::timestamptz`);
  const jobs = await one(`
    select count(*)::int as n, coalesce(sum(price_cents), 0)::int as revenue
    from bookings where status = 'completed' and completed_at >= $1::timestamptz and completed_at < $2::timestamptz`);
  const repeat = await one(`
    select count(*)::int as customers, count(*) filter (where n >= 2)::int as repeaters
    from (select customer_id, count(*) as n from bookings
          where status = 'completed' and completed_at < $2::timestamptz and $1::timestamptz is not null  -- all history up to the period end
          group by customer_id) t`);
  const second = await one(`
    with firsts as (
      select customer_id, min(completed_at) as first_done from bookings where status = 'completed' group by customer_id)
    select count(*)::int as n,
           count(*) filter (where exists (
             select 1 from bookings b where b.customer_id = f.customer_id and b.created_at > f.first_done
               and b.created_at <= f.first_done + interval '7 days' and b.status <> 'cancelled'))::int as came_back
    from firsts f where f.first_done >= $1::timestamptz and f.first_done < $2::timestamptz`);
  const reviews = await one(`select count(*)::int as n from reviews where not is_private_feedback and created_at >= $1::timestamptz and created_at < $2::timestamptz`);
  const newCustomers = await one(`
    select count(*)::int as n, count(*) filter (where source = 'referral')::int as referred
    from customers where created_at >= $1::timestamptz and created_at < $2::timestamptz`);
  const calls = await one(`
    select count(*)::int as n,
           count(*) filter (where exists (select 1 from bookings b where b.customer_id = (e.data->>'customer_id')::uuid and b.created_at > e.occurred_at and b.status <> 'cancelled'))::int as recovered
    from events e where e.type = 'call.missed' and e.occurred_at >= $1::timestamptz and e.occurred_at < $2::timestamptz`);
  return {
    leads: leads.leads,
    lead_to_booking: ratio(leads.booked, leads.leads),
    jobs_completed: jobs.n,
    revenue_cents: jobs.revenue,
    repeat_rate: ratio(repeat.repeaters, repeat.customers),
    second_visit_7d: ratio(second.came_back, second.n),
    review_rate: ratio(reviews.n, jobs.n),
    referral_share: ratio(newCustomers.referred, newCustomers.n),
    missed_calls: calls.n,
    missed_calls_recovered: calls.recovered,
  };
}

const RATE_LABELS: Record<string, string> = {
  lead_to_booking: 'Leads who book',
  repeat_rate: 'Customers who come back',
  second_visit_7d: 'Second visit within 7 days',
  review_rate: 'Reviews per completed job',
  referral_share: 'New customers from referrals',
};

/**
 * The flywheel scorecard for the last `days` days against the period before, plus
 * the single weakest stage: the rate that fell most (at least 10%) since last period.
 */
export async function scorecard(tx: Tx, now = new Date(), days = 30) {
  const business = await loadBusiness(tx);
  const span = days * 86_400_000;
  const current = await metrics(tx, new Date(now.getTime() - span), now);
  const previous = await metrics(tx, new Date(now.getTime() - 2 * span), new Date(now.getTime() - span));
  let bottleneck: { metric: string; label: string; current: number; previous: number; change: number } | null = null;
  for (const key of Object.keys(RATE_LABELS) as (keyof Metrics)[]) {
    const c = current[key] as Rate;
    const p = previous[key] as Rate;
    if (c === null || p === null || p === 0) continue;
    const change = (c - p) / p;
    if (change <= -0.1 && (!bottleneck || change < bottleneck.change)) {
      bottleneck = { metric: key, label: RATE_LABELS[key], current: c, previous: p, change: Math.round(change * 1000) / 1000 };
    }
  }
  const pendingDrafts = (await tx.query<{ n: number }>(`select count(*)::int as n from drafts where status = 'pending'`)).rows[0].n;
  return {
    period_days: days,
    key_metric: { ...business.pack.key_metric, value: current[business.pack.key_metric.key] ?? null },
    current,
    previous,
    bottleneck,
    pending_drafts: pendingDrafts,
  };
}
