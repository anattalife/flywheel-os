import { z } from 'zod';
import { aiFor } from '../adapters/ai/index.js';
import { messaging } from '../adapters/messaging/index.js';
import type { Tx } from '../db/pool.js';
import { friendlyWhen, localParts, zonedTime } from '../lib/tz.js';
import type { Business } from './business.js';
import { dailyBrief } from './intelligence.js';
import { approveDraft, queueMessage } from './messaging.js';
import { rescheduleBooking } from './scheduling.js';
import { emit } from './events.js';
import { parseModelJson } from '../playbooks/inbox-assist.js';

/**
 * The owner can run the business by texting the business number from their own
 * phone. Simple keywords work without AI; with AI on, plain requests like "move
 * Maria to Thursday at 10" are understood. Anything that changes a booking or
 * texts a customer asks for YES first.
 */
const HELP = [
  'Text me:',
  'today - your day at a glance',
  'drafts - messages waiting for your OK',
  'approve 2 / approve all',
  'late 15 - tell your next customer you are running 15 min late',
  'Or just say it: "move Maria to Thursday 10am", "block Friday afternoon", "text James: see you at 2".',
].join('\n');

const Intent = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('move_booking'), booking_id: z.string().uuid(), new_start_local: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/) }),
  z.object({ intent: z.literal('block_time'), start_local: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/), end_local: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/), reason: z.string().max(100).optional() }),
  z.object({ intent: z.literal('text_customer'), customer_id: z.string().uuid(), message: z.string().min(1).max(500) }),
  z.object({ intent: z.literal('unknown') }),
]);
type Action =
  | { type: 'move'; booking_id: string; starts_at: string }
  | { type: 'block'; starts_at: string; ends_at: string; reason?: string }
  | { type: 'text'; customer_id: string; message: string };

async function reply(business: Business, to: string, body: string) {
  await messaging().sendSms({ from: business.phone_number ?? '', to, body });
  return body;
}

async function pendingDrafts(tx: Tx) {
  return (await tx.query<{ id: string; body: string; first_name: string | null; phone: string | null }>(
    `select d.id, d.body, c.first_name, c.phone from drafts d join customers c on c.id = d.customer_id where d.status = 'pending' order by d.created_at limit 9`)).rows;
}

async function confirm(tx: Tx, business: Business, user: { id: string; phone: string }, summary: string, action: Action) {
  await tx.query(`update owner_commands set status = 'cancelled' where user_id = $1 and status = 'pending'`, [user.id]);
  await tx.query(`insert into owner_commands (business_id, user_id, summary, action) values ($1, $2, $3, $4)`, [business.id, user.id, summary, action]);
  return reply(business, user.phone, `${summary}\nReply YES to confirm or NO to cancel.`);
}

async function execute(tx: Tx, business: Business, a: Action): Promise<string> {
  if (a.type === 'move') {
    await rescheduleBooking(tx, business, a.booking_id, new Date(a.starts_at), { enforceHours: false, by: 'owner_text' });
    return `Done. Moved to ${friendlyWhen(new Date(a.starts_at), business.timezone)}. The customer has been texted.`;
  }
  if (a.type === 'block') {
    await tx.query(`insert into time_off (business_id, starts_at, ends_at, reason) values ($1, $2, $3, $4)`, [business.id, a.starts_at, a.ends_at, a.reason ?? 'Blocked by text']);
    return `Done. ${friendlyWhen(new Date(a.starts_at), business.timezone)} to ${friendlyWhen(new Date(a.ends_at), business.timezone)} is blocked.`;
  }
  await queueMessage(tx, business.id, { customerId: a.customer_id, body: a.message, kind: 'conversational', playbook: null, draftId: null });
  return 'Sent.';
}

