/** Minimal HTML templating with escaping by default. */
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export class Raw { constructor(public html: string) {} toString() { return this.html; } }
export const raw = (html: string) => new Raw(html);

/** Tagged template: interpolations are escaped unless wrapped in raw() or arrays of Raw. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return new Raw(out);
}
function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.html;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export const money = (c: number | null | undefined) => c == null ? '' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export const SITE_CSP = "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function page(opts: { title: string; description?: string; body: Raw; themeHref: string; canonical?: string; jsonLd?: unknown[]; script?: boolean; noindex?: boolean }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(opts.title)}</title>
${opts.description ? `<meta name="description" content="${esc(opts.description)}">` : ''}
${opts.canonical ? `<link rel="canonical" href="${esc(opts.canonical)}">` : ''}
${opts.noindex ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:title" content="${esc(opts.title)}">
${opts.description ? `<meta property="og:description" content="${esc(opts.description)}">` : ''}
<link rel="stylesheet" href="/assets/site/site.css">
<link rel="stylesheet" href="${esc(opts.themeHref)}">
${(opts.jsonLd ?? []).map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n')}
</head>
<body>
${opts.body.html}
${opts.script ? '<script src="/assets/site/site.js" defer></script>' : ''}
</body>
</html>`;
}
