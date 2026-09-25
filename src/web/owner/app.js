// Flywheel owner app: a small, dependency-free single-page app.
// All user data is inserted as text nodes (never innerHTML), so it can't inject markup.

const root = document.getElementById('app');
const state = { user: null, business: null, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, badges: { inbox: 0 }, route: null };

/* ---------- tiny DOM helper ---------- */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

/** append() that skips null/false children (DOM append would print "null"). */
const put = (el, ...kids) => { el.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false)); return el; };

const ICONS = {
  today: '<path d="M4 7h16M8 3v4m8-4v4M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  inbox: '<path d="M4 5h16v11H9l-5 4z"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.8.8 3 2.6 3.5 5.2"/>',
  chart: '<path d="M4 20V10m6 10V4m6 16v-7m4 7H3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M2 12h3m14 0h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name]; // constant markup only
  return s;
}

/* ---------- API ---------- */
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-fw-csrf': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && !path.startsWith('/auth/')) { state.user = null; render(); throw new ApiError(401, 'Please sign in.'); }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data;
}

/* ---------- formatting ---------- */
const money = (c) => c == null ? '—' : (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: c % 100 ? 2 : 0 });
const pct = (r) => r == null ? '—' : `${Math.round(r * 100)}%`;
const fmt = (d, opts) => new Intl.DateTimeFormat('en-US', { timeZone: state.tz, ...opts }).format(new Date(d));
const timeOf = (d) => fmt(d, { hour: 'numeric', minute: '2-digit' });
const dayOf = (d) => fmt(d, { weekday: 'short', month: 'short', day: 'numeric' });
function ago(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return fmt(d, { weekday: 'short' });
  return fmt(d, { month: 'short', day: 'numeric' });
}
const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.phone || c.email || 'Unknown';
const initials = (c) => ([c.first_name?.[0], c.last_name?.[0]].filter(Boolean).join('') || '#').toUpperCase();
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const vocab = () => state.business?.pack?.vocabulary ?? { customer: { one: 'customer', many: 'customers' }, job: { one: 'job', many: 'jobs' } };

/** "2026-09-25T09:30" typed in the business's timezone → a real instant. */
function zonedToUtc(local, tz) {
  const [d, t] = local.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [hh, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, hh, mi);
  const offset = (ms) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
    const g = (k) => Number(p.find((x) => x.type === k).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - ms;
  };
  let ms = guess - offset(guess);
  ms = guess - offset(ms);
  return new Date(ms);
}

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

/** Replace an error line with a question and a Yes button (the page can't use confirm()). */
function confirmInline(el, question, onYes) {
  const yes = h('button', { class: 'btn small primary', type: 'button' }, 'Yes');
  yes.addEventListener('click', action(yes, el, onYes));
  el.replaceChildren(question + ' ', yes);
  return true;
}

/** Wrap an async button action: disables it while running, shows errors inline. */
function action(btn, errorEl, fn) {
  return async (e) => {
    e?.preventDefault();
    btn.disabled = true;
    if (errorEl) errorEl.textContent = '';
    try { await fn(); } catch (err) {
      if (errorEl) errorEl.textContent = err.message; else toast(err.message);
    } finally { btn.disabled = false; }
  };
}

/* ---------- routing ---------- */
const routes = [
  [/^\/app\/?$/, viewToday, 'today'],
  [/^\/app\/inbox\/?$/, viewInbox, 'inbox'],
  [/^\/app\/inbox\/([\w-]+)$/, viewThread, 'inbox'],
  [/^\/app\/customers\/?$/, viewCustomers, 'customers'],
  [/^\/app\/customers\/new$/, viewNewCustomer, 'customers'],
  [/^\/app\/customers\/([\w-]+)\/book$/, viewBook, 'customers'],
  [/^\/app\/customers\/([\w-]+)$/, viewCustomer, 'customers'],
  [/^\/app\/scorecard\/?$/, viewScorecard, 'scorecard'],
  [/^\/app\/money\/?$/, viewMoney, 'today'],
  [/^\/app\/grow\/?$/, viewGrow, 'scorecard'],
  [/^\/app\/setup\/?$/, viewSetup, 'today'],
  [/^\/app\/settings\/services$/, viewServices, null],
  [/^\/app\/settings\/?$/, viewSettings, null],
  [/^\/app\/settings\/website$/, viewWebsite, null],
  [/^\/app\/settings\/hours$/, viewHours, null],
];

function go(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  render();
}
window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/app"]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  if (!state.user) {
    try {
      const me = await api('/auth/me');
      state.user = me.user;
    } catch { return viewLogin(); }
  }
  if (!state.business) {
    try {
      state.business = await api('/v1/business');
      state.tz = state.business.timezone;
    } catch (e) { return root.replaceChildren(h('p', { class: 'boot' }, e.message)); }
  }
  const path = location.pathname;
  const match = routes.find(([re]) => re.test(path));
  if (!match) return go('/app', { replace: true });
  const [re, view, tab] = match;
  state.route = { path, tab };
  try {
    const content = await view(...(path.match(re).slice(1)));
    if (seq !== renderSeq) return;
    root.replaceChildren(content);
    refreshBadges();
  } catch (e) {
    if (seq !== renderSeq || e.status === 401) return;
    root.replaceChildren(shell('Something went wrong', [h('div', { class: 'card' }, h('p', { class: 'error' }, e.message), h('a', { href: '/app', class: 'btn' }, 'Back to Today'))]));
  }
}

/* ---------- layout ---------- */
function shell(title, content, { back, actions } = {}) {
  const tab = state.route?.tab;
  const tabLink = (href, name, label, key) => h('a', { href, 'aria-current': tab === key ? 'page' : null },
    icon(name), label, key === 'inbox' && state.badges.inbox ? h('span', { class: 'badge', 'aria-label': `${state.badges.inbox} need you` }, state.badges.inbox) : null);
  return h('div', { class: 'shell' },
    h('header', { class: 'top' },
      back ? h('a', { class: 'back', href: back }, '‹ Back') : null,
      h('h1', {}, title),
      actions ?? h('a', { class: 'iconbtn', href: '/app/settings', 'aria-label': 'Settings' }, icon('gear'))),
    h('main', {}, content),
    h('div', { class: 'tabs' }, h('nav', { 'aria-label': 'Main' },
      tabLink('/app', 'today', 'Today', 'today'),
      tabLink('/app/inbox', 'inbox', 'Inbox', 'inbox'),
      tabLink('/app/customers', 'people', cap(vocab().customer.many), 'customers'),
      tabLink('/app/scorecard', 'chart', 'Scorecard', 'scorecard'))));
}

async function refreshBadges() {
  try {
    const [drafts, t] = await Promise.all([api('/v1/drafts'), api('/v1/today')]);
    const n = new Set([...drafts.map((d) => d.customer_id), ...t.waiting_for_reply.map((w) => w.customer_id)]).size;
    if (n !== state.badges.inbox) {
      state.badges.inbox = n;
      const link = document.querySelector('.tabs a[href="/app/inbox"]');
      if (link) {
        link.querySelector('.badge')?.remove();
        if (n) link.append(h('span', { class: 'badge', 'aria-label': `${n} need you` }, n));
      }
    }
  } catch { /* badges are best-effort */ }
}
setInterval(() => { if (state.user && document.visibilityState === 'visible') refreshBadges(); }, 30000);

