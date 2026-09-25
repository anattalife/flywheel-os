import { aiFor } from '../adapters/ai/index.js';
import type { ChatMessage } from '../adapters/ai/types.js';
import { links } from '../core/business.js';
import { getCustomer } from '../core/customers.js';
import { sendOrDraft } from '../core/messaging.js';
import { availableSlots } from '../core/scheduling.js';
import { validateAction } from '../core/actions.js';
import { friendlyWhen } from '../lib/tz.js';
import type { Playbook } from './types.js';

/** Pull the first JSON object out of a model reply; models sometimes wrap it in prose or code fences. */
export function parseModelJson(text: string): { reply?: string; action?: unknown } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/**
 * Inbox: when a customer texts, the chosen AI model drafts a reply in the owner's
 * voice and, when the customer clearly asks, proposes a booking change using only
 * times that are really open. Proposed changes always wait for the owner's OK.
 */
export const inboxAssist: Playbook = {
  key: 'inbox_assist',
  on: ['message.received'],
  async handle({ tx, business, now }, event) {
    const ai = aiFor(business.settings);
    if (!ai) return;
    const customerId = event.data.customer_id as string;
    const customer = await getCustomer(tx, customerId);
    if (!customer) return;
    const tz = business.timezone;
    const history = (await tx.query<{ direction: 'in' | 'out'; body: string }>(
      `select direction, body from (
         select direction, body, created_at from messages
         where customer_id = $1 and channel in ('sms','web') and body is not null and status in ('received','sent','delivered')
         order by created_at desc limit 12) t order by created_at`,
      [customerId],
    )).rows;
    const services = (await tx.query<{ key: string; name: string; duration_min: number; price_rule: { type: string; amount_cents?: number; rate_cents?: number } }>(
      `select key, name, duration_min, price_rule from services where active order by position, name`,
    )).rows;
    const priceOf = (p: { type: string; amount_cents?: number; rate_cents?: number }) =>
      p.type === 'fixed' ? `$${(p.amount_cents! / 100).toFixed(0)}` : p.type === 'hourly' ? `$${(p.rate_cents! / 100).toFixed(0)}/hour` : 'priced by quote';
    const upcoming = (await tx.query<{ id: string; starts_at: Date; service: string | null }>(
      `select b.id, b.starts_at, s.name as service from bookings b left join services s on s.id = b.service_id
       where b.customer_id = $1 and b.status in ('confirmed','requested') and b.starts_at > $2 order by b.starts_at limit 5`, [customerId, now])).rows;
    const mainService = services.find((s) => s.price_rule.type !== 'quote');
    const days = mainService ? await availableSlots(tx, business, { durationMin: mainService.duration_min, days: 7, now }) : [];
    const offered = days.flatMap((d) => d.slots.slice(0, 4)).slice(0, 16);
    const v = business.pack.vocabulary;
    const system = [
      `You draft SMS replies for ${business.name}, a small service business. The owner reviews every draft before it is sent.`,
      `Call people "${v.customer.many}" and the work "${v.job.many}". Be warm, brief (under 300 characters), plain and specific.`,
      `Never invent prices, availability, policies or promises that are not listed below. If unsure, say the owner will confirm.`,
      `Today is ${friendlyWhen(now, tz).split(' at ')[0]} (${tz}). Booking link: ${links(business).booking}`,
      `Services:\n${services.map((s) => `- ${s.name} [key ${s.key}]: ${priceOf(s.price_rule)}`).join('\n') || '- (none listed)'}`,
      `This ${v.customer.one}'s upcoming bookings:\n${upcoming.map((u) => `- [id ${u.id}] ${friendlyWhen(new Date(u.starts_at), tz)} ${u.service ?? ''}`).join('\n') || '- none'}`,
      `Open times you may offer (ISO start):\n${offered.map((o) => `- ${o} (${friendlyWhen(new Date(o), tz)})`).join('\n') || '- none this week'}`,
      business.settings?.ai_notes ? `Owner's notes: ${business.settings.ai_notes}` : '',
      `Respond with JSON only: {"reply": "<text message>", "action": null}. Only when the ${v.customer.one} clearly asks to book, move or cancel, and a listed time fits, set "action" to one of:`,
      `{"type":"book","service_key":"<key>","starts_at":"<ISO from the list>"}, {"type":"reschedule","booking_id":"<id>","starts_at":"<ISO from the list>"}, {"type":"cancel","booking_id":"<id>"}.`,
      `When you propose an action, the reply should confirm it as if done. Otherwise ask what they prefer, offering up to three listed times.`,
    ].filter(Boolean).join('\n\n');
    const messages: ChatMessage[] = history.map((h) => ({ role: h.direction === 'in' ? 'user' : 'assistant', content: h.body }));
    // The API needs the conversation to start with the customer.
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length) return;
    const out = await ai.complete({ system, messages, tier: 'strong', maxTokens: 400 });
    if (!out) return;
    const parsed = parseModelJson(out);
    const reply = (parsed?.reply ?? (parsed ? '' : out)).trim();
    if (!reply) return;
    const action = parsed?.action ? await validateAction(tx, business, customerId, parsed.action, offered) : null;
    await sendOrDraft(tx, business.id, {
      customerId,
      body: reply,
      kind: 'conversational',
      playbook: this.key,
      trust: business.pack.playbooks.inbox_assist.trust,
      reason: action?.summary ?? `Reply to ${customer.first_name ?? 'a ' + v.customer.one}`,
      action,
    });
  },
};
