import { templateData } from '../core/business.js';
import { chargeInvoice, createInvoice, dollars, getInvoice, payLink, receiptLink } from '../core/billing.js';
import { getCustomer } from '../core/customers.js';
import { enqueue } from '../core/jobs.js';
import { sendOrDraft } from '../core/messaging.js';
import { portalLink } from '../core/portal.js';
import { render } from '../lib/template.js';
import { addDays } from '../lib/time.js';
import type { Playbook, PlaybookContext } from './types.js';

async function invoiceText(ctx: PlaybookContext, invoiceId: string, templateKey: string) {
  const inv = await getInvoice(ctx.tx, invoiceId);
  if (!inv) return null;
  const customer = await getCustomer(ctx.tx, inv.customer_id);
  if (!customer) return null;
  const data = templateData(ctx.business, { ...customer }) as Record<string, any>;
  data.invoice = { amount: dollars(inv.amount_cents), number: inv.number, description: inv.description };
  data.links.pay = payLink(ctx.business, inv.id);
  data.links.receipt = receiptLink(ctx.business, inv.id);
  if (templateKey === 'payment_failed') data.links.card = await portalLink(ctx.tx, ctx.business, customer.id);
  return { inv, customer, body: render(ctx.business.pack.templates[templateKey] ?? '', data) };
}

/**
 * Get paid for every completed job: charge the saved card when the owner has
 * turned that on, otherwise text a secure pay link.
 */
export const paymentRequest: Playbook = {
  key: 'payment_request',
  on: ['job.completed'],
  async handle(ctx, event) {
    const { tx, business } = ctx;
    const b = (await tx.query<{ id: string; customer_id: string; price_cents: number | null; service: string | null }>(
      `select b.id, b.customer_id, b.price_cents, s.name as service from bookings b left join services s on s.id = b.service_id where b.id = $1`, [event.subject_id])).rows[0];
    if (!b || !b.price_cents) return;
    const existing = await tx.query(`select 1 from invoices where booking_id = $1 and status <> 'void'`, [b.id]);
    if (existing.rowCount) return;
    const inv = await createInvoice(tx, business, { customerId: b.customer_id, bookingId: b.id, amountCents: b.price_cents, description: b.service ?? business.pack.vocabulary.job.one });
    const cfg = business.pack.playbooks.payment_request;
    const card = (await tx.query<{ default_payment_method: string | null }>(`select default_payment_method from customers where id = $1`, [b.customer_id])).rows[0];
    if (cfg.auto_charge && card?.default_payment_method) {
      await enqueue(tx, business.id, 'playbook_step', { playbook: this.key, step: 'charge', invoice_id: inv.id }, { dedupeKey: `charge:${inv.id}:1` });
      return;
    }
    const t = await invoiceText(ctx, inv.id, 'payment_request');
    if (!t?.body) return;
    await sendOrDraft(tx, business.id, { customerId: b.customer_id, body: t.body, kind: 'transactional', playbook: this.key, trust: cfg.trust, reason: `Pay link for invoice #${inv.number}` });
  },
  steps: {
    async charge({ tx, business }, payload) {
      await chargeInvoice(tx, business, payload.invoice_id as string);
    },
  },
};

export const paymentReceipt: Playbook = {
  key: 'payment_receipt',
  on: ['invoice.paid'],
  async handle(ctx, event) {
    const t = await invoiceText(ctx, event.subject_id!, 'payment_receipt');
    if (!t?.body) return;
    await sendOrDraft(ctx.tx, ctx.business.id, { customerId: t.customer.id, body: t.body, kind: 'transactional', playbook: this.key, trust: ctx.business.pack.playbooks.payment_receipt.trust, reason: `Receipt for #${t.inv.number}` });
  },
};

/**
 * A declined card: tell the customer kindly with a link to update it, retry on the
 * pack's schedule, and retry straight away when they save a new card.
 */
export const paymentRecovery: Playbook = {
  key: 'payment_recovery',
  on: ['payment.failed', 'card.saved'],
  async handle(ctx, event) {
    const { tx, business, now } = ctx;
    const cfg = business.pack.playbooks.payment_recovery;
    if (event.type === 'card.saved') {
      const failed = (await tx.query<{ id: string; attempts: number }>(`select id, attempts from invoices where customer_id = $1 and status = 'failed'`, [event.data.customer_id])).rows;
      for (const inv of failed) await enqueue(tx, business.id, 'playbook_step', { playbook: this.key, step: 'retry', invoice_id: inv.id }, { dedupeKey: `recover:${inv.id}:card:${event.id}` });
      return;
    }
    const invoiceId = event.data.invoice_id as string;
    const inv = await getInvoice(tx, invoiceId);
    if (!inv) return;
    if (inv.attempts <= 1) {
      const t = await invoiceText(ctx, invoiceId, 'payment_failed');
      if (t?.body) await sendOrDraft(tx, business.id, { customerId: inv.customer_id, body: t.body, kind: 'transactional', playbook: this.key, trust: cfg.trust, reason: `Card declined for #${inv.number}` });
    }
    const nextDays = cfg.retry_days[inv.attempts - 1];
    if (nextDays !== undefined) {
      await enqueue(tx, business.id, 'playbook_step', { playbook: this.key, step: 'retry', invoice_id: invoiceId }, { runAt: addDays(now, nextDays), dedupeKey: `recover:${invoiceId}:${inv.attempts}` });
    }
  },
  steps: {
    async retry({ tx, business }, payload) {
      const inv = await getInvoice(tx, payload.invoice_id as string);
      if (!inv || inv.status !== 'failed') return;
      const card = (await tx.query<{ default_payment_method: string | null }>(`select default_payment_method from customers where id = $1`, [inv.customer_id])).rows[0];
      if (!card?.default_payment_method) return;
      await chargeInvoice(tx, business, inv.id);
    },
  },
};
