import { friendlyWhen } from '../lib/tz.js';
import { html, money, page, raw } from './html.js';
import type { SiteContext } from './pages.js';

export interface PortalBooking { id: string; starts_at: Date; status: string; service: string | null; price_cents: number | null; series_id: string | null }
export interface PortalSeries { id: string; recurrence_label: string; service: string | null; status: 'active' | 'paused' | 'ended'; paused_until: Date | null }
export interface PortalData {
  first_name: string | null;
  bookings: PortalBooking[];
  series: PortalSeries[];
  cancelNoticeHours: number;
  reasons: { code: string; label: string }[];
  extras?: string; // HTML from later stages (payment card, referral code)
}

function portalShell(ctx: SiteContext, title: string, inner: ReturnType<typeof html>) {
  const b = ctx.business;
  const body = html`<header class="site-head"><div class="wrap head-row"><span class="brand">${b.name}</span>
  ${b.phone_number ? html`<a class="head-phone" href="sms:${b.phone_number}">Text us</a>` : ''}</div></header>
<main class="wrap narrow flow">${inner}</main>`;
  return page({ title: `${title} · ${b.name}`, body, themeHref: `${ctx.base}/theme.css`, noindex: true });
}

export function portalHome(ctx: SiteContext, token: string, d: PortalData, flash?: string): string {
  const tz = ctx.business.timezone;
  const v = ctx.business.pack.vocabulary;
  const base = `/m/${token}`;
  const now = Date.now();
  const canChange = (b: PortalBooking) => new Date(b.starts_at).getTime() - now > d.cancelNoticeHours * 3_600_000;
  const inner = html`<h1>Hi${d.first_name ? ' ' + d.first_name : ''}</h1>
${flash ? html`<p class="flash">${flash}</p>` : ''}
<h2>Coming up</h2>
${d.bookings.length ? html`<ul class="portal-list">${d.bookings.map((b) => html`<li class="card">
  <div><strong>${friendlyWhen(new Date(b.starts_at), tz)}</strong><br><span class="muted">${b.service ?? ''}${b.price_cents != null ? ' · ' + money(b.price_cents) : ''}</span></div>
  ${canChange(b) ? html`<div class="actions">
    <a class="btn btn-sm btn-ghost" href="${base}/b/${b.id}/move">Reschedule</a>
    ${b.series_id
      ? html`<form method="post" action="${base}/b/${b.id}/skip"><button class="btn btn-sm btn-ghost" type="submit">Skip this one</button></form>`
      : html`<details class="cancel"><summary class="btn btn-sm btn-ghost">Cancel</summary>
        <form method="post" action="${base}/b/${b.id}/cancel" class="form">
          <label>Mind telling us why?<select name="reason">${d.reasons.map((r) => html`<option value="${r.code}">${r.label}</option>`)}</select></label>
          <button class="btn btn-sm" type="submit">Cancel this ${v.job.one}</button></form></details>`}
  </div>` : html`<p class="muted small">Less than ${d.cancelNoticeHours} hours away. To change it, text us.</p>`}
</li>`)}</ul>` : html`<p class="card">Nothing booked right now. <a href="${ctx.base}/book">Book a time</a></p>`}

${d.series.filter((s) => s.status !== 'ended').length ? html`<h2>Your plan</h2>
<ul class="portal-list">${d.series.filter((s) => s.status !== 'ended').map((s) => html`<li class="card">
  <div><strong>${s.service ?? cap(v.job.one)}</strong> · ${s.recurrence_label}<br>
  <span class="muted">${s.status === 'paused' ? `Paused${s.paused_until ? ' until ' + friendlyWhen(new Date(s.paused_until), tz).split(' at ')[0] : ''}` : 'Active'}</span></div>
  <div class="actions">${s.status === 'paused'
    ? html`<form method="post" action="${base}/s/${s.id}/resume"><button class="btn btn-sm btn-accent" type="submit">Resume</button></form>`
    : html`<form method="post" action="${base}/s/${s.id}/pause" class="inline-form"><select name="weeks" aria-label="Pause for">
        <option value="2">2 weeks</option><option value="4" selected>4 weeks</option><option value="8">8 weeks</option></select>
        <button class="btn btn-sm btn-ghost" type="submit">Pause</button></form>`}</div>
</li>`)}</ul>
<p class="muted small">Pausing keeps your spot and your regular ${v.provider.one}. To stop for good, text us.</p>` : ''}
${d.extras ? raw(d.extras) : ''}`;
  return portalShell(ctx, 'Your bookings', inner);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function portalMove(ctx: SiteContext, token: string, booking: PortalBooking, days: { date: string; slots: string[] }[], error?: string): string {
  const tz = ctx.business.timezone;
  const label = (date: string) => new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
  const t = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const inner = html`<p><a href="/m/${token}">‹ Back</a></p><h1>Move your booking</h1>
<p class="summary">Now: <strong>${friendlyWhen(new Date(booking.starts_at), tz)}</strong></p>
${error ? html`<p class="flash error">${error}</p>` : ''}
<div class="days">${days.filter((d) => d.slots.length).map((d) => html`<section class="day"><h2>${label(d.date)}</h2><ul class="slots">
  ${d.slots.map((iso) => html`<li><form method="post" action="/m/${token}/b/${booking.id}/move"><input type="hidden" name="at" value="${iso}"><button class="slot" type="submit">${t(iso)}</button></form></li>`)}
</ul></section>`)}</div>`;
  return portalShell(ctx, 'Reschedule', inner);
}

export function portalGone(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link expired</title><link rel="stylesheet" href="/assets/site/site.css"></head>
<body><main class="wrap narrow flow"><h1>This link has expired</h1><p>For your security, booking links expire. Text the business and they’ll send you a new one.</p></main></body></html>`;
}
