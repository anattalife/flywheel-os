# Live trial checklist

Everything in the app has been tested with stand-ins for Twilio, Stripe, Google, email and AI. This checklist connects the real services and walks through a first live test with your own phone before any customer is involved.

Allow about two weeks overall: most of the waiting is for texting registration (A2P 10DLC) and Google's API approval, which can run at the same time.

Fees and approval steps change. Figures below were checked in September 2026; confirm them on each provider's own pricing page.

---

## 1. Server (day 1)

- [ ] Lightsail instance, managed database, static IP and DNS set up as in the README.
- [ ] `.env` filled in, with `ADMIN_TOKEN`, `APP_SECRET` and `MONITOR_TOKEN` each from `openssl rand -hex 32`. **Store `APP_SECRET` in your password manager**: changing or losing it breaks old links and stored keys.
- [ ] `docker compose run --rm migrate` then `docker compose up -d --build`.
- [ ] `https://app.yourdomain.com/health` shows `{"ok":true}` with a valid padlock.
- [ ] Create your business and owner login with the `curl` command from the README (use your real mobile as the owner phone), then sign in at `/app`.
- [ ] Settings → Hours, Services and prices, Website: fill these in (or use Getting started).

## 2. Texting: Twilio (start day 1; registration takes days to weeks)

US carriers block business texts from numbers that aren't registered for **A2P 10DLC**.

- [ ] Create a Twilio account and upgrade it from trial.
- [ ] Buy a local number, or port your existing business number (porting takes 1–4 weeks; you can start on a new number and port later).
- [ ] **Register A2P 10DLC** in Twilio's Trust Hub:
  - **Brand:** *Standard* if your business has an EIN, which gives better throughput. *Sole Proprietor* is for businesses without one (limited to one number and low volume).
  - **Campaign use case:** "Mixed" or "Customer care", covering booking confirmations, reminders, replies to inquiries and occasional offers to opted-in customers.
  - **Opt-in description:** "Customers give their mobile number and check a consent box when booking or requesting a quote on our website, or give verbal consent in person, recorded in our system."
  - **Sample messages:** copy two or three from Settings → Automations, such as the booking confirmation and a review request.
  - **Privacy policy URL:** `https://yourdomain.com/privacy`. **Terms URL:** `https://yourdomain.com/terms`. Both pages already exist on your site and include the disclosures carriers look for.
  - **Fees:** expect a small one-time brand and campaign vetting fee (tens of dollars) and a monthly campaign fee of a few dollars, plus per-message carrier surcharges.
- [ ] Create a **Messaging Service**, add your number, and attach the approved campaign. Put its SID in `TWILIO_MESSAGING_SERVICE_SID`.
- [ ] On the phone number in Twilio, set:
  - A message comes in → `https://app.yourdomain.com/webhooks/twilio/sms` (POST)
  - A call comes in → `https://app.yourdomain.com/webhooks/twilio/voice/incoming` (POST)
- [ ] In `.env`: `MESSAGING_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`. Put your business number on your business with the admin API, and your cell as the call-forwarding number (Settings, or `PATCH /v1/business/settings {"forward_to":"+1..."}`).
- [ ] Restart: `docker compose up -d`.

**Test with your own phone (a second phone helps):**
- [ ] From another phone, call the business number and don't answer → your cell rings, and a "sorry we missed you" text arrives.
- [ ] Reply to it → the reply appears in the Inbox.
- [ ] From another phone, text "STOP" → it's confirmed, and no more automated texts go out. Text "START" to undo.
- [ ] From your owner phone, text "today" to the business number → you get your day.

## 3. Payments: Stripe (day 1; test mode first)

