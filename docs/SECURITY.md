# Security notes

## How data is protected

- **Tenant isolation in the database.** Every business-owned table has Postgres row-level security keyed on the current business. The app connects as `flywheel_app`, which can't bypass it. Cross-business lookups (such as which business owns this phone number) go through narrow `SECURITY DEFINER` functions that return only an ID, and only after a signature, token or key check.
- **Sessions:** HttpOnly, SameSite=Lax cookies, stored hashed. State-changing requests from a cookie session must carry a custom header, which cross-site forms can't send. Sign-in endpoints accept JSON only.
- **Passwords:** hashed with scrypt; sign-in attempts are rate limited. Reset codes are 6 digits, expire in 15 minutes, and are limited in the database: 3 per hour, 5 guesses per code, and 10 wrong guesses per day.
- **Secrets at rest:** Google tokens and businesses' own AI keys are encrypted with AES-256-GCM, using a key derived from `APP_SECRET`. They are never returned by the API or included in exports.
- **Signed links:** pay, receipt, media and unsubscribe links carry an HMAC tied to the link type. The Google sign-in state is signed, expires, and only completes for the same signed-in owner who started it.
- **Webhooks:** Twilio and Stripe signatures are verified. In production, Twilio webhooks are refused unless Twilio is configured. Stripe events are de-duplicated.
- **Outbound requests:** an AI address a business types in must be public HTTPS (private, loopback and metadata addresses are refused) and never receives the platform's key.
- **Public forms:** US numbers only, no links in names, honeypot plus rate limits. A form can never overwrite an existing customer's contact details. A sudden flood of form leads is held for the owner instead of texted automatically.
- **Browser:** a strict Content-Security-Policy with no inline script. The owner app builds all content as text nodes, and the website escapes all data by default.
- **Exports:** CSV cells that spreadsheets would treat as formulas are neutralised.

## Independent review

A separate reviewer went through the whole codebase in September 2026 and found no break in tenant isolation. All the high, medium and low findings below were fixed and have regression tests in `tests/security.test.ts` (plus `tests/discovery.test.ts` for the Google sign-in):

- **High:** a business-set AI address could receive the platform key and reach internal addresses.
- **High:** the Google sign-in link could attach another owner's Google account.
- **Medium:** a public booking could attach a new phone number to an existing customer who had only an email.
- **Medium:** the lead form could send texts to any number, including international ones.
- **Medium:** unsigned Twilio webhooks were accepted if Twilio wasn't configured.
- **Low:** reset codes were limited only in memory.
- **Low:** the CSV export was open to formula injection.
- **Low:** an invoice could reference another business's booking ID.
- **Minor:** sign-in accepted cross-site form posts.

## Known limits (acceptable for a single-business trial, revisit before opening sign-ups)

- **In-memory rate limits.** Per-IP limits on public forms and sign-in live in the process. With one API process behind Caddy this is fine; with several, move them to the database or Redis.
- **Owner text commands trust caller ID.** Twilio delivers the real sender number, and spoofing through carriers is uncommon, but anything that changes a booking or texts a customer asks for YES first. Consider a PIN before giving staff phones this power.
- **Queue and ops tables have no row-level security.** `jobs`, `stripe_events`, `heartbeats` and `alerts_sent` are only written with server-generated keys; this is defence in depth only.
- **Signed links don't expire.** Pay, receipt and photo links are long-lived by design (customers reopen old receipts). Each exposes only that one item.
- **DNS rebinding** could in theory get past the check on a business-set AI address between lookup and request. Only owners can set it, and redirects are refused.

## Reporting

If you find a problem, email the operator (`ALERT_EMAIL`) rather than opening a public issue.
