import type { Business } from '../core/business.js';
import type { PriceRule } from '../packs/schema.js';
import { friendlyWhen, localParts } from '../lib/tz.js';
import { html, money, page, raw, type Raw } from './html.js';
import { hoursSummary, openingHoursSpec, priceLabel, type SiteSettings } from './settings.js';

export interface SiteService { key: string; name: string; description: string | null; duration_min: number; price_rule: PriceRule }
export interface SiteReview { rating: number; body: string | null; first_name: string | null; created_at: Date }
export interface SiteContext {
  business: Business;
  site: SiteSettings;
  base: string;          // path prefix for links: '' on a custom domain, '/site/<id>' otherwise
  canonicalOrigin: string;
  services: SiteService[];
  hours: { weekday: number; opens: string; closes: string }[];
  rating: { avg: number | null; count: number };
  reviews: SiteReview[];
  nextOpening?: { at: string; service: SiteService } | null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const telHref = (p: string | null) => (p ? `tel:${p}` : null);
const smsHref = (p: string | null) => (p ? `sms:${p}` : null);
const prettyPhone = (p: string | null) => {
  const m = p?.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p ?? '';
};

function themeHref(ctx: SiteContext) {
  return `${ctx.base}/theme.css?v=${encodeURIComponent(ctx.site.theme + (ctx.site.accent ?? ''))}`;
}

function header(ctx: SiteContext, { cta = true } = {}): Raw {
  const b = ctx.business;
  return html`<header class="site-head"><div class="wrap head-row">
  <a class="brand" href="${ctx.base || '/'}">${b.name}</a>
  <nav class="head-actions">
    ${b.phone_number ? html`<a class="head-phone" href="${telHref(b.phone_number)}">${prettyPhone(b.phone_number)}</a>` : ''}
    ${cta ? html`<a class="btn btn-accent btn-sm" href="${ctx.base}/book">${cap(b.pack.vocabulary.booking_verb)}</a>` : ''}
  </nav></div></header>`;
}

function footer(ctx: SiteContext): Raw {
  const b = ctx.business;
  return html`<footer class="site-foot"><div class="wrap foot-grid">
  <div><strong>${b.name}</strong>${ctx.site.service_area ? html`<p>${ctx.site.service_area}</p>` : ''}</div>
  <div><p>${hoursSummary(ctx.hours)}</p>${b.phone_number ? html`<p><a href="${telHref(b.phone_number)}">${prettyPhone(b.phone_number)}</a></p>` : ''}</div>
  <div><p><a href="${ctx.base}/privacy">Privacy</a> · <a href="${ctx.base}/terms">Terms</a></p></div>
</div></footer>`;
}

function stars(n: number) {
  const full = Math.round(n);
  return html`<span class="stars" aria-label="${n.toFixed(1)} out of 5">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span>`;
}

export function homePage(ctx: SiteContext, flash?: string): string {
  const { business: b, site } = ctx;
  const v = b.pack.vocabulary;
  const headline = site.headline ?? b.settings?.tagline ?? b.name;
  const subline = site.subline ?? `Book online in a minute. Clear prices, reliable ${v.provider.many}, and ${v.job.many} done right.`;
  const steps = site.steps ?? [`See your price and pick a time online.`, `We show up on time and do the ${v.job.one}.`, `Pay when it’s done. Not happy? We make it right.`];
  const bookable = ctx.services;
  const ld: unknown[] = [{
    '@context': 'https://schema.org', '@type': 'LocalBusiness', name: b.name, url: ctx.canonicalOrigin + (ctx.base || '/'),
    telephone: b.phone_number ?? undefined, areaServed: site.areas.length ? site.areas : site.service_area,
    openingHoursSpecification: openingHoursSpec(ctx.hours),
    ...(ctx.rating.count ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: ctx.rating.avg?.toFixed(1), reviewCount: ctx.rating.count } } : {}),
    ...(site.photo_url ? { image: site.photo_url } : {}),
  }];
  if (site.faq.length) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: site.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });

  const body = html`
${header(ctx)}
<main>
<section class="hero"><div class="wrap hero-grid">
  <div class="hero-copy">
    ${ctx.rating.count >= 3 ? html`<p class="proof">${stars(ctx.rating.avg ?? 5)} <span>${ctx.rating.avg?.toFixed(1)} from ${ctx.rating.count} reviews</span></p>` : ''}
    <h1>${headline}</h1>
    <p class="lede">${subline}</p>
    <div class="cta-row">
      <a class="btn btn-accent btn-lg" href="${ctx.base}/book">${b.pack.website.primary_cta}</a>
      ${b.phone_number ? html`<a class="btn btn-ghost btn-lg" href="${smsHref(b.phone_number)}">Text us</a>` : ''}
    </div>
    ${site.badges.length ? html`<ul class="badges">${site.badges.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
  </div>
  ${site.photo_url ? html`<img class="hero-photo" src="${site.photo_url}" alt="${b.name}">`
    : ctx.nextOpening ? html`<aside class="card next-card">
      <p class="next-label">Next opening</p>
      <p class="next-time">${friendlyWhen(new Date(ctx.nextOpening.at), b.timezone)}</p>
      <p class="muted">${ctx.nextOpening.service.name}${site.show_prices ? ' · ' + priceLabel(ctx.nextOpening.service.price_rule) : ''}</p>
      <a class="btn btn-accent" href="${ctx.base}/book/details?service=${encodeURIComponent(ctx.nextOpening.service.key)}&at=${encodeURIComponent(ctx.nextOpening.at)}">Take this time</a>
      <a class="more" href="${ctx.base}/book">See all times</a>
    </aside>` : ''}
</div></section>

${flash ? html`<div class="wrap"><p class="flash">${flash}</p></div>` : ''}

<section class="band"><div class="wrap">
  <h2>How it works</h2>
  <ol class="steps">${steps.map((s) => html`<li>${s}</li>`)}</ol>
</div></section>

${bookable.length ? html`<section class="band alt"><div class="wrap">
  <h2>Services${site.show_prices ? ' and prices' : ''}</h2>
  <ul class="services">${bookable.map((s) => html`<li>
    <div><h3>${s.name}</h3>${s.description ? html`<p>${s.description}</p>` : ''}</div>
    <div class="svc-side">${site.show_prices ? html`<span class="price">${priceLabel(s.price_rule)}</span>` : ''}
      <a class="btn btn-sm btn-ghost" href="${ctx.base}/book?service=${encodeURIComponent(s.key)}">${s.price_rule.type === 'quote' ? 'Ask' : cap(v.booking_verb)}</a></div>
  </li>`)}</ul>
</div></section>` : ''}

${ctx.reviews.length ? html`<section class="band"><div class="wrap">
  <h2>What ${v.customer.many} say</h2>
  <ul class="reviews">${ctx.reviews.map((r) => html`<li><blockquote>${stars(r.rating)}<p>${r.body}</p><footer>${r.first_name ?? 'A ' + v.customer.one}</footer></blockquote></li>`)}</ul>
</div></section>` : ''}

${site.guarantee || site.about ? html`<section class="band alt"><div class="wrap two-col">
  ${site.about ? html`<div><h2>About us</h2><p>${site.about}</p></div>` : ''}
  ${site.guarantee ? html`<div class="guarantee"><h2>Our promise</h2><p>${site.guarantee}</p></div>` : ''}
</div></section>` : ''}

${site.faq.length || site.service_area ? html`<section class="band"><div class="wrap">
  ${site.service_area ? html`<h2>Where we work</h2><p>${site.service_area}</p>` : ''}
  ${site.areas.length ? html`<ul class="areas">${site.areas.map((a) => html`<li><a href="${ctx.base}/areas/${slug(a)}">${a}</a></li>`)}</ul>` : ''}
  ${site.faq.length ? html`<h2>Questions</h2><div class="faq">${site.faq.map((f) => html`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}</div>` : ''}
</div></section>` : ''}

<section class="band final" id="contact"><div class="wrap two-col">
  <div><h2>Ready when you are</h2><p>${cap(v.booking_verb)} online now, or send a message and we’ll get back to you quickly.</p>
    <a class="btn btn-accent btn-lg" href="${ctx.base}/book">${b.pack.website.primary_cta}</a></div>
  ${contactForm(ctx)}
</div></section>
</main>
${footer(ctx)}
<div class="sticky-bar">
  <a class="btn btn-accent" href="${ctx.base}/book">${b.pack.website.primary_cta}</a>
  ${b.phone_number ? html`<a class="btn btn-ghost" href="${telHref(b.phone_number)}">Call</a>` : ''}
</div>`;
  return page({ title: `${b.name}${site.service_area ? ' · ' + site.service_area : ''}`, description: subline, body, themeHref: themeHref(ctx), canonical: ctx.canonicalOrigin + (ctx.base || '/'), jsonLd: ld });
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function contactForm(ctx: SiteContext, preset?: { message?: string; service?: string }): Raw {
  return html`<form class="card form" method="post" action="${ctx.base}/contact">
  <h3>Send a message</h3>
  ${preset?.service ? html`<input type="hidden" name="service" value="${preset.service}">` : ''}
  <div class="row2"><label>First name<input name="first_name" autocomplete="given-name" required></label>
  <label>Last name<input name="last_name" autocomplete="family-name"></label></div>
  <label>Mobile<input name="phone" type="tel" autocomplete="tel" required></label>
  <label><span>Email <span class="opt">optional</span></span><input name="email" type="email" autocomplete="email"></label>
  <label>What do you need?<textarea name="message" rows="3">${preset?.message ?? ''}</textarea></label>
  <label class="check"><input type="checkbox" name="sms_consent" value="on"> <span>Text me about my request and occasional offers. Msg &amp; data rates may apply. Reply STOP to opt out.</span></label>
  <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
  <button class="btn btn-accent" type="submit">Send</button>
</form>`;
}

// ---------------- booking flow ----------------

export interface BookingState { service?: string; repeat?: string; inputs: Record<string, string>; at?: string; week?: number; ref?: string }

export function stateQuery(s: BookingState, extra: Record<string, string | number | undefined> = {}) {
  const q = new URLSearchParams();
  if (s.service) q.set('service', s.service);
  if (s.repeat) q.set('repeat', s.repeat);
  if (s.ref) q.set('ref', s.ref);
  for (const [k, v] of Object.entries(s.inputs)) q.set(`in_${k}`, v);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
}

function hiddenState(s: BookingState): Raw {
  return html`${s.service ? html`<input type="hidden" name="service" value="${s.service}">` : ''}
${s.repeat ? html`<input type="hidden" name="repeat" value="${s.repeat}">` : ''}
${s.ref ? html`<input type="hidden" name="ref" value="${s.ref}">` : ''}
${Object.entries(s.inputs).map(([k, v]) => html`<input type="hidden" name="in_${k}" value="${v}">`)}`;
}

function progress(step: number) {
  const names = ['Service', 'Time', 'Details'];
  return html`<ol class="progress" aria-label="Booking steps">${names.map((n, i) => html`<li class="${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}" ${i + 1 === step ? raw('aria-current="step"') : ''}>${n}</li>`)}</ol>`;
}

function shellPage(ctx: SiteContext, title: string, inner: Raw, opts: { script?: boolean } = {}) {
  const body = html`${header(ctx, { cta: false })}<main class="wrap narrow flow">${inner}</main>${footer(ctx)}`;
  return page({ title: `${title} · ${ctx.business.name}`, body, themeHref: themeHref(ctx), noindex: true, script: opts.script });
}

export function bookServicePage(ctx: SiteContext, s: BookingState, error?: string): string {
  const b = ctx.business;
  const rec = b.pack.recurrence;
  const chosen = ctx.services.find((x) => x.key === s.service) ?? ctx.services.find((x) => x.price_rule.type !== 'quote') ?? ctx.services[0];
  const inner = html`${progress(1)}
<h1>What do you need?</h1>
${s.ref && b.pack.referrals.enabled && b.pack.referrals.friend_credit_cents ? html`<p class="flash">A friend sent you: ${money(b.pack.referrals.friend_credit_cents)} off your first visit, applied automatically.</p>` : ''}
${error ? html`<p class="flash error">${error}</p>` : ''}
<form class="card form" method="get" action="${ctx.base}/book/time" data-quote="${ctx.base}/quote">
  ${s.ref ? html`<input type="hidden" name="ref" value="${s.ref}">` : ''}
  <fieldset class="choices"><legend class="sr">Service</legend>
  ${ctx.services.map((x) => html`<label class="choice"><input type="radio" name="service" value="${x.key}" ${x.key === chosen?.key ? raw('checked') : ''} required>
    <span><strong>${x.name}</strong>${x.description ? html`<small>${x.description}</small>` : ''}</span>
    ${ctx.site.show_prices ? html`<em>${priceLabel(x.price_rule)}</em>` : ''}</label>`)}
  </fieldset>
  ${ctx.services.map((x) => inputsFor(x, s, x.key === chosen?.key))}
  ${rec.enabled && rec.options.length ? html`<label>How often?<select name="repeat">
    <option value="">Just once</option>
    ${rec.options.map((o) => html`<option value="${o.key}" ${s.repeat === o.key ? raw('selected') : ''}>${o.label}${o.discount_pct ? ` (save ${o.discount_pct}%)` : ''}</option>`)}
  </select></label>` : ''}
  <div class="quote-box" aria-live="polite"><span>Your price</span><strong data-price>—</strong><small data-lines></small></div>
  <button class="btn btn-accent btn-lg" type="submit">See open times</button>
</form>`;
  return shellPage(ctx, 'Book', inner, { script: true });
}

function inputsFor(svc: SiteService, s: BookingState, visible: boolean): Raw {
  const rule = svc.price_rule;
  const hiddenAttr = visible ? '' : raw('hidden');
  if (rule.type === 'hourly') {
    return html`<div class="svc-inputs" data-for="${svc.key}" ${hiddenAttr}><label>How long? (minutes)
      <input type="number" name="in_minutes" min="${rule.min_minutes}" step="${rule.increment_minutes}" value="${s.inputs.minutes ?? svc.duration_min}" ${visible ? '' : raw('disabled')}></label></div>`;
  }
  if (rule.type === 'formula') {
    return html`<div class="svc-inputs" data-for="${svc.key}" ${hiddenAttr}>${rule.inputs.map((inp) => inp.kind === 'number'
      ? html`<label>${inp.label}<input type="number" name="in_${inp.key}" min="${inp.min}" ${inp.max != null ? raw(`max="${inp.max}"`) : ''} value="${s.inputs[inp.key] ?? inp.default}" ${visible ? '' : raw('disabled')}></label>`
      : html`<label>${inp.label}<select name="in_${inp.key}" ${visible ? '' : raw('disabled')}>${inp.options.map((o) => html`<option value="${o.key}" ${s.inputs[inp.key] === o.key ? raw('selected') : ''}>${o.label}</option>`)}</select></label>`)}</div>`;
  }
  return html``;
}

export function bookTimePage(ctx: SiteContext, s: BookingState, quote: { amount_cents: number | null; lines: { label: string; cents: number }[] }, service: SiteService, days: { date: string; slots: string[] }[], error?: string): string {
  const tz = ctx.business.timezone;
  const week = s.week ?? 0;
  const label = (date: string) => new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
  const t = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const any = days.some((d) => d.slots.length);
  const inner = html`${progress(2)}
<h1>Pick a time</h1>
<p class="summary"><strong>${service.name}</strong> · ${money(quote.amount_cents)} ${s.repeat ? html`· ${ctx.business.pack.recurrence.options.find((o) => o.key === s.repeat)?.label ?? ''}` : ''}
  <a href="${ctx.base}/book?${stateQuery(s)}">Change</a></p>
${error ? html`<p class="flash error">${error}</p>` : ''}
${any ? html`<div class="days">${days.filter((d) => d.slots.length).map((d) => html`<section class="day"><h2>${label(d.date)}</h2>
  <ul class="slots">${d.slots.map((iso) => html`<li><a class="slot" href="${ctx.base}/book/details?${stateQuery(s, { at: iso })}">${t(iso)}</a></li>`)}</ul></section>`)}</div>`
    : html`<p class="card">No open times this week.</p>`}
<p class="pager">${week > 0 ? html`<a class="btn btn-ghost" href="${ctx.base}/book/time?${stateQuery(s, { week: week - 1 })}">Earlier</a>` : ''}
  <a class="btn btn-ghost" href="${ctx.base}/book/time?${stateQuery(s, { week: week + 1 })}">Later times</a></p>
<p class="muted">Times are in ${tz.replace('_', ' ')} time. Need something else? <a href="${ctx.base}/#contact">Send us a message</a>.</p>`;
  return shellPage(ctx, 'Pick a time', inner);
}

export function bookDetailsPage(ctx: SiteContext, s: BookingState, service: SiteService, quote: { amount_cents: number | null }, error?: string, values: Record<string, string> = {}): string {
  const at = new Date(s.at!);
  const place = ctx.business.pack.place_fields;
  const inner = html`${progress(3)}
<h1>Almost done</h1>
<p class="summary"><strong>${service.name}</strong> · ${friendlyWhen(at, ctx.business.timezone)} · ${money(quote.amount_cents)}
  <a href="${ctx.base}/book/time?${stateQuery(s)}">Change</a></p>
${error ? html`<p class="flash error">${error}</p>` : ''}
<form class="card form" method="post" action="${ctx.base}/book">
  ${hiddenState(s)}<input type="hidden" name="at" value="${s.at}">
  <div class="row2"><label>First name<input name="first_name" autocomplete="given-name" required value="${values.first_name ?? ''}"></label>
  <label>Last name<input name="last_name" autocomplete="family-name" value="${values.last_name ?? ''}"></label></div>
  <label><span>Mobile <span class="opt">for your confirmation and reminder</span></span><input name="phone" type="tel" autocomplete="tel" required value="${values.phone ?? ''}"></label>
  <label><span>Email <span class="opt">optional</span></span><input name="email" type="email" autocomplete="email" value="${values.email ?? ''}"></label>
  <label>Address<input name="address" autocomplete="street-address" value="${values.address ?? ''}"></label>
  ${place.map((f) => f.kind === 'select'
    ? html`<label>${f.label}<select name="pf_${f.key}">${(f.options ?? []).map((o) => html`<option>${o}</option>`)}</select></label>`
    : html`<label>${f.label}<input name="pf_${f.key}" ${f.kind === 'number' ? raw('type="number"') : ''} value="${values['pf_' + f.key] ?? ''}"></label>`)}
  <label><span>Anything we should know? <span class="opt">optional</span></span><textarea name="notes" rows="3">${values.notes ?? ''}</textarea></label>
  <label class="check"><input type="checkbox" name="sms_consent" value="on" ${values.sms_consent ? raw('checked') : ''}> <span>Also text me occasional offers. Msg &amp; data rates may apply. Reply STOP to opt out.</span></label>
  <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
  <p class="muted small">We’ll text your confirmation and a reminder before your visit.</p>
  <button class="btn btn-accent btn-lg" type="submit">Confirm booking</button>
</form>`;
  return shellPage(ctx, 'Your details', inner);
}

export function bookDonePage(ctx: SiteContext, when: Date, serviceName: string, firstName: string): string {
  const inner = html`<div class="done card">
  <p class="done-mark" aria-hidden="true">✓</p>
  <h1>You’re booked, ${firstName}</h1>
  <p><strong>${serviceName}</strong><br>${friendlyWhen(when, ctx.business.timezone)}</p>
  <p class="muted">We just texted you a confirmation with a link to reschedule or cancel if plans change.</p>
  <a class="btn btn-ghost" href="${ctx.base || '/'}">Back to ${ctx.business.name}</a>
</div>`;
  return shellPage(ctx, 'Booked', inner);
}

export function requestQuotePage(ctx: SiteContext, service: SiteService): string {
  const inner = html`<h1>Get a quote</h1>
<p class="lede">Tell us about the ${service.name.toLowerCase()} and we’ll reply with a price, usually the same day.</p>
${contactForm(ctx, { service: service.key, message: `${service.name}: ` })}`;
  return shellPage(ctx, 'Get a quote', inner);
}

export function thanksPage(ctx: SiteContext): string {
  return shellPage(ctx, 'Thanks', html`<div class="done card"><p class="done-mark" aria-hidden="true">✓</p><h1>Thanks, we got it</h1>
<p>We’ll get back to you shortly${ctx.business.phone_number ? ' by text' : ''}.</p><a class="btn btn-ghost" href="${ctx.base || '/'}">Back to ${ctx.business.name}</a></div>`);
}

export function areaPage(ctx: SiteContext, area: string): string {
  const b = ctx.business;
  const v = b.pack.vocabulary;
  const inner = html`<h1>${b.name} in ${area}</h1>
<p class="lede">${ctx.site.subline ?? `Reliable ${v.job.many} for ${v.customer.many} in ${area}. See your price and book online in a minute.`}</p>
<ul class="services">${ctx.services.map((s) => html`<li><div><h3>${s.name}</h3></div><div class="svc-side">${ctx.site.show_prices ? html`<span class="price">${priceLabel(s.price_rule)}</span>` : ''}</div></li>`)}</ul>
<p><a class="btn btn-accent btn-lg" href="${ctx.base}/book">${b.pack.website.primary_cta}</a></p>
${ctx.site.faq.length ? html`<h2>Questions</h2><div class="faq">${ctx.site.faq.map((f) => html`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}</div>` : ''}`;
  const body = html`${header(ctx)}<main class="wrap narrow flow">${inner}</main>${footer(ctx)}`;
  return page({
    title: `${cap(v.job.many)} in ${area} · ${b.name}`, description: `${b.name} serves ${area}. Book online with clear prices.`, body, themeHref: themeHref(ctx),
    canonical: `${ctx.canonicalOrigin}${ctx.base}/areas/${slug(area)}`,
    jsonLd: [{ '@context': 'https://schema.org', '@type': 'LocalBusiness', name: b.name, areaServed: area, telephone: b.phone_number ?? undefined }],
  });
}

export function legalPage(ctx: SiteContext, kind: 'privacy' | 'terms', text: string): string {
  return shellPage(ctx, kind === 'privacy' ? 'Privacy' : 'Terms', html`<article class="legal">${raw(text)}</article>`);
}

export function notFoundPage(ctx: SiteContext): string {
  return shellPage(ctx, 'Not found', html`<h1>That page isn’t here</h1><p><a class="btn btn-accent" href="${ctx.base || '/'}">Go to the home page</a></p>`);
}

export function upcomingLine(at: Date, tz: string) {
  const l = localParts(at, tz);
  return `${l.date} ${l.time}`;
}