/* ---------- auth ---------- */
function viewLogin(mode = 'login', email = '') {
  const err = h('p', { class: 'error', role: 'alert' });
  const mark = h('img', { class: 'mark', src: '/assets/owner/icon.svg', alt: '' });
  if (mode === 'login') {
    const emailIn = h('input', { type: 'email', id: 'login-email', autocomplete: 'username', required: true, value: email });
    const pwIn = h('input', { type: 'password', id: 'login-password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
    const form = h('form', { class: 'stack' },
      h('label', { class: 'field', for: 'login-email' }, 'Email', emailIn),
      h('label', { class: 'field', for: 'login-password' }, 'Password', pwIn),
      err, btn,
      h('button', { class: 'btn', type: 'button', onclick: () => root.replaceChildren(viewLogin('reset', emailIn.value)) }, 'Forgot password?'));
    form.addEventListener('submit', action(btn, err, async () => {
      const r = await api('/auth/login', { method: 'POST', body: { email: emailIn.value, password: pwIn.value } });
      state.user = r.user; state.business = null;
      go(location.pathname.startsWith('/app') ? location.pathname : '/app', { replace: true });
    }));
    return root.replaceChildren(h('div', { class: 'auth' }, mark, h('h1', {}, 'Sign in'), form));
  }
  // reset: request a code, then set a new password
  const emailIn = h('input', { type: 'email', id: 'reset-email', autocomplete: 'username', required: true, value: email });
  const codeIn = h('input', { type: 'text', id: 'reset-code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '\\d{6}', maxlength: '6' });
  const pwIn = h('input', { type: 'password', id: 'reset-password', autocomplete: 'new-password', minlength: '10' });
  const step2 = h('div', { class: 'stack', hidden: true },
    h('label', { class: 'field', for: 'reset-code' }, 'Code from the text', codeIn),
    h('label', { class: 'field', for: 'reset-password' }, h('span', {}, 'New password ', h('span', { class: 'hint' }, 'at least 10 characters')), pwIn));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Text me a code');
  const info = h('p', { class: 'muted small' }, 'We’ll text a 6-digit code to the phone number on your account.');
  const form = h('form', { class: 'stack' }, h('label', { class: 'field', for: 'reset-email' }, 'Email', emailIn), step2, info, err, btn,
    h('button', { class: 'btn', type: 'button', onclick: () => viewLogin('login', emailIn.value) }, 'Back to sign in'));
  let sent = false;
  form.addEventListener('submit', action(btn, err, async () => {
    if (!sent) {
      const r = await api('/auth/reset/request', { method: 'POST', body: { email: emailIn.value } });
      sent = true; step2.hidden = false; info.textContent = r.message; btn.textContent = 'Set new password'; codeIn.focus();
    } else {
      await api('/auth/reset/confirm', { method: 'POST', body: { email: emailIn.value, code: codeIn.value, password: pwIn.value } });
      toast('Password changed. Sign in with the new one.');
      viewLogin('login', emailIn.value);
    }
  }));
  root.replaceChildren(h('div', { class: 'auth' }, mark, h('h1', {}, 'Reset password'), form));
}

/* ---------- Today ---------- */
async function viewToday() {
  const [t, insights, setup] = await Promise.all([api('/v1/today'), api('/v1/insights').catch(() => null), api('/v1/setup').catch(() => null)]);
  const v = vocab();
  const blocks = [];
  if (setup && !setup.done && !setup.dismissed) {
    const done = Object.values(setup.steps).filter(Boolean).length, total = Object.keys(setup.steps).length;
    blocks.push(h('a', { class: 'card focus', href: '/app/setup' }, h('span', { class: 'label' }, 'Finish setting up'), h('p', {}, `${done} of ${total} done. Each step takes a minute or two.`)));
  }
  const needs = t.pending_drafts + t.waiting_for_reply.length;
  if (needs) {
    blocks.push(h('a', { class: 'card focus', href: '/app/inbox' },
      h('span', { class: 'label' }, 'Needs you'),
      h('p', {}, [t.pending_drafts ? `${t.pending_drafts} message${t.pending_drafts > 1 ? 's' : ''} waiting for your OK` : null,
        t.waiting_for_reply.length ? `${t.waiting_for_reply.length} ${t.waiting_for_reply.length > 1 ? v.customer.many : v.customer.one} waiting for a reply` : null].filter(Boolean).join(' · '))));
  }
  if (t.bottleneck) {
    blocks.push(h('a', { class: 'card', href: '/app/scorecard' },
      h('h2', {}, 'This week’s focus'),
      h('p', {}, `${t.bottleneck.label} fell from ${pct(t.bottleneck.previous)} to ${pct(t.bottleneck.current)}.`)));
  }
  for (const a of insights?.autonomy ?? []) {
    const name = (PLAYBOOK_LABELS[a.playbook] ?? [a.playbook])[0];
    const err = h('p', { class: 'error' });
    const yes = h('button', { class: 'btn primary small', type: 'button' }, 'Yes, send on its own');
    yes.addEventListener('click', action(yes, err, async () => { await api('/v1/autonomy/accept', { method: 'POST', body: { playbook: a.playbook } }); state.business = null; toast('Done. You can change this in Settings.'); render(); }));
    blocks.push(h('div', { class: 'card' }, h('h2', {}, 'You can hand this off'),
      h('p', {}, `You approved the last ${a.approved_unchanged} "${name}" messages without changing a word. Let it send on its own?`), h('div', { class: 'split' }, yes), err));
  }
  if (t.review_replies) {
    blocks.push(h('a', { class: 'card', href: '/app/grow' }, h('h2', {}, 'Reviews and posts'),
      h('p', {}, `${t.review_replies} ready for your OK. Replying to reviews helps you show up on Google.`)));
  }
  if (t.at_risk) {
    blocks.push(h('a', { class: 'card', href: '/app/customers?risk=1' }, h('h2', {}, 'Might be slipping away'),
      h('p', {}, `${t.at_risk} ${t.at_risk > 1 ? vocab().customer.many : vocab().customer.one} with a falling health score. A personal message now works better than a discount later.`)));
  }
  if (t.unpaid?.n) {
    blocks.push(h('a', { class: 'card', href: '/app/money' }, h('h2', {}, 'Waiting to be paid'),
      h('div', { class: 'split' }, h('div', { class: 'big' }, money(t.unpaid.cents)),
        h('span', { class: `pill ${t.unpaid.failed ? 'bad' : 'warn'}` }, t.unpaid.failed ? `${t.unpaid.failed} declined` : `${t.unpaid.n} unpaid`))));
  }
  const schedule = h('div', { class: 'card flush' });
  if (!t.bookings.length) schedule.append(h('p', { class: 'empty' }, `No ${v.job.many} today.`));
  for (const b of t.bookings) schedule.append(bookingRow(b));
  blocks.push(h('div', { class: 'stack' },
    h('div', { class: 'dayhead' }, h('span', { class: 'section-title' }, fmt(t.date + 'T12:00:00Z', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })),
      h('span', { class: 'section-title' }, t.bookings.length ? `${money(t.booked_cents)} booked` : '')),
    schedule));
  if (t.waiting_for_reply.length) {
    const list = h('div', { class: 'card flush' });
    for (const w of t.waiting_for_reply.slice(0, 5)) {
      list.append(h('a', { class: 'row', href: `/app/inbox/${w.customer_id}` }, h('span', { class: 'avatar' }, initials(w)),
        h('span', { class: 'grow' }, h('div', { class: 'title' }, fullName(w)), h('div', { class: 'sub' }, w.body)),
        h('span', { class: 'meta' }, ago(w.created_at))));
    }
    blocks.push(h('div', { class: 'stack' }, h('span', { class: 'section-title' }, 'Waiting for a reply'), list));
  }
  return shell(state.business.name, blocks);
}

function bookingRow(b) {
  const panel = h('div', { class: 'stack', hidden: true });
  const err = h('p', { class: 'error' });
  const row = h('button', { class: 'row', type: 'button', 'aria-expanded': 'false' },
    h('span', { class: 'time' }, timeOf(b.starts_at)),
    h('span', { class: 'grow' }, h('div', { class: 'title' }, fullName(b)), h('div', { class: 'sub' }, [b.service, b.address].filter(Boolean).join(' · '))),
    b.status === 'completed' ? h('span', { class: 'pill good' }, 'Done') : h('span', { class: 'meta' }, money(b.price_cents)));
  row.addEventListener('click', () => { panel.hidden = !panel.hidden; row.setAttribute('aria-expanded', String(!panel.hidden)); });
  if (b.status !== 'completed') {
    const done = h('button', { class: 'btn primary small', type: 'button' }, 'Mark done');
    done.addEventListener('click', action(done, err, async () => {
      await api(`/v1/bookings/${b.id}/complete`, { method: 'POST', body: {} });
      toast('Marked done'); render();
    }));
    const reasons = state.business.pack.reasons.cancel;
    const sel = h('select', { 'aria-label': 'Reason for cancelling' }, h('option', { value: '' }, 'Why cancel?'), reasons.map((r) => h('option', { value: r.code }, r.label)));
    const cancel = h('button', { class: 'btn danger small', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', action(cancel, err, async () => {
      if (!sel.value) throw new Error('Pick a reason first. It helps the scorecard learn why people cancel.');
      await api(`/v1/bookings/${b.id}/cancel`, { method: 'POST', body: { reason_code: sel.value } });
      toast('Cancelled'); render();
    }));
    const moveIn = h('input', { type: 'datetime-local', 'aria-label': 'New time' });
    const move = h('button', { class: 'btn small', type: 'button' }, 'Move');
    move.addEventListener('click', action(move, err, async () => {
      if (!moveIn.value) throw new Error('Pick the new date and time first.');
      const starts_at = zonedToUtc(moveIn.value, state.tz).toISOString();
      try { await api(`/v1/bookings/${b.id}/reschedule`, { method: 'POST', body: { starts_at } }); }
      catch (e) {
        if (e.status !== 409) throw e;
        if (!confirmInline(err, `${e.message} Book it anyway?`, async () => { await api(`/v1/bookings/${b.id}/reschedule`, { method: 'POST', body: { starts_at, force: true } }); toast('Moved'); render(); })) return;
        return;
      }
      toast('Moved. The customer gets a text with the new time.'); render();
    }));
    panel.append(h('div', { class: 'split' }, done, h('a', { class: 'btn small', href: `/app/inbox/${b.customer_id}` }, 'Message')), photoPicker(b.id),
      h('div', { class: 'split' }, moveIn, move), h('div', { class: 'split' }, sel, cancel), err);
  } else {
    panel.append(h('a', { class: 'btn small', href: `/app/customers/${b.customer_id}` }, 'Open'), photoPicker(b.id));
  }
  const wrap = h('div', {}, row, panel);
  panel.style.padding = '0 16px 14px';
  return wrap;
}

/* ---------- Inbox ---------- */
async function viewInbox() {
  const [threads, drafts] = await Promise.all([api('/v1/inbox'), api('/v1/drafts')]);
  const byCustomer = new Map(threads.map((t) => [t.customer_id, t]));
  for (const d of drafts) if (!byCustomer.has(d.customer_id)) byCustomer.set(d.customer_id, { customer_id: d.customer_id, first_name: d.first_name, last_name: d.last_name, phone: d.phone, body: d.body, direction: 'draft', created_at: d.created_at, pending_drafts: 1 });
  const items = [...byCustomer.values()].sort((a, b) => (b.pending_drafts > 0) - (a.pending_drafts > 0) || new Date(b.created_at) - new Date(a.created_at));
  const list = h('div', { class: 'card flush' });
  if (!items.length) list.append(h('p', { class: 'empty' }, 'No conversations yet. Texts, missed calls and website leads show up here.'));
  for (const t of items) {
    const status = t.pending_drafts ? h('span', { class: 'pill good' }, 'Draft ready')
      : t.direction === 'in' ? h('span', { class: 'pill warn' }, 'Reply') : null;
    list.append(h('a', { class: 'row', href: `/app/inbox/${t.customer_id}` },
      h('span', { class: 'avatar' }, initials(t)),
      h('span', { class: 'grow' }, h('div', { class: 'title' }, fullName(t)),
        h('div', { class: 'sub' }, t.channel === 'voice' ? 'Missed call' : t.direction === 'out' ? `You: ${t.body}` : t.body)),
      h('span', { class: 'stack' }, h('span', { class: 'meta' }, ago(t.created_at)), status)));
  }
  return shell('Inbox', [list]);
}

async function viewThread(customerId) {
  const [detail, messages, drafts] = await Promise.all([
    api(`/v1/customers/${customerId}`), api(`/v1/customers/${customerId}/messages`), api(`/v1/drafts?customer_id=${customerId}`)]);
  const c = detail.customer;
  const thread = h('div', { class: 'thread' });
  const BLOCK = { no_consent: 'Not sent: they haven’t agreed to texts', no_marketing_consent: 'Not sent: no consent for marketing texts', opted_out: 'Not sent: they replied STOP', weekly_cap: 'Not sent: weekly limit reached', no_phone: 'Not sent: no phone number' };
  for (const m of messages) {
    if (m.channel === 'voice') { thread.append(h('div', { class: 'bubble note' }, `Missed call · ${dayOf(m.created_at)} ${timeOf(m.created_at)}`)); continue; }
    if (m.channel === 'web') { thread.append(h('div', { class: 'bubble in' }, h('strong', {}, 'Website form: '), m.body, h('span', { class: 'stamp' }, `${dayOf(m.created_at)} ${timeOf(m.created_at)}`))); continue; }
    const cls = m.direction === 'in' ? 'in' : m.status === 'blocked' || m.status === 'failed' ? 'out blocked' : 'out';
    const stamp = m.status === 'blocked' ? (BLOCK[m.block_reason] ?? `Not sent: ${m.block_reason}`) : m.status === 'queued' ? 'Sending…'
      : m.status === 'failed' ? 'Not delivered. Their phone may be off or unable to get texts.'
      : `${dayOf(m.created_at)} ${timeOf(m.created_at)}${m.channel === 'email' ? ' · by email' : ''}${m.playbook ? ' · automatic' : ''}${m.status === 'delivered' ? ' · delivered' : ''}`;
    thread.append(h('div', { class: `bubble ${cls}` }, m.body, h('span', { class: 'stamp' }, stamp)));
  }
  if (!messages.length) thread.append(h('p', { class: 'empty' }, 'No messages yet.'));
  for (const d of drafts) thread.append(draftCard(d));

  const input = h('textarea', { rows: '1', placeholder: c.sms_opted_out ? 'They replied STOP' : 'Write a text…', 'aria-label': 'Message', disabled: c.sms_opted_out || !c.phone });
  const send = h('button', { class: 'btn primary', type: 'submit', disabled: c.sms_opted_out || !c.phone }, 'Send');
  const form = h('form', { class: 'compose' }, input, send);
  form.addEventListener('submit', action(send, null, async () => {
    if (!input.value.trim()) return;
    await api(`/v1/customers/${customerId}/messages`, { method: 'POST', body: { body: input.value } });
    input.value = ''; render();
  }));
  const named = c.first_name || c.last_name;
  const header = h('a', { class: 'card', href: `/app/customers/${customerId}` },
    h('div', { class: 'thread-head' }, h('span', {}, named ? fullName(c) : 'Unknown caller'),
      h('span', { class: 'muted' }, c.phone || 'No phone')),
    !c.sms_consent && !c.sms_opted_out ? h('span', { class: 'small muted' }, 'Hasn’t agreed to marketing texts. Replies to their messages are fine.') : null);
  setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 0);
  return shell(fullName(c), [header, thread, form], { back: '/app/inbox' });
}

function draftCard(d) {
  const body = h('textarea', { 'aria-label': 'Draft message', value: d.body, rows: String(Math.min(8, Math.ceil(d.body.length / 34) + 1)) });
  const err = h('p', { class: 'error' });
  const ok = h('button', { class: 'btn primary small', type: 'button' }, 'Approve & send');
  const no = h('button', { class: 'btn small', type: 'button' }, 'Discard');
  ok.addEventListener('click', action(ok, err, async () => {
    await api(`/v1/drafts/${d.id}/approve`, { method: 'POST', body: body.value !== d.body ? { body: body.value } : {} });
    toast('Sent'); render();
  }));
  no.addEventListener('click', action(no, err, async () => { await api(`/v1/drafts/${d.id}/reject`, { method: 'POST', body: {} }); render(); }));
  const act = d.action ? h('div', { class: 'notice' }, `When you approve, this also happens: ${d.action.summary ?? d.action.type}`) : null;
  if (d.action) ok.textContent = 'Approve, do it & send';
  return h('div', { class: 'draft' }, h('span', { class: 'why' }, d.action ? 'Draft with an action' : `Draft · ${d.reason ?? 'Suggested reply'}`), act, body, h('div', { class: 'split' }, ok, no), err);
}

/* ---------- Customers ---------- */
async function viewCustomers() {
  const v = vocab();
  const params = new URLSearchParams(location.search);
  const q = params.get('q') ?? '';
  let risk = params.get('risk') === '1';
  const riskBtn = h('button', { class: `btn small${risk ? ' primary' : ''}`, type: 'button', 'aria-pressed': String(risk) }, 'At risk');
  riskBtn.addEventListener('click', () => { risk = !risk; riskBtn.className = `btn small${risk ? ' primary' : ''}`; riskBtn.setAttribute('aria-pressed', String(risk)); load().catch((e) => toast(e.message)); });
  const list = h('div', { class: 'card flush' });
  const search = h('input', { type: 'search', placeholder: `Search ${v.customer.many}`, 'aria-label': `Search ${v.customer.many}`, value: q });
  let timer;
  const load = async () => {
    const qs = new URLSearchParams();
    if (search.value) qs.set('q', search.value);
    if (risk) qs.set('risk', '1');
    const rows = await api(`/v1/customers${qs.size ? '?' + qs : ''}`);
    list.replaceChildren();
    if (!rows.length) list.append(h('p', { class: 'empty' }, search.value ? 'No matches.' : `No ${v.customer.many} yet.`));
    const STATUS = { lead: ['New lead', 'warn'], active: ['Active', 'good'], lapsed: ['Lapsed', 'bad'], lost: ['Lost', ''] };
    for (const c of rows) {
      let [label, tone] = STATUS[c.status] ?? [c.status, ''];
      if (c.status === 'active' && c.health_score != null && c.health_score < 50) { label = `At risk · ${c.health_score}`; tone = 'bad'; }
      list.append(h('a', { class: 'row', href: `/app/customers/${c.id}` }, h('span', { class: 'avatar' }, initials(c)),
        h('span', { class: 'grow' }, h('div', { class: 'title' }, fullName(c)), h('div', { class: 'sub' }, risk && c.health_reasons?.length ? c.health_reasons[0] : c.last_visit_at ? `Last ${v.job.one} ${dayOf(c.last_visit_at)}` : c.phone || c.email || '')),
        h('span', { class: `pill ${tone}` }, label)));
    }
  };
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch((e) => toast(e.message)), 250); });
  await load();
  const add = h('a', { class: 'iconbtn', href: '/app/customers/new', 'aria-label': `Add ${v.customer.one}` }, icon('plus'));
  return shell(cap(v.customer.many), [h('div', { class: 'split' }, search, h('div', { class: 'stack' }, riskBtn)), list], { actions: add });
}

