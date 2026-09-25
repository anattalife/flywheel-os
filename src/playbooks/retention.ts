import { templateData } from '../core/business.js';
import { getCustomer } from '../core/customers.js';
import { enqueue } from '../core/jobs.js';
import { sendOrDraft } from '../core/messaging.js';
import { convertReferral, referralCode, referralLink } from '../core/referrals.js';
import { dollars } from '../core/billing.js';
import { render } from '../lib/template.js';
import { addHours } from '../lib/time.js';
import type { Playbook, PlaybookContext } from './types.js';

async function text(ctx: PlaybookContext, customerId: string, key: string, extra: Record<string, unknown> = {}) {
  const c = await getCustomer(ctx.tx, customerId);
  if (!c) return null;
  const data = templateData(ctx.business, { ...c }) as Record<string, any>;
  Object.assign(data, extra);
  const t = ctx.business.pack.templates[key];
  return t ? render(t, data) : null;
}

/**
 * After someone's first visit: ask how it went (reply 1-5). A low score goes to
 * the owner with a suggested apology. Every customer still gets the normal review
 * request whatever they answer, so reviews are never filtered by happiness.
 */
export const firstVisitCheckin: Playbook = {
  key: 'first_visit_checkin',
  on: ['job.completed', 'feedback.received'],
  async handle(ctx, event) {
    const { tx, business, now } = ctx;
    if (event.type === 'job.completed') {
      if (!event.data.first_visit) return;
      await enqueue(tx, business.id, 'playbook_step', { playbook: this.key, step: 'ask', customer_id: event.data.customer_id }, {
        runAt: addHours(now, business.pack.playbooks.first_visit_checkin.delay_hours), dedupeKey: `checkin:${event.data.customer_id}`,
      });
      return;
    }
    if (Number(event.data.rating) <= 3) {
      const body = await text(ctx, event.data.customer_id as string, 'feedback_low_reply');
      if (body) await sendOrDraft(tx, business.id, { customerId: event.data.customer_id as string, body, kind: 'conversational', playbook: this.key, trust: 'suggest', reason: `Rated their first visit ${event.data.rating}/5` });
    }
  },
  steps: {
    async ask(ctx, payload) {
      const body = await text(ctx, payload.customer_id as string, 'first_visit_checkin');
      if (!body) return;
      await sendOrDraft(ctx.tx, ctx.business.id, { customerId: payload.customer_id as string, body, kind: 'transactional', playbook: 'first_visit_checkin', trust: ctx.business.pack.playbooks.first_visit_checkin.trust, reason: 'After their first visit' });
    },
  },
};

/** Health score dropped below the line: suggest a personal check-in, with the reasons. */
export const atRiskCheckin: Playbook = {
  key: 'at_risk_checkin',
  on: ['customer.at_risk'],
  async handle(ctx, event) {
    const body = await text(ctx, event.data.customer_id as string, 'at_risk_checkin');
    if (!body) return;
    const reasons = (event.data.reasons as string[] | undefined)?.join('; ') ?? 'health score dropped';
    await sendOrDraft(ctx.tx, ctx.business.id, { customerId: event.data.customer_id as string, body, kind: 'conversational', playbook: this.key, trust: ctx.business.pack.playbooks.at_risk_checkin.trust, reason: `At risk: ${reasons}` });
  },
};

export const winBack: Playbook = {
  key: 'win_back',
  on: [],
  async handle() { /* scheduled daily by scheduleWinBacks */ },
  steps: {
    async send(ctx, payload) {
      const id = payload.customer_id as string;
      const booked = await ctx.tx.query(`select 1 from bookings where customer_id = $1 and status in ('confirmed','requested') and starts_at > now() limit 1`, [id]);
      if (booked.rowCount) return;
      const days = Number(payload.days);
      const key = ctx.business.pack.templates[`win_back_${days}`] ? `win_back_${days}` : 'win_back_60';
      const body = await text(ctx, id, key);
      if (!body) return;
      await sendOrDraft(ctx.tx, ctx.business.id, { customerId: id, body, kind: 'marketing', playbook: 'win_back', trust: ctx.business.pack.playbooks.win_back.trust, reason: `No visit in ${days} days` });
    },
  },
};

/**
 * Referrals: reward the referrer when a referred friend's first job is done, and
 * ask loyal customers to share after their Nth visit.
 */
export const referralAsk: Playbook = {
  key: 'referral_ask',
  on: ['job.completed'],
  async handle(ctx, event) {
    const { tx, business } = ctx;
    const customerId = event.data.customer_id as string;
    if (event.data.first_visit) await convertReferral(tx, business, customerId);
    if (!business.pack.referrals.enabled) return;
    const visits = (await tx.query<{ n: number }>(`select count(*)::int as n from bookings where customer_id = $1 and status = 'completed'`, [customerId])).rows[0].n;
    if (visits !== business.pack.playbooks.referral_ask.after_visits) return;
    const code = await referralCode(tx, customerId);
    const body = await text(ctx, customerId, 'referral_ask', {
      referral: { reward: dollars(business.pack.referrals.reward_cents), friend_credit: dollars(business.pack.referrals.friend_credit_cents), code },
      links: { ...(templateData(business).links), referral: referralLink(business, code) },
    });
    if (!body) return;
    await sendOrDraft(tx, business.id, { customerId, body, kind: 'marketing', playbook: this.key, trust: business.pack.playbooks.referral_ask.trust, reason: `${visits} visits: ask for referrals` });
  },
};
