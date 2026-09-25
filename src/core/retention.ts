import type { Tx } from '../db/pool.js';
import type { Business } from './business.js';
import { emit } from './events.js';
import { enqueue } from './jobs.js';

interface Row {
  id: string; status: string; last_visit_at: Date | null; health_score: number | null;
  visits: Date[]; staff: (string | null)[]; upcoming: boolean; series_interval: number | null; series_paused: boolean;
  cancels60: number; skips60: number; failed_invoice: boolean; low_feedback: boolean; sms_opted_out: boolean;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const DAY = 86_400_000;

/**
 * Score every customer who has had at least one completed visit, 0-100, with the
 * plain-language reasons behind any drop. Rhythm is learned from their own visit
 * history (or their plan), so a monthly customer isn't "late" after two weeks.
 */
export async function scoreHealth(tx: Tx, business: Business, now = new Date()) {
  const rules = business.pack.retention;
  const v = business.pack.vocabulary;
  const rows = (await tx.query<Row>(`
    select c.id, c.status, c.last_visit_at, c.health_score, c.sms_opted_out,
      coalesce((select array_agg(completed_at order by completed_at) from bookings where customer_id = c.id and status = 'completed'), '{}') as visits,
      coalesce((select array_agg(staff_id order by completed_at desc) from (select staff_id, completed_at from bookings where customer_id = c.id and status = 'completed' order by completed_at desc limit 2) x), '{}') as staff,
      exists (select 1 from bookings where customer_id = c.id and status in ('confirmed','requested') and starts_at > $1) as upcoming,
      (select min(interval_days) from series where customer_id = c.id and status in ('active','paused')) as series_interval,
      exists (select 1 from series where customer_id = c.id and status = 'paused') as series_paused,
      (select count(*)::int from bookings where customer_id = c.id and status = 'cancelled' and not skipped and starts_at > $1::timestamptz - interval '60 days') as cancels60,
      (select count(*)::int from bookings where customer_id = c.id and skipped and starts_at > $1::timestamptz - interval '60 days') as skips60,
      exists (select 1 from invoices where customer_id = c.id and status = 'failed') as failed_invoice,
      exists (select 1 from reviews where customer_id = c.id and is_private_feedback and rating <= 3 and created_at > $1::timestamptz - interval '90 days') as low_feedback
    from customers c
    where c.last_visit_at is not null`, [now])).rows;

  let changed = 0;
  for (const r of rows) {
    const visits = r.visits.map((d) => new Date(d).getTime());
    const gaps = visits.slice(1).map((t, i) => (t - visits[i]) / DAY);
    const expected = r.series_interval ?? median(gaps) ?? rules.expected_interval_days;
    const since = (now.getTime() - new Date(r.last_visit_at!).getTime()) / DAY;
    const reasons: string[] = [];
    let penalty = 0;
    if (!r.upcoming && since > expected * 1.25) {
      // About 2.5x their usual gap with nothing booked puts someone below the at-risk line.
      const p = Math.min(70, Math.round(((since - expected) / expected) * 35));
      penalty += p;
      reasons.push(`No ${v.job.one} booked; last one ${Math.round(since)} days ago (usually every ${Math.round(expected)})`);
    }
    if (r.cancels60) { penalty += Math.min(30, r.cancels60 * 10); reasons.push(`${r.cancels60} cancellation${r.cancels60 > 1 ? 's' : ''} in 60 days`); }
    if (r.skips60 >= 2) { penalty += Math.min(15, r.skips60 * 5); reasons.push(`Skipped ${r.skips60} visits in 60 days`); }
    if (r.series_paused) { penalty += 10; reasons.push('Plan is paused'); }
    if (r.failed_invoice) { penalty += 15; reasons.push('Card declined, invoice unpaid'); }
    if (r.low_feedback) { penalty += 25; reasons.push('Gave a low rating recently'); }
    if (r.staff.length === 2 && r.staff[0] && r.staff[1] && r.staff[0] !== r.staff[1]) { penalty += 10; reasons.push(`Different ${v.provider.one} last visit`); }
    if (r.sms_opted_out) reasons.push('Replied STOP to texts');
    const score = Math.max(0, Math.min(100, 100 - penalty));

    await tx.query(`update customers set health_score = $2, health_reasons = $3, health_updated_at = $4 where id = $1`, [r.id, score, reasons, now]);
    const wasOk = r.health_score === null || r.health_score >= rules.at_risk_below;
    if (wasOk && score < rules.at_risk_below && r.status === 'active') {
      await emit(tx, business.id, 'customer.at_risk', { type: 'customer', id: r.id }, { customer_id: r.id, score, reasons });
    }
    const lapsedAfter = Math.max(expected * 2, rules.lapsed_after_days);
    if (r.status === 'active' && !r.upcoming && since > lapsedAfter) {
      await tx.query(`update customers set status = 'lapsed' where id = $1`, [r.id]);
      await emit(tx, business.id, 'customer.lapsed', { type: 'customer', id: r.id }, { customer_id: r.id, days_since: Math.round(since) });
    }
    if (r.health_score !== score) changed++;
  }
  return { scored: rows.length, changed };
}

/**
 * Queue win-back messages at each threshold (default 60, 90, 180 days), once per
 * absence. Someone already past several thresholds gets only the latest one.
 */
export async function scheduleWinBacks(tx: Tx, business: Business, now = new Date()) {
  const cfg = business.pack.playbooks.win_back;
  if (!cfg.enabled || !cfg.days.length) return 0;
  const thresholds = [...cfg.days].sort((a, b) => a - b);
  const due = (await tx.query<{ id: string; last_visit_at: Date }>(
    `select c.id, c.last_visit_at from customers c
     where c.last_visit_at < $1::timestamptz - make_interval(days => $2) and c.sms_consent and not c.sms_opted_out
       and not exists (select 1 from bookings b where b.customer_id = c.id and b.status in ('confirmed','requested') and b.starts_at > $1)`,
    [now, thresholds[0]])).rows;
  let queued = 0;
  for (const c of due) {
    const since = (now.getTime() - new Date(c.last_visit_at).getTime()) / DAY;
    const days = thresholds.filter((d) => d <= since).at(-1)!;
    const id = await enqueue(tx, business.id, 'playbook_step', { playbook: 'win_back', step: 'send', customer_id: c.id, days }, {
      dedupeKey: `winback:${c.id}:${days}:${new Date(c.last_visit_at).toISOString().slice(0, 10)}`,
    });
    if (id) queued++;
  }
  return queued;
}
