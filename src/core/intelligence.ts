import { aiFor } from '../adapters/ai/index.js';
import type { Tx } from '../db/pool.js';
import { addLocalDays, localParts, minutesOf, weekdayOf, zonedTime } from '../lib/tz.js';
import type { Business } from './business.js';
import { dollars } from './billing.js';
import { loadHours, schedulingRules } from './scheduling.js';
import { scorecard } from './scorecard.js';

const DAY = 86_400_000;

/** Average price of a completed job over the last 90 days (falls back to the first fixed-price service). */
export async function avgTicket(tx: Tx, now = new Date()): Promise<number> {
  const r = (await tx.query<{ avg: number | null }>(
    `select avg(price_cents)::int as avg from bookings where status = 'completed' and price_cents > 0 and completed_at > $1::timestamptz - interval '90 days'`, [now])).rows[0];
  if (r.avg) return r.avg;
  const svc = (await tx.query<{ price_rule: any }>(`select price_rule from services where active order by position limit 1`)).rows[0];
  return svc?.price_rule?.amount_cents ?? svc?.price_rule?.rate_cents ?? 0;
}

/**
 * Roughly what the weakest stage costs per month, if it went back to last
 * period's level, and the recorded reasons that point at why.
 */
export async function bottleneckDetail(tx: Tx, business: Business, card: Awaited<ReturnType<typeof scorecard>>, now = new Date()) {
  const b = card.bottleneck;
  if (!b) return null;
  const ticket = await avgTicket(tx, now);
  const gap = b.previous - b.current;
  const perMonth = 30 / card.period_days;
  let base = 0;
  if (b.metric === 'lead_to_booking') base = card.current.leads;
  else if (b.metric === 'second_visit_7d' || b.metric === 'referral_share') {
    base = (await tx.query<{ n: number }>(`select count(*)::int as n from customers where created_at > $1::timestamptz - make_interval(days => $2)`, [now, card.period_days])).rows[0].n;
  } else if (b.metric === 'repeat_rate') {
    base = (await tx.query<{ n: number }>(`select count(distinct customer_id)::int as n from bookings where status = 'completed' and completed_at > $1::timestamptz - make_interval(days => $2)`, [now, card.period_days])).rows[0].n;
  }
  const impact = b.metric === 'review_rate' ? null : Math.round(gap * base * ticket * perMonth);
  const kind = b.metric === 'lead_to_booking' ? 'lost_quote' : 'cancel';
  const reasons = (await tx.query<{ code: string; n: number }>(
    `select code, count(*)::int as n from reasons where kind = $1 and created_at > $2::timestamptz - make_interval(days => $3) group by code order by n desc limit 3`,
    [kind, now, card.period_days])).rows;
  const labels = Object.fromEntries(business.pack.reasons[kind].map((r) => [r.code, r.label]));
  const total = reasons.reduce((a, r) => a + r.n, 0);
  const hints = reasons.map((r) => `${labels[r.code] ?? r.code}: ${r.n} of ${total} ${kind === 'cancel' ? 'cancellations' : 'lost quotes'}`);
  const ACTIONS: Record<string, string> = {
    lead_to_booking: 'Answer leads faster and follow up twice. Check the price on your quotes.',
    repeat_rate: 'Offer a recurring plan at every first visit, and message anyone past their usual gap.',
    second_visit_7d: 'Book the next visit before you leave the first one.',
    review_rate: 'Turn review requests to automatic and ask in person at the end of each job.',
    referral_share: 'Send share links to your happiest customers this week.',
  };
  return { impact_cents: impact, impact_label: impact ? `about ${dollars(impact)} a month` : null, hints, action: ACTIONS[b.metric] ?? null };
}

