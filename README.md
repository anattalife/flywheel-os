# Flywheel OS

A command center for a service business. It remembers every customer, answers and follows up automatically, books and gets paid, brings people back, asks for reviews and referrals, and each morning tells the owner the one thing that matters.

It is **trade-neutral**: nothing about any one trade is built into the code. Words ("client", "visit"), services and pricing, how often people rebook, every message template, the timing of every follow-up and the key metric all come from an **industry pack**, which is data you can edit.

## What it does

| Flywheel stage | What's built |
| --- | --- |
| **Get found** | A fast, mobile-first website in 3 themes, with service-area pages, structured data for search engines, a sitemap, and customers' own domains with automatic HTTPS. Google Business Profile: reviews synced in, AI-drafted replies, weekly photo posts. A monthly check of whether AI assistants recommend you. |
| **Convert** | Instant price quotes and online booking against real availability. Missed-call text-back. An instant reply to every lead, then follow-ups on day 1, 3 and 7 that stop when they reply or book. |
| **Deliver** | Scheduling with hours, time off, travel buffers and recurring series. Confirmations and reminders. A customer portal to reschedule, cancel or skip. Job photos. |
| **Get paid** | Invoices, text-to-pay links, cards saved on file and charged when the job is done, receipts, refunds and failed-payment recovery (Stripe). Credits applied automatically. |
| **Keep** | A health score per customer, check-ins after the first visit, at-risk and win-back messages, and reasons recorded when people cancel or say no. |
| **Grow** | Review requests at the right moment, with unhappy customers routed to private feedback. Referral codes, share links and credits. |
| **Learn** | A scorecard of the whole flywheel against last period, the weakest stage with its cost per month, a capacity forecast, a monthly "why people leave" summary, and a morning text to the owner. |
| **Run it by text** | The owner texts the business number: "today", "drafts", "approve all", "late 15", or plain requests like "move Maria to Thursday at 10". Anything that changes a booking asks for YES first. |

**Trust levels:** every automation is set to *suggest*, *draft for my OK*, or *send on its own*. When the owner approves a playbook's drafts unchanged ten times in a row, the app suggests letting it send on its own.

**AI is optional and the owner picks it:** Claude (default), any OpenAI-compatible service (OpenAI, Gemini, or a free self-hosted model), or off; templates are used when it's off. A business can bring its own API key (stored encrypted).

**Guardrails on every text:** STOP/START, marketing only with recorded consent, quiet hours in the business's timezone, a weekly cap on automated texts, and an opt-out line on marketing.

## The owner app

A phone-first app at `/app`: Today, Inbox with one-tap approvals, Customers, Scorecard, Money, Grow, and Settings (website, services and prices, hours, automations, AI, your data). Getting started can take a sentence about the business and set up services, words, hours and website from it, and import customers from a spreadsheet.

## Run it locally

Requirements: Node 22+ and Docker (for Postgres).

```bash
npm install
docker compose --profile local up -d db
cp .env.example .env
```

For local use, set these in `.env` (dev providers print texts and emails instead of sending them):

```
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:3000
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/flywheel
DATABASE_URL=postgres://flywheel_app:dev@localhost:5432/flywheel
APP_DB_PASSWORD=dev
MESSAGING_PROVIDER=dev
PAYMENTS_PROVIDER=dev
EMAIL_PROVIDER=dev
STORAGE_PROVIDER=local
STORAGE_DIR=./data/uploads
AI_PROVIDER=none
```

```bash
npm run migrate
npm run dev:api        # terminal 1
npm run dev:worker     # terminal 2
```

Create your business and owner login (the admin token is in `.env`; in development the default is `dev-admin-token-change-me`):

```bash
curl -s -X POST localhost:3000/admin/businesses \
  -H "authorization: Bearer dev-admin-token-change-me" -H 'content-type: application/json' \
  -d '{"name":"My Service Co","phone_number":"+15125550100","timezone":"America/Chicago",
       "owner":{"email":"me@example.com","password":"a long password","phone":"+15125550199"}}'
```

Then open http://localhost:3000/app and sign in. Your website is at `/site/<business id>`.

### Tests

```bash
npm test
```

The suite (92 tests) creates a fresh `flywheel_test` database, so it needs a Postgres superuser at `TEST_ADMIN_DATABASE_URL` (default `postgres://postgres@localhost:5432/postgres`; with the Compose database use `postgres://postgres:postgres@localhost:5432/postgres`). CI runs the same on every push (`.github/workflows/ci.yml`).

## Deploy on Lightsail (one command)

Everything runs on one Lightsail server (2 GB or larger): the app, its database, HTTPS and nightly backups.

1. Point your domain at the server's static IP: an **A record** for `@` and one for `www`.
2. In Lightsail → your instance → **Networking**, make sure the firewall allows **HTTPS (443)**.
3. In the Lightsail terminal (**Connect using SSH**):
   ```
   git clone https://github.com/YOUR_USERNAME/flywheel-os.git
   sudo bash flywheel-os/deploy/install.sh
   ```
   It asks for your domain, business name, email, a password and your mobile, then does the rest.
   Your website is at `https://yourdomain.com` and your app at `https://yourdomain.com/app`.

**Update** after new code is on GitHub: `sudo bash flywheel-os/deploy/update.sh`

Texting, payments, email and AI start switched off; turn each on with [docs/LIVE-TRIAL.md](docs/LIVE-TRIAL.md) (add its keys to `flywheel-os/.env`, then run the update command). Backups go to `/var/backups/flywheel` every night.

## Operating it

- **Monitoring:** point any uptime monitor at `https://app.yourdomain.com/health/deep?token=MONITOR_TOKEN`. It returns 503 with the problem when the worker has stopped or the queue is backed up.
- **Alerts:** set `ALERT_PHONE` and/or `ALERT_EMAIL`. You'll hear about server errors, a stalled worker and jobs that keep failing, at most once every 30 minutes per kind of problem.
- **Logs:** one JSON line per event: `docker compose logs -f api worker`.
- **Data:** owners can download everything (Settings → Your data) and delete a customer's information on request. `DELETE /admin/businesses/:id?confirm=:id` removes a whole business.

## Layout

```
src/
  api/          HTTP server, routes, sessions, webhooks
  core/         customers, bookings, scheduling, billing, retention, referrals, discovery,
                intelligence, messaging pipeline, events, jobs, privacy, ops
  packs/        pack schema, the general-service pack, pricing
  playbooks/    one file per automation
  guardrails/   the rules every outbound message passes
  adapters/     Twilio, Stripe, Anthropic / OpenAI-compatible, SES, S3, Google (each with a dev stand-in)
  site/         the public website (server-rendered)
  web/owner/    the owner app (no framework, no build step)
  worker/       job runner and daily maintenance
  db/           migrations and runner
tests/          node:test suites against a real Postgres
docs/           live-trial checklist, legal checklist, security notes
```

## Before real customers

- [docs/LIVE-TRIAL.md](docs/LIVE-TRIAL.md): accounts, registrations and a step-by-step first live test.
- [docs/LEGAL-CHECKLIST.md](docs/LEGAL-CHECKLIST.md): what a lawyer should review. The privacy policy and terms on the website are **drafts**.
- [docs/SECURITY.md](docs/SECURITY.md): how data is protected, and the known limits.
