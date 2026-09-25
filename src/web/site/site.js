// Progressive enhancement for the booking form: show the chosen service's inputs
// and a live price. The page works without this script.
(function () {
  const form = document.querySelector('form[data-quote]');
  if (!form) return;
  const priceEl = form.querySelector('[data-price]');
  const linesEl = form.querySelector('[data-lines]');
  const money = (c) => c == null ? '—' : '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
  let timer;

  function syncInputs() {
    const chosen = form.querySelector('input[name="service"]:checked');
    form.querySelectorAll('.svc-inputs').forEach((box) => {
      const on = chosen && box.dataset.for === chosen.value;
      box.hidden = !on;
      box.querySelectorAll('input, select').forEach((el) => { el.disabled = !on; });
    });
  }

  async function requote() {
    const data = new URLSearchParams(new FormData(form));
    try {
      const res = await fetch(form.dataset.quote, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: data });
      const q = await res.json();
      if (!res.ok) throw new Error(q.error || 'Could not price that');
      if (q.needs_owner_quote) { priceEl.textContent = 'Free quote'; linesEl.textContent = 'We will confirm the price with you.'; return; }
      priceEl.textContent = money(q.amount_cents);
      linesEl.textContent = q.lines.length > 1 ? q.lines.map((l) => l.label + ' ' + money(l.cents)).join(' · ') : '';
    } catch (e) { linesEl.textContent = e.message; }
  }

  form.addEventListener('change', () => { syncInputs(); clearTimeout(timer); timer = setTimeout(requote, 150); });
  form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(requote, 250); });
  syncInputs();
  requote();
})();