async function viewNewCustomer() {
  const v = vocab();
  const f = {
    first: h('input', { type: 'text', id: 'c-first', autocomplete: 'off' }), last: h('input', { type: 'text', id: 'c-last', autocomplete: 'off' }),
    phone: h('input', { type: 'tel', id: 'c-phone', autocomplete: 'off' }), email: h('input', { type: 'email', id: 'c-email', autocomplete: 'off' }),
    consent: h('input', { type: 'checkbox', id: 'c-consent' }),
    how: h('select', { id: 'c-how', 'aria-label': 'How they agreed' }, h('option', { value: 'verbal' }, 'Told me in person or by phone'), h('option', { value: 'written' }, 'In writing'), h('option', { value: 'web_form' }, 'On a web form'), h('option', { value: 'import' }, 'Imported from my old system')),
    notes: h('textarea', { id: 'c-notes' }),
  };
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, `Add ${v.customer.one}`);
  const form = h('form', { class: 'card' },
    h('div', { class: 'split' }, h('label', { class: 'field', for: 'c-first' }, 'First name', f.first), h('label', { class: 'field', for: 'c-last' }, 'Last name', f.last)),
    h('label', { class: 'field', for: 'c-phone' }, 'Mobile', f.phone),
    h('label', { class: 'field', for: 'c-email' }, 'Email', f.email),
    h('label', { class: 'check', for: 'c-consent' }, f.consent, h('span', {}, 'They agreed to get texts from us (reminders, offers, review requests)')),
    h('label', { class: 'field', for: 'c-how' }, 'How they agreed', f.how),
    h('label', { class: 'field', for: 'c-notes' }, 'Notes', f.notes), err, btn);
  form.addEventListener('submit', action(btn, err, async () => {
    const body = { first_name: f.first.value || undefined, last_name: f.last.value || undefined, phone: f.phone.value || undefined, email: f.email.value || undefined, notes: f.notes.value || undefined };
    if (!body.phone && !body.email && !body.first_name) throw new Error('Add at least a name, phone or email.');
    if (f.consent.checked) Object.assign(body, { sms_consent: true, consent_source: f.how.value });
    const r = await api('/v1/customers', { method: 'POST', body });
    toast(r.created ? 'Added' : 'Already on file. Opened their record.');
    go(`/app/customers/${r.customer.id}`, { replace: true });
  }));
  return shell(`New ${v.customer.one}`, [form], { back: '/app/customers' });
}

async function viewCustomer(id) {
  const v = vocab();
  const d = await api(`/v1/customers/${id}`);
  const c = d.customer;
  const facts = h('div', { class: 'card' },
    h('div', { class: 'split' },
      h('div', {}, h('div', { class: 'muted small' }, 'Visits'), h('div', { class: 'big' }, d.visits)),
      h('div', {}, h('div', { class: 'muted small' }, 'Lifetime'), h('div', { class: 'big' }, money(d.lifetime_cents)))),
    h('div', { class: 'small muted' }, [c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details'),
    h('div', { class: 'split' },
      h('span', { class: 'pill' }, `Found us: ${c.source ?? 'unknown'}`),
      h('span', { class: `pill ${c.sms_opted_out ? 'bad' : c.sms_consent ? 'good' : ''}` }, c.sms_opted_out ? 'Replied STOP' : c.sms_consent ? 'OK to text' : 'No text consent')),
    c.notes ? h('p', { class: 'small' }, c.notes) : null,
    c.health_score != null ? h('div', { class: 'stack' },
      h('div', { class: 'split' }, h('span', { class: 'small muted' }, 'Health'), h('span', { class: `pill ${c.health_score >= 75 ? 'good' : c.health_score >= 50 ? 'warn' : 'bad'}` }, `${c.health_score}/100`)),
      (c.health_reasons ?? []).map((r) => h('div', { class: 'small muted' }, `• ${r}`))) : null);
  const actions = h('div', { class: 'split' },
    h('a', { class: 'btn primary', href: `/app/customers/${id}/book` }, cap(v.booking_verb ?? 'book')),
    h('a', { class: 'btn', href: `/app/inbox/${id}` }, 'Message'));
  const list = h('div', { class: 'card flush' });
  if (!d.bookings.length) list.append(h('p', { class: 'empty' }, `No ${v.job.many} yet.`));
  const TONE = { completed: 'good', cancelled: 'bad', no_show: 'bad', confirmed: '', requested: 'warn' };
  for (const b of d.bookings) {
    list.append(h('div', { class: 'row' }, h('span', { class: 'grow' }, h('div', { class: 'title' }, `${dayOf(b.starts_at)} · ${timeOf(b.starts_at)}`), h('div', { class: 'sub' }, [b.service, money(b.price_cents)].filter(Boolean).join(' · '))),
      h('span', { class: `pill ${TONE[b.status] ?? ''}` }, cap(b.status.replace('_', ' ')))));
  }
  const plans = await api(`/v1/series?customer_id=${id}`);
  const planCards = plans.filter((p) => p.status !== 'ended').map((p) => {
    const recLabel = state.business.pack.recurrence.options.find((o) => o.key === p.recurrence_key)?.label ?? p.recurrence_key;
    const err = h('p', { class: 'error' });
    const box = h('div', { class: 'card' }, h('div', { class: 'split' },
      h('div', {}, h('div', { class: 'title' }, `${p.service ?? cap(v.job.one)} · ${recLabel}`),
        h('div', { class: 'small muted' }, p.status === 'paused' ? `Paused${p.paused_until ? ' until ' + dayOf(p.paused_until) : ''}` : p.next_at ? `Next: ${dayOf(p.next_at)} ${timeOf(p.next_at)}` : 'Active'))));
    if (p.status === 'paused') {
      const resume = h('button', { class: 'btn small primary', type: 'button' }, 'Resume');
      resume.addEventListener('click', action(resume, err, async () => { await api(`/v1/series/${p.id}/resume`, { method: 'POST', body: {} }); toast('Resumed'); render(); }));
      box.append(h('div', { class: 'split' }, resume));
    } else {
      const weeks = h('select', { 'aria-label': 'Pause for' }, [2, 4, 8].map((w) => h('option', { value: String(w) }, `${w} weeks`)));
      const pause = h('button', { class: 'btn small', type: 'button' }, 'Pause');
      pause.addEventListener('click', action(pause, err, async () => {
        const until = new Date(Date.now() + Number(weeks.value) * 7 * 86400000).toISOString();
        await api(`/v1/series/${p.id}/pause`, { method: 'POST', body: { until } }); toast('Paused'); render();
      }));
      const reasons = state.business.pack.reasons.cancel;
      const why = h('select', { 'aria-label': 'Why is the plan ending?' }, h('option', { value: '' }, 'Why end it?'), reasons.map((r) => h('option', { value: r.code }, r.label)));
      const end = h('button', { class: 'btn small danger', type: 'button' }, 'End plan');
      end.addEventListener('click', action(end, err, async () => {
        if (!why.value) throw new Error('Pick a reason first.');
        await api(`/v1/series/${p.id}/end`, { method: 'POST', body: { reason_code: why.value } }); toast('Plan ended'); render();
      }));
      box.append(h('div', { class: 'split' }, weeks, pause), h('div', { class: 'split' }, why, end));
    }
    box.append(err);
    return box;
  });
  const invoices = await api(`/v1/invoices?customer_id=${id}`);
  const invList = h('div', { class: 'card flush' });
  if (!invoices.length) invList.append(h('p', { class: 'empty' }, 'No invoices yet.'));
  for (const inv of invoices) invList.append(invoiceRow(inv, !!c.default_payment_method));
  const amt = h('input', { type: 'number', min: '1', step: '0.01', inputmode: 'decimal', placeholder: 'Amount ($)', 'aria-label': 'Amount in dollars' });
  const what = h('input', { type: 'text', placeholder: 'What for', 'aria-label': 'What the invoice is for' });
  const invErr = h('p', { class: 'error' });
  const addInv = h('button', { class: 'btn small', type: 'button' }, 'Create invoice');
  addInv.addEventListener('click', action(addInv, invErr, async () => {
    const cents = Math.round(Number(amt.value) * 100);
    if (!cents || !what.value) throw new Error('Enter an amount and what it is for.');
    await api('/v1/invoices', { method: 'POST', body: { customer_id: id, amount_cents: cents, description: what.value } }); toast('Invoice created'); render();
  }));
  let refBox = null;
  if (state.business.pack.referrals?.enabled && d.visits > 0) {
    const ref = await api(`/v1/customers/${id}/referral`);
    const copy = h('button', { class: 'btn small', type: 'button' }, 'Copy link');
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(ref.link); toast('Link copied'); } catch { toast(ref.link); } });
    const gAmt = h('input', { type: 'number', min: '1', step: '1', placeholder: 'Credit ($)', 'aria-label': 'Credit amount in dollars' });
    const gErr = h('p', { class: 'error' });
    const give = h('button', { class: 'btn small', type: 'button' }, 'Give credit');
    give.addEventListener('click', action(give, gErr, async () => {
      const cents = Math.round(Number(gAmt.value) * 100);
      if (!cents) throw new Error('Enter an amount.');
      await api(`/v1/customers/${id}/credits`, { method: 'POST', body: { amount_cents: cents, reason: 'Goodwill credit' } }); toast('Credit added'); render();
    }));
    refBox = h('div', { class: 'card' }, h('h2', {}, 'Referrals and credit'),
      h('div', { class: 'split' }, h('span', {}, `Code ${ref.code}`), copy),
      h('div', { class: 'small muted' }, `${ref.referrals.length} referred · ${money(ref.credit_cents)} credit`),
      h('div', { class: 'split' }, gAmt, give), gErr);
  }
  const card = c.default_payment_method ? `Card on file: ${(c.card_brand ?? 'card').toUpperCase()} ${c.card_last4 ? '•• ' + c.card_last4 : ''}` : 'No card on file';
  return shell(fullName(c), [facts, actions, planCards.length ? h('span', { class: 'section-title' }, 'Recurring plan') : null, planCards,
    refBox, h('span', { class: 'section-title' }, 'Money'), h('p', { class: 'small muted' }, card), invList, h('div', { class: 'card' }, h('div', { class: 'split' }, amt, what), addInv, invErr),
    h('span', { class: 'section-title' }, cap(v.job.many)), list, eraseBox(id)], { back: '/app/customers' });
}

