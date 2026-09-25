import { z } from 'zod';
import type { Business } from '../core/business.js';
import type { PriceRule } from '../packs/schema.js';
import { money } from './html.js';

export const THEMES = ['clean', 'bold', 'soft'] as const;
export const THEME_ACCENTS: Record<(typeof THEMES)[number], string> = { clean: '#1E6B52', bold: '#E4572E', soft: '#5B5BD6' };

/** Everything the owner can change about their website, with sensible defaults. */
export const SiteSettings = z.object({
  theme: z.enum(THEMES).default('clean'),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  headline: z.string().max(90).optional(),
  subline: z.string().max(220).optional(),
  about: z.string().max(1200).optional(),
  guarantee: z.string().max(400).optional(),
  badges: z.array(z.string().max(40)).max(4).default([]),
  service_area: z.string().max(300).optional(),
  areas: z.array(z.string().max(60)).max(40).default([]),
  faq: z.array(z.object({ q: z.string().max(200), a: z.string().max(1000) })).max(20).default([]),
  steps: z.array(z.string().max(120)).length(3).optional(),
  photo_url: z.string().url().optional(),
  show_prices: z.boolean().default(true),
  published: z.boolean().default(true),
}).strict();
export type SiteSettings = z.infer<typeof SiteSettings>;

export function siteSettings(b: Business): SiteSettings {
  const r = SiteSettings.safeParse(b.settings?.site ?? {});
  return r.success ? r.data : SiteSettings.parse({});
}

export function accentOf(s: SiteSettings) {
  return s.accent ?? THEME_ACCENTS[s.theme];
}

/** Readable text color on top of a hex background. */
export function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#FFFFFF';
}

export function priceLabel(rule: PriceRule): string {
  switch (rule.type) {
    case 'fixed': return money(rule.amount_cents);
    case 'hourly': return `${money(rule.rate_cents)}/hour`;
    case 'formula': return `from ${money(Math.max(rule.base_cents, rule.minimum_cents ?? 0))}`;
    case 'quote': return 'Free quote';
  }
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const t12 = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

/** "Mon–Fri 8 AM–5 PM · Sat 10 AM–2 PM" */
export function hoursSummary(hours: { weekday: number; opens: string; closes: string }[]): string {
  const byDay = new Map<number, string>();
  for (const h of hours) byDay.set(h.weekday, [byDay.get(h.weekday), `${t12(h.opens)}–${t12(h.closes)}`].filter(Boolean).join(', '));
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups: { from: number; to: number; text: string }[] = [];
  for (const d of order) {
    const text = byDay.get(d);
    if (!text) continue;
    const last = groups.at(-1);
    if (last && last.text === text && order.indexOf(d) === order.indexOf(last.to) + 1) last.to = d;
    else groups.push({ from: d, to: d, text });
  }
  return groups.map((g) => `${DAY[g.from]}${g.from !== g.to ? '–' + DAY[g.to] : ''} ${g.text}`).join(' · ') || 'By appointment';
}

export function openingHoursSpec(hours: { weekday: number; opens: string; closes: string }[]) {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return hours.map((h) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: names[h.weekday], opens: h.opens, closes: h.closes }));
}
