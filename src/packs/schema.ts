import { z } from 'zod';

/**
 * An industry pack is data, not code. The engine knows nothing about any trade;
 * everything trade-specific (words, pricing, playbook timing, templates, the key
 * metric, the website theme) lives in a pack like the one below.
 */
const Word = z.object({ one: z.string().min(1), many: z.string().min(1) });

export const PriceRule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fixed'), amount_cents: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('hourly'),
    rate_cents: z.number().int().nonnegative(),
    min_minutes: z.number().int().positive().default(60),
    increment_minutes: z.number().int().positive().default(15),
  }),
  z.object({
    type: z.literal('formula'),
    base_cents: z.number().int().nonnegative(),
    inputs: z.array(z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('number'), key: z.string(), label: z.string(),
        per_unit_cents: z.number().int(), min: z.number().default(0), max: z.number().optional(), default: z.number().default(0),
      }),
      z.object({
        kind: z.literal('select'), key: z.string(), label: z.string(),
        options: z.array(z.object({ key: z.string(), label: z.string(), add_cents: z.number().int() })).min(1),
      }),
    ])).default([]),
    minimum_cents: z.number().int().nonnegative().default(0),
  }),
  z.object({ type: z.literal('quote') }),
]);
export type PriceRule = z.infer<typeof PriceRule>;

const Trust = z.enum(['suggest', 'draft', 'auto']);
export type Trust = z.infer<typeof Trust>;

const PlaybookBase = z.object({ enabled: z.boolean().default(true), trust: Trust.default('draft') });

export const METRIC_KEYS = ['repeat_rate', 'lead_to_booking', 'second_visit_7d', 'review_rate', 'referral_share'] as const;

const ReasonList = z.array(z.object({ code: z.string(), label: z.string() }));

export const Pack = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string(),
  version: z.number().int().positive(),
  description: z.string().default(''),
  vocabulary: z.object({
    customer: Word,
    job: Word,
    provider: Word,
    booking_verb: z.string().default('book'),
  }),
  recurrence: z.object({
    enabled: z.boolean().default(true),
    options: z.array(z.object({
      key: z.string(), label: z.string(),
      interval_days: z.number().int().positive(),
      discount_pct: z.number().min(0).max(100).default(0),
    })).default([]),
  }),
  services: z.array(z.object({
    key: z.string(), name: z.string(), description: z.string().default(''),
    duration_min: z.number().int().positive(), price_rule: PriceRule,
  })).default([]),
  place_fields: z.array(z.object({
    key: z.string(), label: z.string(),
    kind: z.enum(['text', 'number', 'select']),
    options: z.array(z.string()).optional(),
  })).default([]),
  // Every playbook has defaults, so packs saved before a playbook existed still load.
  playbooks: z.object({
    missed_call_textback: PlaybookBase.extend({ trust: Trust.default('auto') }).default({}),
    lead_response: PlaybookBase.extend({
      trust: Trust.default('auto'),
      follow_up_days: z.array(z.number().positive()).default([1, 3, 7]),
      follow_up_trust: Trust.default('draft'),
    }).default({}),
    review_request: PlaybookBase.extend({ delay_hours: z.number().nonnegative().default(2) }).default({}),
    inbox_assist: PlaybookBase.default({}),
    booking_confirmation: PlaybookBase.extend({ trust: Trust.default('auto') }).default({}),
    booking_reminder: PlaybookBase.extend({ trust: Trust.default('auto'), hours_before: z.number().positive().default(24) }).default({}),
    payment_request: PlaybookBase.extend({ trust: Trust.default('auto'), auto_charge: z.boolean().default(false) }).default({}),
    payment_receipt: PlaybookBase.extend({ trust: Trust.default('auto') }).default({}),
    payment_recovery: PlaybookBase.extend({ trust: Trust.default('auto'), retry_days: z.array(z.number().positive()).default([2, 5]) }).default({}),
    first_visit_checkin: PlaybookBase.extend({ trust: Trust.default('auto'), delay_hours: z.number().nonnegative().default(20) }).default({}),
    at_risk_checkin: PlaybookBase.extend({ trust: Trust.default('suggest') }).default({}),
    win_back: PlaybookBase.extend({ days: z.array(z.number().int().positive()).default([60, 90, 180]) }).default({}),
    referral_ask: PlaybookBase.extend({ after_visits: z.number().int().min(1).default(3) }).default({}),
    review_reply: PlaybookBase.default({}),
    job_photo_report: PlaybookBase.extend({ trust: Trust.default('auto'), delay_minutes: z.number().int().min(0).default(30) }).default({}),
    profile_posts: PlaybookBase.extend({ weekday: z.number().int().min(0).max(6).default(1) }).default({}),
  }).default({}),
  retention: z.object({
    expected_interval_days: z.number().int().positive().default(45),
    lapsed_after_days: z.number().int().positive().default(90),
    at_risk_below: z.number().int().min(1).max(99).default(50),
  }).default({}),
  referrals: z.object({
    enabled: z.boolean().default(true),
    reward_cents: z.number().int().nonnegative().default(5000),
    friend_credit_cents: z.number().int().nonnegative().default(5000),
  }).default({}),
  scheduling: z.object({
    slot_step_min: z.number().int().min(5).max(240).default(30),
    min_notice_hours: z.number().min(0).default(12),
    max_days_ahead: z.number().int().min(1).max(365).default(30),
    buffer_min: z.number().int().min(0).default(0),
    capacity: z.number().int().min(1).default(1),
    series_horizon_days: z.number().int().min(14).max(180).default(56),
    default_hours: z.array(z.object({
      weekday: z.number().int().min(0).max(6),
      opens: z.string().regex(/^\d\d:\d\d$/), closes: z.string().regex(/^\d\d:\d\d$/),
    })).default([1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: '09:00', closes: '17:00' }))),
  }).default({}),
  guardrails: z.object({
    quiet_hours: z.object({ start: z.string().regex(/^\d\d:\d\d$/), end: z.string().regex(/^\d\d:\d\d$/) }).default({ start: '20:00', end: '08:00' }),
    max_automated_per_week: z.number().int().positive().default(3),
  }).default({}),
  templates: z.record(z.string()),
  reasons: z.object({ lost_quote: ReasonList, cancel: ReasonList, joined: ReasonList }),
  key_metric: z.object({ key: z.enum(METRIC_KEYS), label: z.string() }),
  website: z.object({
    theme: z.string(),
    sections: z.array(z.string()),
    hero_headline: z.string(),
    primary_cta: z.string(),
  }),
});
export type Pack = z.infer<typeof Pack>;
export type PackInput = z.input<typeof Pack>;