/** "Forget me" requests: removes who the person is, keeps anonymous money records. */
function eraseBox(id) {
  if (state.user && state.user.role !== 'owner') return null;
  const msg = h('p', { class: 'small muted' }, 'If someone asks you to delete their information, this removes their name, contact details, notes, messages and photos. Amounts and dates stay for your books.');
  const btn = h('button', { class: 'btn small danger', type: 'button' }, 'Delete their information');
  const box = h('div', { class: 'card' }, h('h2', {}, 'Privacy'), msg, btn);
  btn.addEventListener('click', () => {
    btn.remove();
    confirmInline(msg, 'This cannot be undone. Delete?', async () => {
      await api(`/v1/customers/${id}/erase`, { method: 'POST', body: {} }); toast('Information deleted'); go('/app/customers', { replace: true });
    });
  });
  return box;
}

async function viewBook(customerId) {
  const v = vocab();
  const [services, d] = await Promise.all([api('/v1/services'), api(`/v1/customers/${customerId}`)]);
  const active = services.filter((s) => s.active);
  const svc = h('select', { id: 'b-service' }, active.map((s) => h('option', { value: s.key }, s.name)));
  const when = h('input', { type: 'datetime-local', id: 'b-when', required: true });
  const rec = state.business.pack.recurrence;
  const repeat = h('select', { id: 'b-repeat' }, h('option', { value: '' }, 'Just once'), rec.enabled ? rec.options.map((o) => h('option', { value: o.key }, o.label)) : []);
  const inputsBox = h('div', { class: 'stack' });
  const priceOverride = h('input', { type: 'number', id: 'b-price', min: '0', step: '0.01', inputmode: 'decimal' });
  const priceBox = h('label', { class: 'field', for: 'b-price', hidden: true }, 'Your price ($)', priceOverride);
  const notes = h('textarea', { id: 'b-notes' });
  const total = h('div', { class: 'big' }, '—');
  const lines = h('div', { class: 'small muted' });
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, `${cap(v.booking_verb ?? 'book')} it`);
  let inputs = {};

  const drawInputs = () => {
    const s = active.find((x) => x.key === svc.value);
    inputsBox.replaceChildren(); inputs = {};
    const rule = s?.price_rule;
    if (rule?.type === 'hourly') {
      const m = h('input', { type: 'number', min: String(rule.min_minutes ?? 60), step: '15', value: String(s.duration_min), id: 'b-minutes' });
      inputs.minutes = s.duration_min;
      m.addEventListener('input', () => { inputs.minutes = Number(m.value); requote(); });
      inputsBox.append(h('label', { class: 'field', for: 'b-minutes' }, 'Minutes', m));
    }
    if (rule?.type === 'formula') {
      for (const inp of rule.inputs) {
        const id = `b-in-${inp.key}`;
        let el;
        if (inp.kind === 'number') { el = h('input', { type: 'number', id, min: String(inp.min ?? 0), max: inp.max != null ? String(inp.max) : null, value: String(inp.default ?? 0) }); inputs[inp.key] = inp.default ?? 0; }
        else { el = h('select', { id }, inp.options.map((o) => h('option', { value: o.key }, o.label))); inputs[inp.key] = inp.options[0].key; }
        el.addEventListener('input', () => { inputs[inp.key] = inp.kind === 'number' ? Number(el.value) : el.value; requote(); });
        inputsBox.append(h('label', { class: 'field', for: id }, inp.label, el));
      }
    }
    priceBox.hidden = rule?.type !== 'quote';
    requote();
  };
  const requote = async () => {
    try {
      const q = await api('/v1/quotes', { method: 'POST', body: { service_key: svc.value, inputs, recurrence_key: repeat.value || null } });
      if (q.needs_owner_quote) { total.textContent = priceOverride.value ? money(Math.round(Number(priceOverride.value) * 100)) : 'Set a price'; lines.textContent = 'Priced by quote'; }
      else { total.textContent = money(q.amount_cents); lines.textContent = q.lines.map((l) => `${l.label}: ${money(l.cents)}`).join(' · '); }
    } catch (e) { lines.textContent = e.message; }
  };
  svc.addEventListener('change', drawInputs); repeat.addEventListener('change', requote); priceOverride.addEventListener('input', requote);
  drawInputs();

  const form = h('form', { class: 'card' },
    h('label', { class: 'field', for: 'b-service' }, 'Service', svc),
    h('label', { class: 'field', for: 'b-when' }, h('span', {}, 'When ', h('span', { class: 'hint' }, `(${state.tz.replace('_', ' ')} time)`)), when),
    h('label', { class: 'field', for: 'b-repeat' }, 'Repeat', repeat),
    inputsBox, priceBox,
    h('label', { class: 'field', for: 'b-notes' }, 'Notes', notes),
    h('div', {}, h('div', { class: 'muted small' }, 'Price'), total, lines), err, btn);
  form.addEventListener('submit', action(btn, err, async () => {
    if (!when.value) throw new Error('Pick a date and time.');
    const body = { customer_id: customerId, service_key: svc.value, starts_at: zonedToUtc(when.value, state.tz).toISOString(), inputs, recurrence_key: repeat.value || null, notes: notes.value || undefined };
    if (!priceBox.hidden) {
      if (!priceOverride.value) throw new Error('Set a price for this quoted service.');
      body.price_cents = Math.round(Number(priceOverride.value) * 100);
    }
    await api('/v1/bookings', { method: 'POST', body });
    toast('Booked'); go(`/app/customers/${customerId}`, { replace: true });
  }));
  return shell(`${cap(v.booking_verb ?? 'Book')} ${fullName(d.customer)}`, [form], { back: `/app/customers/${customerId}` });
}

/* ---------- Money ---------- */
const INV_TONE = { open: ['Unpaid', 'warn'], failed: ['Declined', 'bad'], paid: ['Paid', 'good'], refunded: ['Refunded', ''], void: ['Void', ''] };
function invoiceRow(inv, hasCard) {
  const [label, tone] = INV_TONE[inv.status] ?? [inv.status, ''];
  const err = h('p', { class: 'error' });
  const panel = h('div', { class: 'stack', hidden: true });
  panel.style.padding = '0 16px 14px';
  const row = h('button', { class: 'row', type: 'button' },
    h('span', { class: 'grow' }, h('div', { class: 'title' }, `${money(inv.amount_cents)} · ${inv.description}`),
      h('div', { class: 'sub' }, `#${inv.number} · ${inv.first_name ? fullName(inv) + ' · ' : ''}${dayOf(inv.paid_at ?? inv.created_at)}${inv.failure_reason ? ' · ' + inv.failure_reason.replace(/_/g, ' ') : ''}`)),
    h('span', { class: `pill ${tone}` }, label));
  row.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  const btn = (text, cls, fn) => { const b = h('button', { class: `btn small ${cls}`, type: 'button' }, text); b.addEventListener('click', action(b, err, fn)); return b; };
  const post = (path, body = {}) => api(`/v1/invoices/${inv.id}/${path}`, { method: 'POST', body });
  if (inv.status === 'open' || inv.status === 'failed') {
    panel.append(h('div', { class: 'split' },
      btn('Text pay link', 'primary', async () => { await post('send-link'); toast('Pay link sent'); }),
      hasCard ? btn('Charge card', '', async () => { const r = await post('charge'); toast(r.status === 'succeeded' ? 'Paid' : 'Card declined'); render(); }) : null),
      h('div', { class: 'split' },
        btn('Paid in cash', '', async () => { await post('mark-paid', { method: 'cash' }); toast('Marked paid'); render(); }),
        btn('Paid by check', '', async () => { await post('mark-paid', { method: 'check' }); toast('Marked paid'); render(); }),
        btn('Void', 'danger', async () => { await post('void'); toast('Voided'); render(); })));
  } else if (inv.status === 'paid' || (inv.status === 'refunded' && inv.refunded_cents < inv.amount_cents)) {
    const amt = h('input', { type: 'number', min: '0.01', step: '0.01', placeholder: 'Amount ($), blank for all', 'aria-label': 'Refund amount' });
    panel.append(h('div', { class: 'split' }, amt, btn('Refund', 'danger', async () => {
      const body = amt.value ? { amount_cents: Math.round(Number(amt.value) * 100) } : {};
      await post('refund', body); toast('Refunded'); render();
    })));
  }
  panel.append(err);
  return h('div', {}, row, panel);
}

async function viewMoney() {
  const [open, failed, paid] = await Promise.all([api('/v1/invoices?status=open'), api('/v1/invoices?status=failed'), api('/v1/invoices?status=paid')]);
  const monthAgo = Date.now() - 30 * 86400000;
  const recent = paid.filter((i) => new Date(i.paid_at).getTime() > monthAgo);
  const unpaid = [...failed, ...open];
  const sum = (xs) => xs.reduce((a, i) => a + i.amount_cents, 0);
  const top = h('div', { class: 'card' }, h('div', { class: 'split' },
    h('div', {}, h('div', { class: 'muted small' }, 'Unpaid'), h('div', { class: 'big' }, money(sum(unpaid)))),
    h('div', {}, h('div', { class: 'muted small' }, 'Paid, last 30 days'), h('div', { class: 'big' }, money(sum(recent))))));
  const list = (xs, empty) => { const c = h('div', { class: 'card flush' }); if (!xs.length) c.append(h('p', { class: 'empty' }, empty)); xs.forEach((i) => c.append(invoiceRow(i, false))); return c; };
  return shell('Money', [top, h('span', { class: 'section-title' }, 'Waiting to be paid'), list(unpaid, 'Nothing outstanding.'), h('span', { class: 'section-title' }, 'Paid recently'), list(recent.slice(0, 30), 'No payments yet.')], { back: '/app' });
}