/** Booked time against open time for the next few weeks, with plain advice. */
export async function capacityForecast(tx: Tx, business: Business, now = new Date(), weeks = 4) {
  const tz = business.timezone;
  const rules = schedulingRules(business);
  const hours = await loadHours(tx);
  const today = localParts(now, tz).date;
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const start = addLocalDays(today, w * 7);
    const from = zonedTime(start, '00:00', tz);
    const to = zonedTime(addLocalDays(start, 7), '00:00', tz);
    let open = 0;
    for (let d = 0; d < 7; d++) {
      const wd = weekdayOf(addLocalDays(start, d));
      for (const h of hours.filter((x) => x.weekday === wd)) open += minutesOf(h.closes) - minutesOf(h.opens);
    }
    const off = (await tx.query<{ m: number }>(
      `select coalesce(sum(extract(epoch from (least(ends_at, $2) - greatest(starts_at, $1))) / 60), 0)::int as m from time_off where starts_at < $2 and ends_at > $1`, [from, to])).rows[0].m;
    const booked = (await tx.query<{ m: number }>(
      `select coalesce(sum(extract(epoch from (ends_at - starts_at)) / 60), 0)::int as m from bookings where status in ('confirmed','requested') and not skipped and starts_at >= $1 and starts_at < $2`, [from, to])).rows[0].m;
    const available = Math.max(0, (open - Math.min(open, off)) * rules.capacity);
    out.push({ week_start: start, booked_minutes: booked, open_minutes: available, utilization: available ? Math.round((booked / available) * 100) / 100 : null });
  }
  const next2 = out.slice(0, 2).map((w) => w.utilization ?? 0);
  const peak = Math.max(...next2);
  const advice = peak >= 0.9 ? 'You are nearly full. Raise prices for new customers, or add help, before saying no to work.'
    : peak <= 0.4 ? 'You have room. Turn up follow-ups and ask happy customers for referrals this week.'
    : 'Healthy schedule with room to grow.';
  return { weeks: out, advice };
}

/** Why people cancel, why quotes are lost, and how people found you, with an AI summary when AI is on. */
export async function reasonsSummary(tx: Tx, business: Business, days = 90, now = new Date()) {
  const rows = (await tx.query<{ kind: string; code: string; n: number }>(
    `select kind, code, count(*)::int as n from reasons where created_at > $1::timestamptz - make_interval(days => $2) group by kind, code order by kind, n desc`, [now, days])).rows;
  const sources = (await tx.query<{ source: string; n: number }>(
    `select coalesce(source, 'unknown') as source, count(*)::int as n from customers where created_at > $1::timestamptz - make_interval(days => $2) group by 1 order by n desc`, [now, days])).rows;
  const label = (kind: string, code: string) => (business.pack.reasons as Record<string, { code: string; label: string }[]>)[kind]?.find((r) => r.code === code)?.label ?? code;
  const counts: Record<string, { code: string; label: string; n: number }[]> = {};
  for (const r of rows) (counts[r.kind] ??= []).push({ code: r.code, label: label(r.kind, r.code), n: r.n });
  let summary: string | null = null;
  const ai = aiFor(business.settings);
  if (ai && (rows.length || sources.length)) {
    const facts = [
      ...Object.entries(counts).map(([k, list]) => `${k}: ${list.map((x) => `${x.label} ${x.n}`).join(', ')}`),
      `new customers by source: ${sources.map((s) => `${s.source} ${s.n}`).join(', ')}`,
    ].join('\n');
    summary = await ai.complete({
      system: `You advise the owner of ${business.name}, a small service business. In 3 short bullet points: the main pattern in why customers leave or say no, where new customers come from, and one concrete change to the offer or pricing to try this month. Plain words, no jargon.`,
      messages: [{ role: 'user', content: `Last ${days} days:\n${facts}` }], tier: 'strong', maxTokens: 300,
    }).catch(() => null);
  }
  const body = { days, counts, sources, summary };
  await tx.query(`insert into insights (business_id, kind, period_start, period_end, body) values ($1, 'reasons', $2::timestamptz - make_interval(days => $3), $2, $4)`, [business.id, now, days, body]);
  return body;
}

/**
 * Earned autonomy: playbooks still set to "draft for my OK" whose last drafts
 * were all approved without edits. The owner can let those send on their own.
 */
