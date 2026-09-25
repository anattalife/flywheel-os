import { z } from 'zod';
import { withSystem, withTenant, type Tx } from '../../db/pool.js';
import { HttpError, type Res } from '../../lib/http.js';
import { verifySig } from '../../lib/sign.js';
import { links, loadBusiness } from '../../core/business.js';
import {
  chargeInvoice, checkoutForCard, checkoutForInvoice, createInvoice, dollars, getInvoice, markPaid, payLink, receiptLink, refundInvoice, voidInvoice,
} from '../../core/billing.js';
import { sendOrDraft } from '../../core/messaging.js';
import { html, page, SITE_CSP } from '../../site/html.js';
import { owner, parse, router } from '../context.js';
import { portalExtras } from './portal.js';
import { resolvePortalToken } from '../../core/portal.js';

const uuid = z.string().uuid();
const idParam = (v: string) => { if (!uuid.safeParse(v).success) throw new HttpError(404, 'not found'); return v; };
const htmlRes = (text: string, status = 200): Res => ({ status, text, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': SITE_CSP, 'cache-control': 'no-store' } });

async function invoiceTenant(id: string): Promise<string> {
  const businessId = await withSystem(async (tx) => (await tx.query<{ b: string | null }>(`select invoice_business($1) as b`, [id])).rows[0].b);
  if (!businessId) throw new HttpError(404, 'not found');
  return businessId;
}

// ---- customer-facing: pay link and receipt -------------------------------------------

/** The link in a text. Makes a fresh hosted checkout each time, then sends the customer there. */
router.add('GET', '/pay/:id', async (req) => {
  const id = idParam(req.params.id);
  if (!verifySig('pay', id, req.query.get('t'))) throw new HttpError(404, 'not found');
  const businessId = await invoiceTenant(id);
  return withTenant(businessId, async (tx) => {
    const business = await loadBusiness(tx);
    const inv = await getInvoice(tx, id);
    if (!inv) throw new HttpError(404, 'not found');
    if (inv.status === 'paid' || inv.status === 'refunded') return { status: 303, text: '', headers: { location: receiptLink(business, id) } };
    if (inv.status === 'void') return htmlRes(simplePage(business.name, 'Nothing to pay', 'This invoice was cancelled. Nothing is owed.'));
    const { url } = await checkoutForInvoice(tx, business, id);
    return { status: 303, text: '', headers: { location: url } };
  });
});

router.add('GET', '/receipt/:id', async (req) => {
  const id = idParam(req.params.id);
  if (!verifySig('receipt', id, req.query.get('t'))) throw new HttpError(404, 'not found');
  const businessId = await invoiceTenant(id);
  return withTenant(businessId, async (tx) => {
    const business = await loadBusiness(tx);
    const inv = await getInvoice(tx, id);
    if (!inv) throw new HttpError(404, 'not found');
    const c = (await tx.query<{ first_name: string | null; last_name: string | null }>(`select first_name, last_name from customers where id = $1`, [inv.customer_id])).rows[0];
    const paid = inv.status === 'paid' || inv.status === 'refunded';
    const date = new Intl.DateTimeFormat('en-US', { timeZone: business.timezone, dateStyle: 'medium' }).format(new Date(inv.paid_at ?? inv.created_at));
    const body = html`<main class="wrap narrow flow"><div class="card receipt">
  <p class="muted">${business.name}</p>
  <h1>${paid ? 'Receipt' : 'Invoice'} #${inv.number}</h1>
  <p>${[c?.first_name, c?.last_name].filter(Boolean).join(' ')}</p>
  <table class="lines"><tr><td>${inv.description}</td><td>${dollars(inv.amount_cents)}</td></tr>
  ${inv.refunded_cents ? html`<tr><td>Refunded</td><td>−${dollars(inv.refunded_cents)}</td></tr>` : ''}
  <tr class="total"><td>${paid ? 'Paid' : 'Due'}</td><td>${dollars(inv.amount_cents - inv.refunded_cents)}</td></tr></table>
  <p class="muted">${paid ? `Paid ${date}` : `Issued ${date}`}${business.phone_number ? ` · Questions? Text ${business.phone_number}` : ''}</p>
  ${!paid && inv.status !== 'void' ? html`<a class="btn btn-accent" href="${payLink(business, inv.id)}">Pay ${dollars(inv.amount_cents)}</a>` : ''}
</div></main>`;
    return htmlRes(page({ title: `${paid ? 'Receipt' : 'Invoice'} #${inv.number} · ${business.name}`, body, themeHref: `/site/${business.id}/theme.css`, noindex: true }));
  });
});

function simplePage(name: string, title: string, text: string) {
  return page({ title, body: html`<main class="wrap narrow flow"><p class="muted">${name}</p><h1>${title}</h1><p>${text}</p></main>`, themeHref: '/assets/site/theme-clean.css', noindex: true });
}

// ---- portal: card on file and open invoices ----------------------------------------------

portalExtras.push(async (tx: Tx, customerId: string, token: string) => {
  const c = (await tx.query<{ card_brand: string | null; card_last4: string | null; default_payment_method: string | null }>(
    `select card_brand, card_last4, default_payment_method from customers where id = $1`, [customerId])).rows[0];
  const open = (await tx.query<{ id: string; number: number; amount_cents: number; description: string; status: string }>(
    `select id, number, amount_cents, description, status from invoices where customer_id = $1 and status in ('open','failed') order by created_at`, [customerId])).rows;
  const business = await loadBusiness(tx);
  return html`<h2>Payment</h2>
${open.length ? html`<ul class="portal-list">${open.map((i) => html`<li class="card"><div><strong>${dollars(i.amount_cents)}</strong> · ${i.description}<br>
  <span class="muted">Invoice #${i.number}${i.status === 'failed' ? ' · card declined' : ''}</span></div>
  <div class="actions"><a class="btn btn-sm btn-accent" href="${payLink(business, i.id)}">Pay now</a></div></li>`)}</ul>` : ''}
<div class="card"><p>${c?.default_payment_method ? `Card on file: ${c.card_brand ? c.card_brand.toUpperCase() : 'card'}${c.card_last4 ? ' ending ' + c.card_last4 : ''}` : 'No card on file.'}</p>
<form method="post" action="/m/${token}/card"><button class="btn btn-sm btn-ghost" type="submit">${c?.default_payment_method ? 'Update card' : 'Add a card'}</button></form></div>`.html;
});

router.add('POST', '/m/:token/card', async (req) => {
  const who = await resolvePortalToken(req.params.token);
  if (!who) throw new HttpError(410, 'This link has expired.');
  return withTenant(who.businessId, async (tx) => {
    const business = await loadBusiness(tx);
    const { url } = await checkoutForCard(tx, business, who.customerId, `${links(business).origin}/m/${req.params.token}`);
    return { status: 303, text: '', headers: { location: url } };
  });
});

// ---- owner -------------------------------------------------------------------------------------

router.add('GET', '/v1/invoices', owner(async (req) => {
  const r = await withTenant(req.businessId, (tx) => tx.query(
    `select i.*, c.first_name, c.last_name from invoices i join customers c on c.id = i.customer_id
     where ($1::text is null or i.status = $1) and ($2::uuid is null or i.customer_id = $2)
     order by i.created_at desc limit 200`, [req.query.get('status'), req.query.get('customer_id')]));
  return { json: r.rows };
}));

router.add('POST', '/v1/invoices', owner(async (req) => {
  const b = parse(z.object({ customer_id: z.string().uuid(), amount_cents: z.number().int().positive(), description: z.string().min(1).max(200), booking_id: z.string().uuid().optional() }), req.body);
  const inv = await withTenant(req.businessId, async (tx) => createInvoice(tx, await loadBusiness(tx), { customerId: b.customer_id, amountCents: b.amount_cents, description: b.description, bookingId: b.booking_id }));
  return { status: 201, json: inv };
}));

router.add('POST', '/v1/invoices/:id/send-link', owner(async (req) => {
  const id = idParam(req.params.id);
  await withTenant(req.businessId, async (tx) => {
    const business = await loadBusiness(tx);
    const inv = await getInvoice(tx, id);
    if (!inv || !['open', 'failed'].includes(inv.status)) throw new HttpError(409, 'Only unpaid invoices can be sent.');
    const c = (await tx.query<{ first_name: string | null }>(`select first_name from customers where id = $1`, [inv.customer_id])).rows[0];
    await sendOrDraft(tx, business.id, {
      customerId: inv.customer_id, kind: 'transactional', playbook: null, trust: 'auto',
      body: `Hi ${c?.first_name ?? 'there'}, here is your invoice from ${business.name} for ${dollars(inv.amount_cents)}: ${payLink(business, inv.id)}`,
    });
  });
  return { json: { ok: true } };
}));

router.add('POST', '/v1/invoices/:id/charge', owner(async (req) => ({
  json: await withTenant(req.businessId, async (tx) => chargeInvoice(tx, await loadBusiness(tx), idParam(req.params.id))),
})));

router.add('POST', '/v1/invoices/:id/mark-paid', owner(async (req) => {
  const b = parse(z.object({ method: z.enum(['cash', 'check', 'other']) }), req.body);
  const id = idParam(req.params.id);
  const ok = await withTenant(req.businessId, async (tx) => {
    const inv = await getInvoice(tx, id);
    if (!inv) throw new HttpError(404, 'invoice not found');
    return markPaid(tx, req.businessId, id, { providerId: null, amountCents: inv.amount_cents, method: b.method });
  });
  if (!ok) throw new HttpError(409, 'This invoice is already paid or void.');
  return { json: { ok: true } };
}));

router.add('POST', '/v1/invoices/:id/refund', owner(async (req) => {
  const b = parse(z.object({ amount_cents: z.number().int().positive().optional() }), req.body);
  return { json: await withTenant(req.businessId, async (tx) => refundInvoice(tx, await loadBusiness(tx), idParam(req.params.id), b.amount_cents)) };
}, { ownerOnly: true }));

router.add('POST', '/v1/invoices/:id/void', owner(async (req) => {
  await withTenant(req.businessId, (tx) => voidInvoice(tx, req.businessId, idParam(req.params.id)));
  return { json: { ok: true } };
}));