/* ---------- Photos and Grow ---------- */
/** Shrink a photo on the phone before upload: faster on mobile data, and plenty for the web. */
async function shrink(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
}
async function uploadPhotos(files, { bookingId, publicOk }) {
  let n = 0;
  for (const f of files) {
    const blob = await shrink(f);
    const q = new URLSearchParams({ public_ok: publicOk ? '1' : '0' });
    if (bookingId) q.set('booking_id', bookingId);
    const res = await fetch(`/v1/photos?${q}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'image/jpeg', 'x-fw-csrf': '1' }, body: blob });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
    n++;
  }
  return n;
}
function photoPicker(bookingId) {
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, capture: 'environment', hidden: true });
  const ok = h('input', { type: 'checkbox' });
  const btn = h('button', { class: 'btn small', type: 'button' }, 'Add photos');
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    if (!input.files?.length) return;
    btn.disabled = true; btn.textContent = 'Uploading…';
    try { const n = await uploadPhotos([...input.files], { bookingId, publicOk: ok.checked }); toast(`${n} photo${n > 1 ? 's' : ''} saved`); }
    catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = 'Add photos'; input.value = ''; }
  });
  return h('div', { class: 'stack' }, h('div', { class: 'split' }, btn), h('label', { class: 'check' }, ok, h('span', {}, 'The customer is OK with us sharing these photos publicly')), input);
}

async function viewGrow() {
  const [gstat, reviews, posts, photos, ai] = await Promise.all([api('/v1/google'), api('/v1/reviews'), api('/v1/posts'), api('/v1/photos'), api('/v1/ai-visibility')]);
  const flash = new URLSearchParams(location.search).get('google');
  const blocks = [];
  if (flash) blocks.push(h('p', { class: 'notice' }, { connected: 'Google is connected.', failed: 'Google didn\u2019t connect. Try again.', expired: 'That sign-in took too long. Try again.', cancelled: 'Google sign-in was cancelled.' }[flash] ?? ''));

  // Google
  const gErr = h('p', { class: 'error' });
  const gCard = h('div', { class: 'card' }, h('h2', {}, 'Google Business Profile'));
  if (!gstat.connected) {
    const connect = h('button', { class: 'btn primary', type: 'button' }, 'Connect Google');
    connect.addEventListener('click', action(connect, gErr, async () => { const r = await api('/v1/google/connect'); location.href = r.url; }));
    put(gCard, h('p', { class: 'small muted' }, 'Pull in your Google reviews, reply to them from here, and post your work to your profile.'), connect);
    if (!gstat.live) put(gCard, h('p', { class: 'small muted' }, 'Google keys are not set on the server yet, so this runs in practice mode.'));
  } else {
    put(gCard, h('p', {}, gstat.location ? `Connected: ${gstat.location}` : 'Connected. Pick your location:'));
    if (gstat.status === 'needs_location' && gstat.locations) {
      const sel = h('select', { 'aria-label': 'Business location' }, gstat.locations.map((l) => h('option', { value: `${l.account}|${l.location}` }, l.title)));
      const pick = h('button', { class: 'btn primary small', type: 'button' }, 'Use this location');
      pick.addEventListener('click', action(pick, gErr, async () => { const [account, loc] = sel.value.split('|'); await api('/v1/google/location', { method: 'POST', body: { account, location: loc } }); render(); }));
      put(gCard, h('div', { class: 'split' }, sel, pick));
    }
    const sync = h('button', { class: 'btn small', type: 'button' }, 'Check for new reviews');
    sync.addEventListener('click', action(sync, gErr, async () => { const r = await api('/v1/google/sync', { method: 'POST', body: {} }); toast(r.added ? `${r.added} new review${r.added > 1 ? 's' : ''}` : 'No new reviews'); render(); }));
    put(gCard, h('div', { class: 'small muted' }, gstat.last_sync_at ? `Last checked ${ago(gstat.last_sync_at)} ago` : 'Not checked yet'), gstat.last_error ? h('p', { class: 'error' }, gstat.last_error) : null, h('div', { class: 'split' }, sync));
  }
  put(gCard, gErr);
  blocks.push(gCard);

  // Reviews
  const rList = h('div', { class: 'card flush' });
  if (!reviews.length) rList.append(h('p', { class: 'empty' }, 'No reviews yet.'));
  for (const r of reviews.slice(0, 30)) {
    const err = h('p', { class: 'error' });
    const box = h('div', { class: 'stack' });
    box.style.padding = '14px 16px';
    box.style.borderTop = '1px solid var(--line)';
    put(box, h('div', { class: 'split' }, h('strong', {}, `${'★'.repeat(r.rating ?? 0)}${'☆'.repeat(5 - (r.rating ?? 0))}`),
      h('span', { class: `pill ${r.is_private_feedback ? 'warn' : ''}` }, r.is_private_feedback ? 'Private feedback' : r.platform)),
      h('div', { class: 'small muted' }, `${r.reviewer_name ?? fullName(r)} · ${dayOf(r.created_at)}`),
      r.body ? h('p', {}, r.body) : null);
    if (r.reply) put(box, h('p', { class: 'small' }, h('strong', {}, 'Your reply: '), r.reply));
    else if (r.platform === 'google' && (r.reply_status === 'drafted' || r.reply_status === 'failed')) {
      const ta = h('textarea', { value: r.reply_draft ?? '', 'aria-label': 'Reply' });
      const post = h('button', { class: 'btn primary small', type: 'button' }, 'Post reply');
      post.addEventListener('click', action(post, err, async () => { await api(`/v1/reviews/${r.id}/reply`, { method: 'POST', body: { text: ta.value } }); toast('Reply posted'); render(); }));
      put(box, ta, h('div', { class: 'split' }, post), r.reply_status === 'failed' ? h('p', { class: 'error' }, 'The last try to post failed. Check the Google connection.') : null);
    }
    put(box, err);
    rList.append(box);
  }
  blocks.push(h('span', { class: 'section-title' }, 'Reviews'), rList);

  // Posts
  const pErr = h('p', { class: 'error' });
  const make = h('button', { class: 'btn small', type: 'button' }, 'Make a post from a photo');
  make.addEventListener('click', action(make, pErr, async () => { await api('/v1/posts/draft', { method: 'POST', body: {} }); render(); }));
  const pList = h('div', { class: 'stack' });
  for (const p of posts.filter((x) => x.status === 'draft' || x.status === 'failed')) {
    const err = h('p', { class: 'error' });
    const ta = h('textarea', { value: p.body, 'aria-label': 'Post text' });
    const pub = h('button', { class: 'btn primary small', type: 'button' }, 'Publish to Google');
    pub.addEventListener('click', action(pub, err, async () => { await api(`/v1/posts/${p.id}/publish`, { method: 'POST', body: { body: ta.value } }); toast('Posted'); render(); }));
    const no = h('button', { class: 'btn small', type: 'button' }, 'Discard');
    no.addEventListener('click', action(no, err, async () => { await api(`/v1/posts/${p.id}/reject`, { method: 'POST', body: {} }); render(); }));
    pList.append(h('div', { class: 'card' }, p.photo_url ? h('img', { src: p.photo_url, alt: '', class: 'post-photo' }) : null, ta, h('div', { class: 'split' }, pub, no), p.error ? h('p', { class: 'error' }, p.error) : null, err));
  }
  const published = posts.filter((x) => x.status === 'published').length;
  blocks.push(h('span', { class: 'section-title' }, 'Business Profile posts'), pList,
    h('div', { class: 'card' }, h('p', { class: 'small muted' }, `${published} published. A new draft is made each week from photos customers agreed to share.`), h('div', { class: 'split' }, make), pErr));

  // Photos
  const grid = h('div', { class: 'photo-grid' });
  for (const p of photos.slice(0, 24)) grid.append(h('figure', {}, h('img', { src: p.url, alt: p.caption ?? '', loading: 'lazy' }), p.public_ok ? h('figcaption', {}, 'Shareable') : null));
  blocks.push(h('span', { class: 'section-title' }, 'Photos'), h('div', { class: 'card' }, photoPicker(null), photos.length ? grid : h('p', { class: 'small muted' }, 'No photos yet. Add them from a job on the Today screen too.')));

  // AI visibility
  const aErr = h('p', { class: 'error' });
  const check = h('button', { class: 'btn small', type: 'button' }, 'Check now');
  check.addEventListener('click', action(check, aErr, async () => { const r = await api('/v1/ai-visibility/check', { method: 'POST', body: {} }); if (r.skipped) throw new Error(r.skipped); toast('Checked'); render(); }));
  const aList = h('div', { class: 'stack' }, ai.slice(0, 4).map((x) => h('div', {}, h('div', { class: 'split' }, h('span', { class: 'small' }, x.query), h('span', { class: `pill ${x.mentioned ? 'good' : 'bad'}` }, x.mentioned ? 'You\u2019re named' : 'Not named')), h('div', { class: 'small muted' }, x.excerpt ?? ''))));
  blocks.push(h('span', { class: 'section-title' }, 'AI assistants'), h('div', { class: 'card' },
    h('p', { class: 'small muted' }, 'We ask an AI assistant with web search the question a customer would, and see if it names you. Runs monthly.'), aList, h('div', { class: 'split' }, check), aErr));
  return shell('Grow', blocks, { back: '/app/scorecard' });
}

/* ---------- Services and setup ---------- */
function priceText(rule) {
  if (!rule) return '';
  if (rule.type === 'fixed') return money(rule.amount_cents);
  if (rule.type === 'hourly') return `${money(rule.rate_cents)}/hour`;
  if (rule.type === 'formula') return `from ${money(rule.base_cents)}`;
  return 'Quote';
}

function serviceForm(svc, onDone) {
  const err = h('p', { class: 'error' });
  const name = h('input', { type: 'text', value: svc?.name ?? '', 'aria-label': 'Service name', placeholder: 'Standard clean' });
  const minutes = h('input', { type: 'number', min: '5', step: '5', value: String(svc?.duration_min ?? 60), 'aria-label': 'Minutes' });
  const rule = svc?.price_rule ?? { type: 'fixed', amount_cents: 10000 };
  const type = h('select', { 'aria-label': 'How it is priced' }, [['fixed', 'Fixed price'], ['hourly', 'By the hour'], ['formula', 'Base + per item'], ['quote', 'Quote each time']].map(([v, l]) => h('option', { value: v, selected: rule.type === v ? true : null }, l)));
  const amount = h('input', { type: 'number', min: '0', step: '1', value: String(((rule.amount_cents ?? rule.rate_cents ?? rule.base_cents ?? 0) / 100)), 'aria-label': 'Price in dollars' });
  const inputs = h('div', { class: 'stack' });
  const addInput = (inp = { key: '', label: '', per_unit_cents: 0, default: 1 }) => {
    const label = h('input', { type: 'text', value: inp.label, placeholder: 'Bedrooms', 'aria-label': 'What is counted' });
    const per = h('input', { type: 'number', min: '0', step: '1', value: String(inp.per_unit_cents / 100), 'aria-label': 'Dollars each' });
    const row = h('div', { class: 'split' }, label, per);
    row._get = () => ({ kind: 'number', key: (label.value || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '_'), label: label.value || 'Items', per_unit_cents: Math.round(Number(per.value) * 100), min: 0, default: inp.default ?? 1 });
    inputs.append(row);
  };
  (rule.inputs ?? []).forEach(addInput);
  const more = h('button', { class: 'btn small', type: 'button' }, 'Add a per-item charge');
  more.addEventListener('click', () => addInput());
  const formulaBox = h('div', { class: 'stack' }, h('span', { class: 'small muted' }, 'Per-item charges (e.g. $20 per bedroom)'), inputs, more);
  const sync = () => { amount.parentElement.hidden = type.value === 'quote'; formulaBox.hidden = type.value !== 'formula'; };
  type.addEventListener('change', sync);
  const online = h('input', { type: 'checkbox', checked: svc?.bookable_online ?? true });
  const save = h('button', { class: 'btn primary small', type: 'button' }, svc ? 'Save' : 'Add service');
  save.addEventListener('click', action(save, err, async () => {
    const dollars = Math.round(Number(amount.value) * 100);
    const price_rule = type.value === 'fixed' ? { type: 'fixed', amount_cents: dollars }
      : type.value === 'hourly' ? { type: 'hourly', rate_cents: dollars, min_minutes: 60, increment_minutes: 15 }
      : type.value === 'formula' ? { type: 'formula', base_cents: dollars, minimum_cents: 0, inputs: [...inputs.children].map((r) => r._get()) }
      : { type: 'quote' };
    const body = { name: name.value, duration_min: Number(minutes.value), price_rule, bookable_online: online.checked };
    if (!body.name) throw new Error('Give the service a name.');
    if (svc) await api(`/v1/services/${svc.key}`, { method: 'PATCH', body }); else await api('/v1/services', { method: 'POST', body });
    toast('Saved'); onDone();
  }));
  const box = h('div', { class: 'card' },
    h('label', { class: 'field' }, 'Name', name),
    h('div', { class: 'split' }, h('label', { class: 'field' }, 'Minutes', minutes), h('label', { class: 'field' }, 'Pricing', type)),
    h('label', { class: 'field' }, 'Price ($)', amount), formulaBox,
    h('label', { class: 'check' }, online, h('span', {}, 'Customers can book this online')), h('div', { class: 'split' }, save), err);
  sync();
  return box;
}

async function viewServices() {
  const services = (await api('/v1/services')).filter((x) => x.active);
  const list = h('div', { class: 'card flush' });
  if (!services.length) list.append(h('p', { class: 'empty' }, 'No services yet. Add your first one below.'));
  for (const svc of services) {
    const holder = h('div', { hidden: true });
    holder.style.padding = '0 12px 12px';
    const row = h('button', { class: 'row', type: 'button', 'aria-expanded': 'false' }, h('span', { class: 'grow' }, h('div', { class: 'title' }, svc.name), h('div', { class: 'sub' }, `${svc.duration_min} min · ${priceText(svc.price_rule)}${svc.bookable_online ? '' : ' · not online'}`)), h('span', { class: 'meta' }, 'Edit'));
    row.addEventListener('click', () => {
      if (!holder.children.length) {
        const off = h('button', { class: 'btn small danger', type: 'button' }, 'Remove this service');
        off.addEventListener('click', action(off, null, async () => { await api(`/v1/services/${svc.key}`, { method: 'PATCH', body: { active: false } }); render(); }));
        holder.append(serviceForm(svc, render), h('div', { class: 'split' }, off));
      }
      holder.hidden = !holder.hidden; row.setAttribute('aria-expanded', String(!holder.hidden));
    });
    list.append(h('div', {}, row, holder));
  }
  return shell('Services and prices', [list, h('span', { class: 'section-title' }, 'Add a service'), serviceForm(null, render)], { back: '/app/settings', actions: h('span', {}) });
}

async function viewSetup() {
  const st = await api('/v1/setup');
  const v = vocab();
  const S = st.steps;
  const tick = (ok) => h('span', { class: `pill ${ok ? 'good' : ''}` }, ok ? 'Done' : 'To do');
  const step = (ok, title, sub, href) => h('a', { class: 'row', href }, h('span', { class: 'grow' }, h('div', { class: 'title' }, title), h('div', { class: 'sub' }, sub)), tick(ok));

  // 1. Describe the business
  const desc = h('textarea', { placeholder: 'e.g. I clean homes in South Austin. Standard clean $150 for up to 3 bedrooms, deep clean $300. Most clients every 2 weeks. Mon-Fri 8-5.', rows: '4', 'aria-label': 'Describe your business' });
  const dErr = h('p', { class: 'error' });
  const preview = h('div', { class: 'stack' });
  const ask = h('button', { class: 'btn primary', type: 'button' }, 'Set it up for me');
  ask.addEventListener('click', action(ask, dErr, async () => {
    const p = await api('/v1/setup/suggest', { method: 'POST', body: { description: desc.value } });
    const apply = h('button', { class: 'btn primary', type: 'button' }, 'Use this');
    apply.addEventListener('click', action(apply, dErr, async () => { await api('/v1/setup/apply', { method: 'POST', body: p }); state.business = null; toast('Set up. You can change anything later.'); render(); }));
    preview.replaceChildren(h('div', { class: 'card' },
      h('h2', {}, 'Here\u2019s what I\u2019d set up'),
      h('div', { class: 'small' }, `You serve ${p.vocabulary.customer.many}; the work is called ${p.vocabulary.job.many}.`),
      p.services.map((x) => h('div', { class: 'split' }, h('span', {}, x.name), h('span', { class: 'meta' }, `${x.duration_min} min · ${priceText(x.price_rule)}`))),
      p.recurrence?.length ? h('div', { class: 'small muted' }, `Repeat options: ${p.recurrence.map((r) => r.label).join(', ')}`) : null,
      p.headline ? h('div', { class: 'small' }, h('strong', {}, 'Website headline: '), p.headline) : null,
      h('div', { class: 'split' }, apply)));
  }));

  // 5. Customers
  const file = h('input', { type: 'file', accept: '.csv,.vcf,text/csv,text/vcard', 'aria-label': 'Customer file' });
  const consent = h('select', { 'aria-label': 'Have they agreed to texts?' }, h('option', { value: 'none' }, 'I\u2019m not sure they agreed to texts'), h('option', { value: 'verbal' }, 'They agreed to texts (in person or by phone)'), h('option', { value: 'written' }, 'They agreed in writing'));
  const iErr = h('p', { class: 'error' });
  const imp = h('button', { class: 'btn primary', type: 'button' }, 'Import');
  const iOut = h('p', { class: 'small' });
  imp.addEventListener('click', action(imp, iErr, async () => {
    const f = file.files?.[0];
    if (!f) throw new Error('Choose a file first: a spreadsheet saved as CSV, or contacts exported as a .vcf.');
    const res = await fetch(`/v1/import/customers?consent=${consent.value}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': f.name.endsWith('.vcf') ? 'text/vcard' : 'text/csv', 'x-fw-csrf': '1' }, body: await f.text() });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error);
    iOut.textContent = `Added ${r.created}, updated ${r.updated}${r.skipped ? `, skipped ${r.skipped}` : ''}.${r.errors?.length ? ' ' + r.errors.slice(0, 3).join(' ') : ''}`;
  }));
  const wErr = h('p', { class: 'error' });
  const win = (kind, label) => { const b = h('button', { class: 'btn small', type: 'button' }, label); b.addEventListener('click', action(b, wErr, async () => { const r = await api('/v1/campaigns', { method: 'POST', body: { kind } }); toast(r.drafted ? `${r.drafted} drafts ready in your Inbox` : 'Nobody to message yet'); })); return b; };

  const dismiss = h('button', { class: 'btn small', type: 'button' }, 'Hide this checklist');
  dismiss.addEventListener('click', action(dismiss, null, async () => { await api('/v1/setup/dismiss', { method: 'POST', body: {} }); go('/app'); }));

  return shell('Getting started', [
    h('div', { class: 'card' }, h('h2', {}, '1. Tell me about your business'), h('p', { class: 'small muted' }, 'A sentence or two: what you do, where, your prices, and your hours. I\u2019ll set up your services, words, hours and website. Needs AI turned on in Settings.'), desc, h('div', { class: 'split' }, ask), dErr, preview),
    h('div', { class: 'card flush' },
      step(S.services, 'Services and prices', 'Check what you offer and what it costs', '/app/settings/services'),
      step(S.hours, 'Hours and booking rules', 'When customers can book', '/app/settings/hours'),
      step(S.website, 'Website', 'Headline, area, questions', '/app/settings/website'),
      step(S.forwarding, 'Ring my phone', 'Calls to your business number go to your cell first', '/app/settings'),
      step(S.google, 'Google Business Profile', 'Reviews and posts', '/app/grow')),
    h('div', { class: 'card' }, h('h2', {}, `Bring in your ${v.customer.many}`), h('p', { class: 'small muted' }, 'From a spreadsheet (save as CSV) or your phone contacts (.vcf). Columns like Name, Phone, Email and Last visit are recognized.'), file, consent, h('div', { class: 'split' }, imp), iOut, iErr),
    h('div', { class: 'card' }, h('h2', {}, 'Quick wins'), h('p', { class: 'small muted' }, 'Drafts for you to check in the Inbox before anything is sent.'), h('div', { class: 'split' }, win('review_ask', 'Ask recent customers for a review'), win('win_back', 'Invite lapsed customers back')), wErr),
    h('p', { class: 'small muted' }, S.phone ? 'Your business number is connected.' : 'Your business phone number is set up by your administrator (Twilio).'),
    h('div', { class: 'split' }, dismiss),
  ], { back: '/app' });
}

