import type { PackInput } from './schema.js';

/**
 * The general service pack: jobs, appointments or sessions; quotes; one-off and
 * recurring work. Deliberately free of any trade's assumptions. Trade packs
 * (cleaning, fitness, grooming...) are further data files built the same way.
 */
export const generalService: PackInput = {
  id: 'general-service',
  name: 'General service business',
  version: 1,
  description: 'Jobs, appointments or sessions; fixed, hourly, formula or quoted prices; one-off and recurring work.',
  vocabulary: {
    customer: { one: 'customer', many: 'customers' },
    job: { one: 'job', many: 'jobs' },
    provider: { one: 'team member', many: 'team members' },
    booking_verb: 'book',
  },
  recurrence: {
    enabled: true,
    options: [
      { key: 'weekly', label: 'Every week', interval_days: 7 },
      { key: 'every_2_weeks', label: 'Every 2 weeks', interval_days: 14 },
      { key: 'every_4_weeks', label: 'Every 4 weeks', interval_days: 28 },
    ],
  },
  services: [
    { key: 'standard', name: 'Standard visit', duration_min: 60, price_rule: { type: 'fixed', amount_cents: 15000 } },
    { key: 'hourly', name: 'Hourly work', duration_min: 60, price_rule: { type: 'hourly', rate_cents: 7500 } },
    { key: 'custom', name: 'Custom project', duration_min: 120, price_rule: { type: 'quote' } },
  ],
  place_fields: [],
  playbooks: {
    missed_call_textback: { enabled: true, trust: 'auto' },
    lead_response: { enabled: true, trust: 'auto', follow_up_days: [1, 3, 7], follow_up_trust: 'draft' },
    review_request: { enabled: true, trust: 'draft', delay_hours: 2 },
    inbox_assist: { enabled: true, trust: 'draft' },
    booking_confirmation: { enabled: true, trust: 'auto' },
    booking_reminder: { enabled: true, trust: 'auto', hours_before: 24 },
    payment_request: { enabled: true, trust: 'auto', auto_charge: false },
    payment_receipt: { enabled: true, trust: 'auto' },
    payment_recovery: { enabled: true, trust: 'auto', retry_days: [2, 5] },
    first_visit_checkin: { enabled: true, trust: 'auto', delay_hours: 20 },
    at_risk_checkin: { enabled: true, trust: 'suggest' },
    win_back: { enabled: true, trust: 'draft', days: [60, 90, 180] },
    referral_ask: { enabled: true, trust: 'draft', after_visits: 3 },
    review_reply: { enabled: true, trust: 'draft' },
    job_photo_report: { enabled: true, trust: 'auto', delay_minutes: 30 },
    profile_posts: { enabled: true, trust: 'draft', weekday: 1 },
  },
  retention: { expected_interval_days: 45, lapsed_after_days: 90, at_risk_below: 50 },
  referrals: { enabled: true, reward_cents: 5000, friend_credit_cents: 5000 },
  scheduling: {
    slot_step_min: 30, min_notice_hours: 12, max_days_ahead: 30, buffer_min: 30, capacity: 1, series_horizon_days: 56,
    default_hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: '08:00', closes: '17:00' })),
  },
  guardrails: { quiet_hours: { start: '20:00', end: '08:00' }, max_automated_per_week: 3 },
  templates: {
    missed_call_textback: 'Hi, this is {{business.name}}. Sorry we missed your call! How can we help? You can also {{vocab.booking_verb}} online: {{links.booking}}',
    lead_instant_reply: 'Hi {{customer.first_name|there}}, thanks for reaching out to {{business.name}}! We will get back to you shortly. Want to grab a time now? {{links.booking}}',
    lead_follow_up_1: 'Hi {{customer.first_name|there}}, just checking in from {{business.name}}. Any questions I can answer?',
    lead_follow_up_2: 'Hi {{customer.first_name|there}}, we still have openings this week if you would like one: {{links.booking}}',
    lead_follow_up_3: 'Hi {{customer.first_name|there}}, last check-in from {{business.name}}. If the timing is not right, no problem. We are here when you need us.',
    booking_confirmation: 'You are booked with {{business.name}} for {{booking.when}}. Reply here with any questions. To change it: {{links.manage}}',
    booking_reminder: 'Reminder: your {{vocab.job.one}} with {{business.name}} is {{booking.when}}. Need to change it? {{links.manage}}',
    payment_request: 'Thanks, {{customer.first_name|there}}! Your total today is {{invoice.amount}}. Pay securely here: {{links.pay}}',
    payment_receipt: 'Payment received: {{invoice.amount}}. Thank you! Your receipt: {{links.receipt}}',
    payment_failed: 'Hi {{customer.first_name|there}}, your card was declined for {{invoice.amount}}. You can update it here: {{links.card}}',
    first_visit_checkin: 'Hi {{customer.first_name|there}}, it was great to meet you! How did your first {{vocab.job.one}} go? Reply with a number from 1 to 5 (5 = great).',
    feedback_low_reply: 'I\u2019m really sorry it wasn\u2019t right, {{customer.first_name|there}}. What should we have done better? I\u2019d like to make it right.',
    at_risk_checkin: 'Hi {{customer.first_name|there}}, just checking in from {{business.name}}. Is everything going well with your {{vocab.job.many}}? Anything we could do better?',
    win_back_60: 'Hi {{customer.first_name|there}}, it\u2019s been a while! Want us to get you back on the schedule? Pick a time here: {{links.booking}}',
    win_back_90: 'Hi {{customer.first_name|there}}, we\u2019d love to see you again at {{business.name}}. Here\u2019s a quick link to book: {{links.booking}}',
    win_back_180: 'Hi {{customer.first_name|there}}, {{business.name}} here. If you ever need us again, we\u2019re one tap away: {{links.booking}}',
    referral_ask: 'Thanks for being a great {{vocab.customer.one}}, {{customer.first_name|there}}! Know someone who\u2019d like us too? Share your link: they get {{referral.friend_credit}} off, and you get {{referral.reward}} credit. {{links.referral}}',
    review_reply_positive: 'Thank you so much, {{review.first_name|friend}}! We\u2019re so glad you\u2019re happy, and we look forward to seeing you again.',
    review_reply_negative: 'Thank you for telling us, {{review.first_name|}}. We\u2019re sorry we fell short. Please reach out to us directly so we can make it right.',
    profile_post: 'Another {{vocab.job.one}} done right for a happy {{vocab.customer.one}}. Book yours online in a minute.',
    job_photo_report: 'All done, {{customer.first_name|there}}! Here is how it turned out. Thanks for choosing {{business.name}}.',
    review_request: 'Thanks for choosing {{business.name}}, {{customer.first_name|there}}! If you have a minute, a review helps a small business like ours a lot: {{links.review}}',
  },
  reasons: {
    lost_quote: [
      { code: 'price', label: 'Price' }, { code: 'timing', label: 'Timing' },
      { code: 'chose_other', label: 'Chose someone else' }, { code: 'no_response', label: 'Stopped responding' },
      { code: 'not_a_fit', label: 'Not a fit' },
    ],
    cancel: [
      { code: 'price', label: 'Price' }, { code: 'quality', label: 'Quality' },
      { code: 'provider_change', label: 'Change of team member' }, { code: 'schedule', label: 'Schedule' },
      { code: 'moved', label: 'Moved away' }, { code: 'no_longer_needed', label: 'No longer needed' },
    ],
    joined: [
      { code: 'search', label: 'Search' }, { code: 'maps', label: 'Google Maps' },
      { code: 'referral', label: 'Referral' }, { code: 'social', label: 'Social media' },
      { code: 'ai_assistant', label: 'AI assistant' }, { code: 'other', label: 'Other' },
    ],
  },
  key_metric: { key: 'repeat_rate', label: 'Customers who come back' },
  website: {
    theme: 'clean',
    sections: ['hero', 'how_it_works', 'reviews', 'pricing', 'team_and_guarantee', 'areas_and_faq', 'final_cta'],
    hero_headline: '{{business.tagline}}',
    primary_cta: 'Get my price',
  },
};