export async function autonomySuggestions(tx: Tx, business: Business, min = 10) {
  const rows = (await tx.query<{ playbook: string; total: number; unchanged: number }>(
    `select playbook, count(*)::int as total, count(*) filter (where (data->>'edited')::boolean is not true)::int as unchanged
     from (select data->>'playbook' as playbook, data, row_number() over (partition by data->>'playbook' order by id desc) as rn
           from events where type in ('draft.approved','draft.rejected') and data->>'playbook' is not null) t
     where rn <= $1 group by playbook`, [min])).rows;
  const rejected = (await tx.query<{ playbook: string; n: number }>(
    `select data->>'playbook' as playbook, count(*)::int as n from events where type = 'draft.rejected' and occurred_at > now() - interval '30 days' group by 1`)).rows;
  const rejectedBy = Object.fromEntries(rejected.map((r) => [r.playbook, r.n]));
  const playbooks = business.pack.playbooks as Record<string, { trust?: string; enabled?: boolean }>;
  return rows
    .filter((r) => r.total >= min && r.unchanged === r.total && !rejectedBy[r.playbook] && playbooks[r.playbook]?.trust !== 'auto' && playbooks[r.playbook]?.enabled)
    .map((r) => ({ playbook: r.playbook, approved_unchanged: r.unchanged }));
}

/** The morning text to the owner: short, specific, and only what needs attention. */
export async function dailyBrief(tx: Tx, business: Business, now = new Date()): Promise<string> {
  const tz = business.timezone;
  const today = localParts(now, tz).date;
  const from = zonedTime(today, '00:00', tz), to = zonedTime(addLocalDays(today, 1), '00:00', tz);
  const jobs = (await tx.query<{ starts_at: Date; first_name: string | null; price_cents: number | null }>(
    `select b.starts_at, c.first_name, b.price_cents from bookings b join customers c on c.id = b.customer_id
     where b.status in ('confirmed','requested') and b.starts_at >= $1 and b.starts_at < $2 order by b.starts_at`, [from, to])).rows;
  const q1 = async (sql: string) => (await tx.query<{ n: number }>(sql)).rows[0].n;
  const drafts = await q1(`select count(*)::int as n from drafts where status = 'pending'`);
  const waiting = await q1(`select count(*)::int as n from customers c where (select direction from messages m where m.customer_id = c.id and m.channel in ('sms','web') order by created_at desc limit 1) = 'in'`);
  const unpaid = (await tx.query<{ n: number; c: number }>(`select count(*)::int as n, coalesce(sum(amount_cents),0)::int as c from invoices where status in ('open','failed')`)).rows[0];
  const atRisk = (await tx.query<{ n: number }>(`select count(*)::int as n from customers where status = 'active' and health_score < $1`, [business.pack.retention.at_risk_below])).rows[0].n;
  const card = await scorecard(tx, now, 30);
  const v = business.pack.vocabulary;
  const t = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(d));
  const lines = [`Good morning! ${business.name} today:`];
  lines.push(jobs.length
    ? `${jobs.length} ${jobs.length === 1 ? v.job.one : v.job.many}, first at ${t(jobs[0].starts_at)}${jobs[0].first_name ? ` (${jobs[0].first_name})` : ''}. ${dollars(jobs.reduce((a, j) => a + (j.price_cents ?? 0), 0))} booked.`
    : `No ${v.job.many} booked.`);
  const needs = [drafts ? `${drafts} message${drafts > 1 ? 's' : ''} to approve` : '', waiting ? `${waiting} waiting for a reply` : '', unpaid.n ? `${dollars(unpaid.c)} unpaid` : '', atRisk ? `${atRisk} at risk` : ''].filter(Boolean);
  if (needs.length) lines.push(`Needs you: ${needs.join(', ')}.`);
  if (card.bottleneck) lines.push(`Focus: ${card.bottleneck.label} is down to ${Math.round(card.bottleneck.current * 100)}%.`);
  lines.push('Open the app for details, or text "help" for commands.');
  return lines.join('\n');
}