/* ---------- Scorecard ---------- */
const METRICS = [
  ['leads', 'New leads', 'count'], ['lead_to_booking', 'Leads who book', 'rate'], ['jobs_completed', '__jobs', 'count'],
  ['revenue_cents', 'Revenue', 'money'], ['repeat_rate', '__repeat', 'rate'], ['second_visit_7d', 'Booked again within 7 days', 'rate'],
  ['review_rate', 'Reviews per completed __job', 'rate'], ['referral_share', 'New __customers from referrals', 'rate'],
  ['missed_calls', 'Missed calls', 'count'], ['missed_calls_recovered', 'Missed calls that booked', 'count'],
];
async function viewScorecard() {
  const v = vocab();
  const s = await api('/v1/scorecard');
  const label = (l) => l.replace('__jobs', `${cap(v.job.many)} completed`).replace('__repeat', `${cap(v.customer.many)} who come back`).replace('__job', v.job.one).replace('__customers', v.customer.many);
  const show = (kind, val) => kind === 'rate' ? pct(val) : kind === 'money' ? money(val) : (val ?? '—');
  const key = h('div', { class: 'card' }, h('h2', {}, 'Key number'), h('div', { class: 'big' }, pct(s.key_metric.value)), h('div', { class: 'muted small' }, `${s.key_metric.label}, last ${s.period_days} days`));
  const blocks = [key, h('a', { class: 'card', href: '/app/grow' }, h('div', { class: 'split' }, h('div', {}, h('div', { class: 'title' }, 'Grow'), h('div', { class: 'small muted' }, 'Google reviews, posts, photos, AI visibility')), h('span', { class: 'meta' }, '›')))];
  const ins = await api('/v1/insights').catch(() => null);
  const bn = ins?.bottleneck ?? s.bottleneck;
  if (bn) {
    blocks.push(h('div', { class: 'card focus' }, h('span', { class: 'label' }, 'Fix this first'),
      h('p', {}, `${bn.label}: ${pct(bn.previous)} → ${pct(bn.current)}.${bn.impact_label ? ` Getting it back is worth ${bn.impact_label}.` : ''}`),
      (bn.hints ?? []).map((x) => h('div', { class: 'small' }, `• ${x}`)),
      bn.action ? h('div', { class: 'small' }, h('strong', {}, 'Try: '), bn.action) : null));
  }
  if (ins?.capacity) {
    const bars = h('div', { class: 'cap-bars' }, ins.capacity.weeks.map((w) => {
      const u = w.utilization ?? 0;
      const fill = h('span', { class: `cap-fill ${u >= 0.9 ? 'hot' : ''}` });
      fill.style.width = `${Math.min(100, Math.round(u * 100))}%`;
      return h('div', { class: 'cap-row' }, h('span', { class: 'cap-label' }, `Week of ${fmt(w.week_start + 'T12:00:00Z', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`),
        h('span', { class: 'cap-track' }, fill), h('span', { class: 'cap-val' }, w.utilization == null ? '—' : `${Math.round(u * 100)}%`));
    }));
    blocks.push(h('div', { class: 'card' }, h('h2', {}, 'How full you are'), bars, h('p', { class: 'small' }, ins.capacity.advice)));
  }
  const list = h('div', { class: 'card flush' });
  for (const [k, l, kind] of METRICS) {
    const cur = s.current[k], prev = s.previous[k];
    let delta = null;
    if (cur != null && prev != null && cur !== prev) {
      const better = cur > prev;
      delta = h('span', { class: better ? 'up' : 'down' }, `${better ? '▲' : '▼'} from ${show(kind, prev)}`);
    }
    list.append(h('div', { class: 'metric' }, h('span', {}, label(l)), h('span', { class: 'v' }, show(kind, cur)), h('span', { class: 'd' }, delta ?? `Previous ${s.period_days} days: ${show(kind, prev)}`)));
  }
  blocks.push(h('span', { class: 'section-title' }, `Last ${s.period_days} days`), list);
  const reasons = await api('/v1/insights/reasons').catch(() => null);
  const rErr = h('p', { class: 'error' });
  const run = h('button', { class: 'btn small', type: 'button' }, reasons ? 'Refresh' : 'Summarize');
  run.addEventListener('click', action(run, rErr, async () => { await api('/v1/insights/reasons', { method: 'POST', body: { days: 90 } }); render(); }));
  const KIND = { cancel: 'Why people cancel', lost_quote: 'Why quotes are lost', joined: 'What brought people in' };
  blocks.push(h('div', { class: 'card' }, h('h2', {}, 'Why people leave and join (90 days)'),
    reasons ? [
      reasons.summary ? h('p', { class: 'small pre' }, reasons.summary) : null,
      Object.entries(reasons.counts ?? {}).map(([k, list]) => h('div', { class: 'small' }, h('strong', {}, `${KIND[k] ?? k}: `), list.map((x) => `${x.label} ${x.n}`).join(', '))),
      reasons.sources?.length ? h('div', { class: 'small' }, h('strong', {}, 'New customers from: '), reasons.sources.map((x) => `${x.source} ${x.n}`).join(', ')) : null,
    ] : h('p', { class: 'small muted' }, 'A summary of cancel reasons, lost quotes and where customers come from. Updated monthly.'),
    h('div', { class: 'split' }, run), rErr));
  return shell('Scorecard', blocks);
}

