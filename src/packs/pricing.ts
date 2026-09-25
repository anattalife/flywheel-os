import type { Pack, PriceRule } from './schema.js';

export interface Quote { amount_cents: number | null; lines: { label: string; cents: number }[]; needs_owner_quote: boolean }

/** Price a service from its rule, the customer's inputs and an optional recurrence. */
export function priceService(rule: PriceRule, inputs: Record<string, unknown> = {}, recurrence?: Pack['recurrence']['options'][number]): Quote {
  const lines: Quote['lines'] = [];
  let total: number;
  switch (rule.type) {
    case 'quote':
      return { amount_cents: null, lines: [], needs_owner_quote: true };
    case 'fixed':
      total = rule.amount_cents;
      lines.push({ label: 'Base price', cents: total });
      break;
    case 'hourly': {
      const requested = Number(inputs.minutes ?? rule.min_minutes);
      const minutes = Math.max(rule.min_minutes, Math.ceil(requested / rule.increment_minutes) * rule.increment_minutes);
      total = Math.round((rule.rate_cents * minutes) / 60);
      lines.push({ label: `${minutes} minutes`, cents: total });
      break;
    }
    case 'formula': {
      total = rule.base_cents;
      lines.push({ label: 'Base price', cents: rule.base_cents });
      for (const input of rule.inputs) {
        if (input.kind === 'number') {
          let n = Number(inputs[input.key] ?? input.default);
          if (!Number.isFinite(n)) n = input.default;
          n = Math.max(input.min, input.max !== undefined ? Math.min(input.max, n) : n);
          const cents = n * input.per_unit_cents;
          if (cents) lines.push({ label: `${input.label} × ${n}`, cents });
          total += cents;
        } else {
          const chosen = input.options.find((o) => o.key === inputs[input.key]) ?? input.options[0];
          if (chosen.add_cents) lines.push({ label: `${input.label}: ${chosen.label}`, cents: chosen.add_cents });
          total += chosen.add_cents;
        }
      }
      total = Math.max(total, rule.minimum_cents);
      break;
    }
  }
  if (recurrence && recurrence.discount_pct > 0) {
    const discount = -Math.round((total * recurrence.discount_pct) / 100);
    lines.push({ label: `${recurrence.label} discount`, cents: discount });
    total += discount;
  }
  return { amount_cents: total, lines, needs_owner_quote: false };
}