- [ ] Create a Stripe account. Stay in **test mode** for the first run.
- [ ] Developers → API keys: put the secret key in `STRIPE_SECRET_KEY`, and set `PAYMENTS_PROVIDER=stripe`.
- [ ] Developers → Webhooks → add the endpoint `https://app.yourdomain.com/webhooks/stripe` with the events `checkout.session.completed`, `payment_intent.succeeded` and `payment_intent.payment_failed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
- [ ] Restart.

**Test:**
- [ ] Book yourself as a customer and complete the job → a pay link arrives by text. Pay with test card `4242 4242 4242 4242` → the invoice shows as paid and a receipt arrives.
- [ ] Save a card from the portal, complete another job with "Charge the card on file" on → it's charged automatically.
- [ ] Use test card `4000 0000 0000 0341` (attaches, then declines) → failed-payment recovery texts start.
- [ ] Refund from the Money screen → it shows in Stripe.
- [ ] Then switch to **live** keys and a live webhook (it has a different signing secret), and run one real $1 charge and refund on your own card.

## 4. Email: Amazon SES (day 1; production access takes about a day)

- [ ] In SES (same AWS account as Lightsail is fine), verify your **domain** with the DNS records it gives you (DKIM). Use a sending address on it for `EMAIL_FROM`.
- [ ] **Request production access.** New SES accounts start in a sandbox that can only send to verified addresses. Describe it as transactional booking and receipt email with an unsubscribe link on anything promotional.
- [ ] Create an IAM user with only `ses:SendEmail` permission, and put its keys in `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY`. Set `EMAIL_PROVIDER=ses`.
- [ ] **Test:** book with a customer who has an email but no mobile → the confirmation arrives by email and doesn't land in spam. Click the unsubscribe link → it's recorded.

## 5. Photos (day 1)

- [ ] Simplest: keep `STORAGE_PROVIDER=local` (a Docker volume on the instance; `scripts/backup.sh` backs it up).
- [ ] Or use a Lightsail bucket: `STORAGE_PROVIDER=s3`, with `S3_BUCKET`, `S3_REGION` and the bucket's access keys.
- [ ] **Test:** upload a job photo from a booking and open it from the Grow screen.

## 6. Google Business Profile (apply day 1; approval can take a few weeks)

Reviews and posts work without Google's API: you can add reviews by hand and post yourself. The API makes it automatic.

- [ ] Your profile must be **verified and active for 60+ days**, list your website, and you must apply using an email that is an owner or manager on the profile.
- [ ] In Google Cloud console: create a project, set up the OAuth consent screen (external, your app's name), and create an OAuth client (Web). Its redirect URI is `https://app.yourdomain.com/oauth/google/callback`.
- [ ] Apply for **Business Profile API access** through Google's GBP API contact form, with your project number. Approval shows as a quota of 300 QPM, instead of 0, on the Business Profile APIs in the console. Then enable the *My Business Account Management*, *My Business Business Information* and *Google My Business* APIs.
- [ ] Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, restart, then Grow → Connect Google while signed in as the owner.
- [ ] **Test:** sync reviews, approve a drafted reply and see it on Google, and publish one photo post.

## 7. AI (optional; day 1)

- [ ] Get an Anthropic API key (console.anthropic.com) and set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Or leave AI off: every automation has a template fallback.
- [ ] Set a monthly spend limit in the provider's console.
- [ ] **Test:** text the business number a question → a drafted reply appears in the Inbox for approval. Keep the Inbox playbook on "draft for my OK" for at least the first few weeks.

## 8. Monitoring (day 1)

- [ ] Set `ALERT_PHONE` (your cell), `ALERT_FROM_PHONE` (the business number) and/or `ALERT_EMAIL`.
- [ ] Add a free uptime monitor (UptimeRobot, Better Stack or similar) for `https://app.yourdomain.com/health/deep?token=YOUR_MONITOR_TOKEN`, checking every 5 minutes.
- [ ] **Test:** `docker compose stop worker` → within about 10 minutes you get an alert and the monitor goes red. Then `docker compose start worker`.
- [ ] Add `scripts/backup.sh` to cron, run it once by hand, and **restore it once into a scratch database** to prove the backup works.

## 9. Two weeks with yourself as the only "customer"

- [ ] Keep every automation on **draft for my OK**. Book, reschedule, cancel and pay as a customer from a second phone.
- [ ] Watch each morning brief. Check that nothing is sent during quiet hours, and nothing more than the weekly cap.
- [ ] Only then import real customers (Getting started → Import) and switch individual automations to "send on its own" as the app suggests them.

## Things only you can decide

- Whether to port your existing business number or use a new one.
- Your cancellation, payment and deposit policies (edit them in the terms and the pack).
- Whether to text past customers who never gave text consent. The app won't send them marketing; ask a lawyer (see LEGAL-CHECKLIST.md).