/* ---------- Settings ---------- */
const PLAYBOOK_LABELS = {
  missed_call_textback: ['Text back missed calls', 'Sends a text within seconds when you can’t pick up.'],
  lead_response: ['Reply to new leads', 'Instant reply to website leads, then follow-ups until they answer.'],
  review_request: ['Ask for reviews', 'After each completed job, asks every customer for a review.'],
  inbox_assist: ['Draft replies with AI', 'Writes a suggested reply when someone texts you.'],
  booking_confirmation: ['Confirm bookings', 'Texts the time and a link to change it.'],
  booking_reminder: ['Send reminders', 'Texts a reminder the day before each visit.'],
  payment_request: ['Get paid after each job', 'Texts a pay link, or charges the card on file if you allow it below.'],
  payment_receipt: ['Send receipts', 'Texts a receipt when a payment comes in.'],
  payment_recovery: ['Recover declined cards', 'Kindly asks for a new card and retries.'],
  first_visit_checkin: ['Check in after a first visit', 'Asks new customers to rate their first visit from 1 to 5.'],
  at_risk_checkin: ['Catch customers slipping away', 'When someone\u2019s health score drops, suggests a personal message.'],
  win_back: ['Win back lapsed customers', 'Invites people back after 60, 90 and 180 days away.'],
  referral_ask: ['Ask for referrals', 'After a few visits, sends loyal customers their share link.'],
};
const TRUST = [['suggest', 'Just suggest'], ['draft', 'Draft for my OK'], ['auto', 'Send automatically']];