export async function handleOwnerText(tx: Tx, business: Business, user: { id: string; phone: string }, text: string, now = new Date()): Promise<string> {
  const body = text.trim();
  const lower = body.toLowerCase();
  const tz = business.timezone;
  await emit(tx, business.id, 'owner.command', null, { text: body.slice(0, 200) });

  // Answering a pending question?
  if (/^(yes|y|yep|confirm|ok)[.!]?$/.test(lower) || /^(no|n|cancel|stop that)[.!]?$/.test(lower)) {
    const p = (await tx.query<{ id: string; action: Action }>(
      `select id, action from owner_commands where user_id = $1 and status = 'pending' and expires_at > $2 order by created_at desc limit 1`, [user.id, now])).rows[0];
    if (!p) return reply(business, user.phone, 'Nothing is waiting for a yes or no. Text "help" for commands.');
    if (lower.startsWith('n') || lower.startsWith('c') || lower.startsWith('s')) {
      await tx.query(`update owner_commands set status = 'cancelled' where id = $1`, [p.id]);
      return reply(business, user.phone, 'OK, cancelled.');
    }
    await tx.query('savepoint cmd');
    try {
      const msg = await execute(tx, business, p.action);
      await tx.query(`update owner_commands set status = 'done' where id = $1`, [p.id]);
      return reply(business, user.phone, msg);
    } catch (e) {
      await tx.query('rollback to savepoint cmd');
      return reply(business, user.phone, `That didn't work: ${(e as Error).message}`);
    }
  }

  if (lower === 'help' || lower === '?') return reply(business, user.phone, HELP);
  if (lower === 'today' || lower === 'brief') return reply(business, user.phone, await dailyBrief(tx, business, now));

  if (lower === 'drafts') {
    const d = await pendingDrafts(tx);
    if (!d.length) return reply(business, user.phone, 'No drafts waiting.');
    return reply(business, user.phone, d.map((x, i) => `${i + 1}) To ${x.first_name ?? x.phone}: ${x.body.slice(0, 90)}${x.body.length > 90 ? '…' : ''}`).join('\n') + '\nText "approve 1" or "approve all".');
  }

  const approve = lower.match(/^approve\s+(all|\d)$/);
  if (approve) {
    const d = await pendingDrafts(tx);
    const pick = approve[1] === 'all' ? d : [d[Number(approve[1]) - 1]].filter(Boolean);
    if (!pick.length) return reply(business, user.phone, 'No draft with that number. Text "drafts" to see them.');
    let sent = 0;
    for (const x of pick) {
      await tx.query('savepoint ap');
      try { await approveDraft(tx, business.id, x.id); sent++; await tx.query('release savepoint ap'); }
      catch { await tx.query('rollback to savepoint ap'); }
    }
    return reply(business, user.phone, `Approved ${sent} of ${pick.length}.`);
  }

  const late = lower.match(/^(?:running\s+)?late\s+(\d{1,3})/);
  if (late) {
    const next = (await tx.query<{ customer_id: string; first_name: string | null; starts_at: Date }>(
      `select b.customer_id, c.first_name, b.starts_at from bookings b join customers c on c.id = b.customer_id
       where b.status = 'confirmed' and b.starts_at > $1::timestamptz - interval '30 minutes' order by b.starts_at limit 1`, [now])).rows[0];
    if (!next) return reply(business, user.phone, 'No upcoming job to tell.');
    const message = `Hi ${next.first_name ?? 'there'}, it's ${business.name}. Running about ${late[1]} minutes late, sorry! See you soon.`;
    return confirm(tx, business, user, `Text ${next.first_name ?? 'your next customer'}: "${message}"`, { type: 'text', customer_id: next.customer_id, message });
  }

  // Free-form: let the AI work out what's meant, using real bookings and customers.
  const ai = aiFor(business.settings);
  if (!ai) return reply(business, user.phone, `I didn't catch that. ${HELP}`);
  const bookings = (await tx.query<{ id: string; starts_at: Date; first_name: string | null; last_name: string | null }>(
    `select b.id, b.starts_at, c.first_name, c.last_name from bookings b join customers c on c.id = b.customer_id
     where b.status in ('confirmed','requested') and b.starts_at > $1 and b.starts_at < $1::timestamptz + interval '21 days' order by b.starts_at limit 40`, [now])).rows;
  const customers = (await tx.query<{ id: string; first_name: string | null; last_name: string | null }>(
    `select id, first_name, last_name from customers where first_name is not null order by coalesce(last_visit_at, created_at) desc limit 60`)).rows;
  const today = localParts(now, tz);
  const system = [
    'Turn the business owner\'s text into exactly one JSON command. Times are local to the business.',
    `Now: ${today.date} ${today.time}, ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now)} (${tz}).`,
    `Upcoming bookings:\n${bookings.map((b) => `- ${b.id}: ${[b.first_name, b.last_name].filter(Boolean).join(' ')} at ${localParts(new Date(b.starts_at), tz).date} ${localParts(new Date(b.starts_at), tz).time}`).join('\n') || '- none'}`,
    `Customers:\n${customers.map((c) => `- ${c.id}: ${[c.first_name, c.last_name].filter(Boolean).join(' ')}`).join('\n')}`,
    'Commands: {"intent":"move_booking","booking_id":"...","new_start_local":"YYYY-MM-DDTHH:MM"} | {"intent":"block_time","start_local":"YYYY-MM-DDTHH:MM","end_local":"YYYY-MM-DDTHH:MM","reason":"..."} | {"intent":"text_customer","customer_id":"...","message":"..."} | {"intent":"unknown"}.',
    '"Afternoon" means 12:00-17:00, "morning" 08:00-12:00, a whole day 00:00-23:59. Reply with JSON only.',
  ].join('\n');
  const out = await ai.complete({ system, messages: [{ role: 'user', content: body }], tier: 'fast', maxTokens: 200 }).catch(() => '');
  const p = Intent.safeParse(parseModelJson(out));
  if (!p.success || p.data.intent === 'unknown') return reply(business, user.phone, `I didn't catch that. ${HELP}`);
  const i = p.data;
  const toUtc = (local: string) => zonedTime(local.slice(0, 10), local.slice(11, 16), tz);
  if (i.intent === 'move_booking') {
    const b = bookings.find((x) => x.id === i.booking_id);
    if (!b) return reply(business, user.phone, 'I couldn\'t find that booking. Try with the customer\'s full name.');
    const at = toUtc(i.new_start_local);
    return confirm(tx, business, user, `Move ${b.first_name ?? 'booking'} from ${friendlyWhen(new Date(b.starts_at), tz)} to ${friendlyWhen(at, tz)}?`, { type: 'move', booking_id: b.id, starts_at: at.toISOString() });
  }
  if (i.intent === 'block_time') {
    const s = toUtc(i.start_local), e = toUtc(i.end_local);
    if (e <= s) return reply(business, user.phone, 'That time range doesn\'t add up. Try again with a start and end.');
    const clash = (await tx.query<{ n: number }>(`select count(*)::int as n from bookings where status in ('confirmed','requested') and starts_at < $2 and ends_at > $1`, [s, e])).rows[0].n;
    return confirm(tx, business, user, `Block ${friendlyWhen(s, tz)} to ${friendlyWhen(e, tz)}?${clash ? ` Note: ${clash} booking${clash > 1 ? 's are' : ' is'} already in that time.` : ''}`, { type: 'block', starts_at: s.toISOString(), ends_at: e.toISOString(), reason: i.reason });
  }
  const c = customers.find((x) => x.id === i.customer_id);
  if (!c) return reply(business, user.phone, 'I couldn\'t find that customer.');
  return confirm(tx, business, user, `Text ${c.first_name}: "${i.message}"?`, { type: 'text', customer_id: c.id, message: i.message });
}