async function viewSettings() {
  const b = state.business = await api('/v1/business');
  const err = h('p', { class: 'error', role: 'alert' });
  const f = {
    name: h('input', { type: 'text', id: 's-name', value: b.name }),
    tz: h('input', { type: 'text', id: 's-tz', value: b.timezone }),
    review: h('input', { type: 'url', id: 's-review', value: b.review_url ?? '', placeholder: 'https://g.page/r/…' }),
    forward: h('input', { type: 'tel', id: 's-forward', value: b.settings?.forward_to ?? '', placeholder: '+15125550100' }),
    tagline: h('input', { type: 'text', id: 's-tagline', value: b.settings?.tagline ?? '' }),
    address: h('input', { type: 'text', id: 's-address', value: b.settings?.address ?? '', autocomplete: 'street-address', placeholder: '123 Main St, Austin, TX 78701' }),
  };
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const bizForm = h('form', { class: 'card' }, h('h2', {}, 'Business'),
    h('label', { class: 'field', for: 's-name' }, 'Name', f.name),
    h('label', { class: 'field', for: 's-tagline' }, 'One-line description', f.tagline),
    h('label', { class: 'field', for: 's-tz' }, 'Time zone', f.tz),
    h('label', { class: 'field', for: 's-review' }, 'Google review link', f.review),
    h('label', { class: 'field', for: 's-forward' }, h('span', {}, 'Ring my phone ', h('span', { class: 'hint' }, 'calls to your business number go here first')), f.forward),
    h('label', { class: 'field', for: 's-address' }, h('span', {}, 'Mailing address ', h('span', { class: 'hint' }, 'shown at the bottom of emails, as the law requires')), f.address),
    err, save);
  bizForm.addEventListener('submit', action(save, err, async () => {
    await api('/v1/business', { method: 'PATCH', body: { name: f.name.value, timezone: f.tz.value, review_url: f.review.value || null } });
    const settings = { tagline: f.tagline.value, address: f.address.value.trim() };
    if (f.forward.value) settings.forward_to = f.forward.value;
    await api('/v1/business/settings', { method: 'PATCH', body: settings });
    state.business = null; toast('Saved');
  }));

  const pbCard = h('div', { class: 'card flush' });
  for (const [key, [title, desc]] of Object.entries(PLAYBOOK_LABELS)) {
    const cfg = b.pack.playbooks[key];
    const toggle = h('input', { type: 'checkbox', checked: cfg.enabled, 'aria-label': `${title} on or off` });
    const trust = h('select', { 'aria-label': `${title}: how much it does on its own` }, TRUST.map(([v, l]) => h('option', { value: v, selected: cfg.trust === v ? true : null }, l)));
    const saveOne = async (patch) => {
      try { state.business.pack = await api('/v1/business/pack', { method: 'PATCH', body: { playbooks: { [key]: patch } } }); toast('Saved'); }
      catch (e) { toast(e.message); }
    };
    toggle.addEventListener('change', () => saveOne({ enabled: toggle.checked }));
    trust.addEventListener('change', () => saveOne({ trust: trust.value }));
    pbCard.append(h('div', { class: 'row' },
      h('span', { class: 'grow' }, h('div', { class: 'title' }, title), h('div', { class: 'sub' }, desc), h('div', {}, trust)),
      h('label', { class: 'switch' }, toggle, h('span', {}))));
  }
  const auto = h('input', { type: 'checkbox', checked: !!b.pack.playbooks.payment_request?.auto_charge, 'aria-label': 'Charge the card on file automatically' });
  auto.addEventListener('change', async () => {
    try { state.business.pack = await api('/v1/business/pack', { method: 'PATCH', body: { playbooks: { payment_request: { auto_charge: auto.checked } } } }); toast('Saved'); } catch (e) { toast(e.message); }
  });
  pbCard.append(h('div', { class: 'row' }, h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Charge the card on file'), h('div', { class: 'sub' }, 'When a customer has a saved card, charge it when the job is done instead of texting a link.')), h('label', { class: 'switch' }, auto, h('span', {}))));
  pbCard.querySelectorAll('.row').forEach((r) => { r.style.alignItems = 'flex-start'; r.querySelector('.sub').style.whiteSpace = 'normal'; const sel = r.querySelector('select'); if (sel) sel.parentElement.style.marginTop = '8px'; });

  const ai = b.settings?.ai ?? { provider: 'none' };
  const prov = h('select', { id: 'ai-provider' }, [['anthropic', 'Claude (recommended)'], ['openai_compatible', 'Other (OpenAI, Gemini, self-hosted)'], ['none', 'Off']].map(([v, l]) => h('option', { value: v, selected: ai.provider === v ? true : null }, l)));
  const model = h('input', { type: 'text', id: 'ai-model', value: ai.model ?? '', placeholder: 'Leave blank for the default' });
  const baseUrl = h('input', { type: 'url', id: 'ai-base', value: ai.base_url ?? '', placeholder: 'https://… (only for Other)' });
  const aiNotes = h('textarea', { id: 'ai-notes', value: b.settings?.ai_notes ?? '', placeholder: 'Things the AI should know: service area, policies, tone…' });
  const aiErr = h('p', { class: 'error' });
  const aiSave = h('button', { class: 'btn primary', type: 'submit' }, 'Save AI settings');
  const aiForm = h('form', { class: 'card' }, h('h2', {}, 'AI'),
    h('label', { class: 'field', for: 'ai-provider' }, 'Model provider', prov),
    h('label', { class: 'field', for: 'ai-model' }, 'Model', model),
    h('label', { class: 'field', for: 'ai-base' }, 'Address', baseUrl),
    h('label', { class: 'field', for: 'ai-notes' }, 'Notes for the AI', aiNotes), aiErr, aiSave);
  // Bring your own key: stored encrypted, shown only as its last four characters.
  const keyIn = h('input', { type: 'password', id: 'ai-key', autocomplete: 'off', placeholder: b.settings?.ai_key_last4 ? `Saved key ending ${b.settings.ai_key_last4}` : 'Optional: paste your own API key' });
  const keyErr = h('p', { class: 'error' });
  const keySave = h('button', { class: 'btn small', type: 'button' }, 'Save key');
  keySave.addEventListener('click', action(keySave, keyErr, async () => {
    if (!keyIn.value.trim()) throw new Error('Paste a key first.');
    const r = await api('/v1/business/ai-key', { method: 'PATCH', body: { api_key: keyIn.value.trim() } });
    b.settings = { ...b.settings, ai_key_last4: r.last4 }; keyIn.value = ''; keyIn.placeholder = `Saved key ending ${r.last4}`; keyDel.hidden = false; toast('Key saved');
  }));
  const keyDel = h('button', { class: 'btn small', type: 'button', hidden: !b.settings?.ai_key_last4 }, 'Remove');
  keyDel.addEventListener('click', action(keyDel, keyErr, async () => {
    await api('/v1/business/ai-key', { method: 'PATCH', body: { api_key: null } });
    b.settings = { ...b.settings, ai_key_last4: undefined }; keyIn.placeholder = 'Optional: paste your own API key'; keyDel.hidden = true; toast('Key removed');
  }));
  aiForm.insertBefore(h('label', { class: 'field', for: 'ai-key' }, h('span', {}, 'Your own API key ', h('span', { class: 'hint' }, 'optional, stored encrypted')), keyIn), aiErr);
  aiForm.insertBefore(h('div', { class: 'split' }, keySave, keyDel), aiErr);
  aiForm.insertBefore(keyErr, aiErr);
  aiForm.addEventListener('submit', action(aiSave, aiErr, async () => {
    const choice = { provider: prov.value };
    if (model.value) choice.model = model.value;
    if (baseUrl.value) choice.base_url = baseUrl.value;
    await api('/v1/business/settings', { method: 'PATCH', body: { ai: choice, ai_notes: aiNotes.value } });
    toast('Saved');
  }));

  let meCard = null;
  try {
    const me = await api('/v1/me');
    const phone = h('input', { type: 'tel', id: 'me-phone', value: me.phone ?? '', placeholder: '+15125550100' });
    const brief = h('input', { type: 'checkbox', id: 'me-brief', checked: me.notify_brief });
    const hour = h('select', { id: 'me-hour' }, Array.from({ length: 24 }, (_, i) => h('option', { value: String(i), selected: me.brief_hour === i ? true : null }, `${i % 12 || 12}:00 ${i < 12 ? 'AM' : 'PM'}`)));
    const mErr = h('p', { class: 'error' });
    const mSave = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    meCard = h('form', { class: 'card' }, h('h2', {}, 'You'),
      h('label', { class: 'field', for: 'me-phone' }, h('span', {}, 'Your mobile ', h('span', { class: 'hint' }, 'for reset codes, the morning brief and text commands')), phone),
      h('label', { class: 'check', for: 'me-brief' }, brief, h('span', {}, 'Text me a morning brief')),
      h('label', { class: 'field', for: 'me-hour' }, 'Brief time', hour),
      h('p', { class: 'small muted' }, 'You can also run things by texting your business number from this phone: "today", "drafts", "approve all", "late 15", or plain requests like "move Maria to Thursday at 10".'),
      mErr, mSave);
    meCard.addEventListener('submit', action(mSave, mErr, async () => {
      await api('/v1/me', { method: 'PATCH', body: { phone: phone.value || null, notify_brief: brief.checked, brief_hour: Number(hour.value) } }); toast('Saved');
    }));
  } catch { /* signed in with an API key */ }
  const out = h('button', { class: 'btn danger', type: 'button' }, 'Sign out');
  out.addEventListener('click', action(out, null, async () => {
    await api('/auth/logout', { method: 'POST', body: {} });
    state.user = null; state.business = null; go('/app', { replace: true });
  }));
  const more = h('div', { class: 'card flush' },
    h('a', { class: 'row', href: '/app/settings/website' }, h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Website'), h('div', { class: 'sub' }, 'Look, words, FAQ, service areas')), h('span', { class: 'meta' }, '›')),
    h('a', { class: 'row', href: '/app/settings/services' }, h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Services and prices'), h('div', { class: 'sub' }, 'What you offer and how it\u2019s priced')), h('span', { class: 'meta' }, '›')),
    h('a', { class: 'row', href: '/app/setup' }, h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Getting started'), h('div', { class: 'sub' }, 'Set up from a description, import customers')), h('span', { class: 'meta' }, '›')),
    h('a', { class: 'row', href: '/app/settings/hours' }, h('span', { class: 'grow' }, h('div', { class: 'title' }, 'Hours and booking rules'), h('div', { class: 'sub' }, 'Opening hours, time off, notice, travel time')), h('span', { class: 'meta' }, '›')));
  const dataCard = h('div', { class: 'card' }, h('h2', {}, 'Your data'),
    h('p', { class: 'small muted' }, 'Download everything anytime. It\u2019s yours.'),
    h('div', { class: 'split' },
      h('a', { class: 'btn small', href: '/v1/export', download: '' }, 'Everything (JSON)'),
      h('a', { class: 'btn small', href: '/v1/export/customers.csv', download: '' }, `${cap(vocab().customer.many)} (CSV)`)));
  return shell('Settings', [more, meCard, bizForm, h('span', { class: 'section-title' }, 'Automations'), pbCard, aiForm, dataCard,
    h('p', { class: 'small muted' }, `Signed in as ${state.user.email}`), out], { back: '/app', actions: h('span', {}) });
}

/* ---------- Website settings ---------- */
async function viewWebsite() {
  const b = state.business = await api('/v1/business');
  const site = b.settings?.site ?? {};
  const siteUrl = b.custom_domain ? `https://${b.custom_domain}` : `/site/${b.id}`;
  const err = h('p', { class: 'error', role: 'alert' });
  const f = {
    theme: h('select', { id: 'w-theme' }, [['clean', 'Clean'], ['bold', 'Bold'], ['soft', 'Soft']].map(([v, l]) => h('option', { value: v, selected: (site.theme ?? 'clean') === v ? true : null }, l))),
    accent: h('input', { type: 'color', id: 'w-accent', value: site.accent ?? '#1E6B52' }),
    headline: h('input', { type: 'text', id: 'w-headline', value: site.headline ?? '', maxlength: '90', placeholder: 'Home cleaning in Austin. Same cleaner, every visit.' }),
    subline: h('textarea', { id: 'w-subline', value: site.subline ?? '', maxlength: '220' }),
    badges: h('input', { type: 'text', id: 'w-badges', value: (site.badges ?? []).join(', '), placeholder: 'Insured, Background-checked, 5-star rated' }),
    guarantee: h('textarea', { id: 'w-guarantee', value: site.guarantee ?? '', placeholder: 'Not happy? Tell us within 24 hours and we come back free.' }),
    about: h('textarea', { id: 'w-about', value: site.about ?? '' }),
    area: h('input', { type: 'text', id: 'w-area', value: site.service_area ?? '', placeholder: 'Austin and surrounding areas' }),
    areas: h('input', { type: 'text', id: 'w-areas', value: (site.areas ?? []).join(', '), placeholder: 'South Austin, Round Rock, Cedar Park' }),
    faq: h('textarea', { id: 'w-faq', value: (site.faq ?? []).map((x) => `${x.q} | ${x.a}`).join('\n'), placeholder: 'Do you bring supplies? | Yes, everything.', rows: '5' }),
    photo: h('input', { type: 'url', id: 'w-photo', value: site.photo_url ?? '', placeholder: 'https://… (optional)' }),
    prices: h('input', { type: 'checkbox', id: 'w-prices', checked: site.show_prices ?? true }),
    live: h('input', { type: 'checkbox', id: 'w-live', checked: site.published ?? true }),
  };
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save website');
  const form = h('form', { class: 'card' },
    h('div', { class: 'split' }, h('label', { class: 'field', for: 'w-theme' }, 'Style', f.theme), h('label', { class: 'field', for: 'w-accent' }, 'Accent color', f.accent)),
    h('label', { class: 'field', for: 'w-headline' }, h('span', {}, 'Headline ', h('span', { class: 'hint' }, 'what you do, where, why you')), f.headline),
    h('label', { class: 'field', for: 'w-subline' }, 'Sentence under it', f.subline),
    h('label', { class: 'field', for: 'w-badges' }, h('span', {}, 'Trust badges ', h('span', { class: 'hint' }, 'up to 4, separated by commas')), f.badges),
    h('label', { class: 'field', for: 'w-guarantee' }, 'Your promise', f.guarantee),
    h('label', { class: 'field', for: 'w-about' }, 'About you', f.about),
    h('label', { class: 'field', for: 'w-area' }, 'Where you work', f.area),
    h('label', { class: 'field', for: 'w-areas' }, h('span', {}, 'Neighborhoods or towns ', h('span', { class: 'hint' }, 'each gets its own page for search')), f.areas),
    h('label', { class: 'field', for: 'w-faq' }, h('span', {}, 'Questions ', h('span', { class: 'hint' }, 'one per line: question | answer')), f.faq),
    h('label', { class: 'field', for: 'w-photo' }, 'Photo link', f.photo),
    h('label', { class: 'check', for: 'w-prices' }, f.prices, h('span', {}, 'Show prices')),
    h('label', { class: 'check', for: 'w-live' }, f.live, h('span', {}, 'Website is live')),
    err, save);
  form.addEventListener('submit', action(save, err, async () => {
    const faq = f.faq.value.split('\n').map((l) => l.split('|')).filter((p) => p.length >= 2 && p[0].trim()).map(([q, ...a]) => ({ q: q.trim(), a: a.join('|').trim() }));
    const body = { theme: f.theme.value, accent: f.accent.value.toUpperCase(), headline: f.headline.value || undefined, subline: f.subline.value || undefined,
      badges: list(f.badges.value).slice(0, 4), guarantee: f.guarantee.value || undefined, about: f.about.value || undefined, service_area: f.area.value || undefined,
      areas: list(f.areas.value), faq, photo_url: f.photo.value || undefined, show_prices: f.prices.checked, published: f.live.checked };
    await api('/v1/business/site', { method: 'PATCH', body });
    toast('Website saved');
  }));
  const view = h('a', { class: 'btn', href: siteUrl, target: '_blank', rel: 'noopener' }, 'View my website');
  return shell('Website', [view, form], { back: '/app/settings', actions: h('span', {}) });
}

/* ---------- Hours and booking rules ---------- */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
async function viewHours() {
  const [hours, b, off] = await Promise.all([api('/v1/hours'), api('/v1/business'), api('/v1/time-off')]);
  const rules = { ...b.pack.scheduling, ...(b.settings?.scheduling ?? {}) };
  const err = h('p', { class: 'error', role: 'alert' });
  const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const cur = hours.find((x) => x.weekday === d);
    const on = h('input', { type: 'checkbox', checked: !!cur, 'aria-label': `Open on ${DAYS[d]}` });
    const opens = h('input', { type: 'time', value: cur?.opens ?? '09:00', 'aria-label': `${DAYS[d]} opens` });
    const closes = h('input', { type: 'time', value: cur?.closes ?? '17:00', 'aria-label': `${DAYS[d]} closes` });
    const sync = () => { opens.disabled = closes.disabled = !on.checked; };
    on.addEventListener('change', sync); sync();
    return { d, on, opens, closes, el: h('div', { class: 'row hours-row' }, h('label', { class: 'switch' }, on, h('span', {})), h('span', { class: 'grow title' }, DAYS[d]), h('div', { class: 'times' }, opens, h('span', { class: 'muted' }, 'to'), closes)) };
  });
  const saveHours = h('button', { class: 'btn primary', type: 'submit' }, 'Save hours');
  const hoursForm = h('form', { class: 'card flush' }, rows.map((r) => r.el), h('div', { class: 'row' }, err, saveHours));
  hoursForm.addEventListener('submit', action(saveHours, err, async () => {
    const body = rows.filter((r) => r.on.checked).map((r) => ({ weekday: r.d, opens: r.opens.value, closes: r.closes.value }));
    await api('/v1/hours', { method: 'PUT', body }); toast('Hours saved');
  }));

  const num = (id, v, min, max) => h('input', { type: 'number', id, value: String(v), min: String(min), max: String(max), inputmode: 'numeric' });
  const r = {
    notice: num('r-notice', rules.min_notice_hours, 0, 168), cancel: num('r-cancel', rules.cancel_notice_hours ?? Math.max(24, rules.min_notice_hours), 0, 168),
    buffer: num('r-buffer', rules.buffer_min, 0, 240), cap: num('r-cap', rules.capacity, 1, 50), ahead: num('r-ahead', rules.max_days_ahead, 1, 365), step: num('r-step', rules.slot_step_min, 5, 240),
  };
  const rulesErr = h('p', { class: 'error' });
  const saveRules = h('button', { class: 'btn primary', type: 'submit' }, 'Save rules');
  const rulesForm = h('form', { class: 'card' }, h('h2', {}, 'Booking rules'),
    h('div', { class: 'split' }, h('label', { class: 'field', for: 'r-notice' }, 'Hours of notice for online booking', r.notice), h('label', { class: 'field', for: 'r-cancel' }, 'Hours of notice to change or cancel', r.cancel)),
    h('div', { class: 'split' }, h('label', { class: 'field', for: 'r-buffer' }, 'Travel time between jobs (min)', r.buffer), h('label', { class: 'field', for: 'r-cap' }, 'Jobs at the same time', r.cap)),
    h('div', { class: 'split' }, h('label', { class: 'field', for: 'r-ahead' }, 'Book up to (days ahead)', r.ahead), h('label', { class: 'field', for: 'r-step' }, 'Start times every (min)', r.step)),
    rulesErr, saveRules);
  rulesForm.addEventListener('submit', action(saveRules, rulesErr, async () => {
    await api('/v1/business/scheduling', { method: 'PATCH', body: { min_notice_hours: Number(r.notice.value), cancel_notice_hours: Number(r.cancel.value), buffer_min: Number(r.buffer.value), capacity: Number(r.cap.value), max_days_ahead: Number(r.ahead.value), slot_step_min: Number(r.step.value) } });
    toast('Rules saved');
  }));

  const offList = h('div', { class: 'card flush' });
  if (!off.length) offList.append(h('p', { class: 'empty' }, 'No time off booked.'));
  for (const t of off) {
    const del = h('button', { class: 'btn small danger', type: 'button' }, 'Remove');
    del.addEventListener('click', action(del, null, async () => { await api(`/v1/time-off/${t.id}`, { method: 'DELETE' }); render(); }));
    offList.append(h('div', { class: 'row' }, h('span', { class: 'grow' }, h('div', { class: 'title' }, `${dayOf(t.starts_at)} – ${dayOf(t.ends_at)}`), h('div', { class: 'sub' }, t.reason ?? '')), del));
  }
  const from = h('input', { type: 'date', id: 'o-from' }), to = h('input', { type: 'date', id: 'o-to' }), why = h('input', { type: 'text', id: 'o-why', placeholder: 'Vacation' });
  const offErr = h('p', { class: 'error' });
  const addOff = h('button', { class: 'btn primary', type: 'submit' }, 'Add time off');
  const offForm = h('form', { class: 'card' }, h('h2', {}, 'Time off'),
    h('div', { class: 'split' }, h('label', { class: 'field', for: 'o-from' }, 'From', from), h('label', { class: 'field', for: 'o-to' }, 'Through', to)),
    h('label', { class: 'field', for: 'o-why' }, 'Note', why), offErr, addOff);
  offForm.addEventListener('submit', action(addOff, offErr, async () => {
    if (!from.value || !to.value) throw new Error('Pick both dates.');
    const starts_at = zonedToUtc(`${from.value}T00:00`, state.tz).toISOString();
    const nextDay = new Date(Date.parse(to.value + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const ends_at = zonedToUtc(`${nextDay}T00:00`, state.tz).toISOString();
    await api('/v1/time-off', { method: 'POST', body: { starts_at, ends_at, reason: why.value || undefined } }); toast('Time off added'); render();
  }));
  return shell('Hours and rules', [h('span', { class: 'section-title' }, 'Opening hours'), hoursForm, rulesForm, offForm, offList], { back: '/app/settings', actions: h('span', {}) });
}

render();
