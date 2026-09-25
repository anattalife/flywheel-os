# Legal checklist (for review by a lawyer)

**Status: DRAFT. This is not legal advice.** It lists what the software does and where the law is likely to apply, so a lawyer licensed in your state can review it quickly. The privacy policy and terms served on the website (`/privacy` and `/terms`, text in `src/site/legal.ts`) are plain-language starting points, not reviewed documents.

## 1. Texting (TCPA, carrier rules, state "mini-TCPA" laws)

What the software does:
- **Marketing texts** (offers, win-backs, referral asks, lead follow-ups after the first reply) go only to customers with recorded consent: when it was given, and how (web form checkbox, verbal, imported).
- **Transactional texts** (confirmations, reminders, pay links, receipts, replies) go to customers who booked or who contacted the business first.
- **STOP/START/HELP** are honoured automatically, and opt-out always overrides consent.
- **Quiet hours** apply in the business's timezone (default 8pm–8am), unless the person contacted you within the last hour.
- At most 3 automated texts per customer per week by default.
- A **weekly cap** limits automated texts per customer, and the first marketing text carries an opt-out line.
- The website form includes a consent checkbox with disclosure text.

Questions for the lawyer:
- [ ] Does the consent checkbox wording meet the "prior express written consent" standard for marketing texts? (FCC rules on one-to-one consent and revocation "by any reasonable means" apply.)
- [ ] Is the default quiet-hours window right for your state? Some states set stricter hours or limit texts per day (e.g. Florida, Oklahoma, Maryland).
- [ ] Are AI-drafted replies and "missed-call text-back" transactional, given they answer the customer's own contact?
- [ ] Can imported past customers be sent any texts without new consent? (The app sends them transactional texts only after they book.)
- [ ] Do texts need to be kept for a set time, and for how long?

## 2. Email (CAN-SPAM)

- Every email ends with the business name and the mailing address from Settings; promotional emails also carry a one-click unsubscribe link (and the List-Unsubscribe header).
- [ ] Fill in Settings → Business → Mailing address before sending any promotional email.
- [ ] Confirm transactional-only emails (receipts, confirmations) are correctly classified.

## 3. Privacy

What the software stores: names, phone numbers, emails, service addresses and access notes, booking history, messages, payment records (card brand and last 4 digits only; card numbers stay with Stripe), job photos, and reasons given for cancelling.

Where data goes: Twilio (texts and calls), Stripe (payments), Amazon (hosting, email, photo storage), the chosen AI provider (message text to draft replies, when AI is on), and Google (review replies and posts, when connected).

What customers can do: the owner can export all data, and delete one customer's information on request. Their identity is removed and anonymous amounts and dates are kept for bookkeeping.

- [ ] Review the privacy policy text for your state. California (CCPA/CPRA), Colorado, Virginia, Texas and others have laws, most with revenue or volume thresholds a small business may not meet.
- [ ] Is a data processing agreement needed with the AI provider? Check the provider's terms on training on API data (Anthropic and OpenAI say by default they do not train on API data).
- [ ] How long should records be kept after a customer leaves? (Taxes: generally at least as long as the IRS requires. Set a policy.)
- [ ] Does sending customer message text to an AI provider need a specific disclosure? The draft privacy policy has one ("Automated help").
- [ ] Photos: is the "OK to share publicly" checkbox enough consent for marketing use?

## 4. Payments

- Card data never touches the server (Stripe Checkout and saved payment methods).
- Saving a card and charging it when the job is done ("card on file") uses Stripe's off-session charges.
- [ ] Is the card-on-file authorization wording on the Stripe-hosted page, together with your terms, enough for your cancellation and no-show fees?
- [ ] Refund and dispute policy in the terms.

## 5. Reviews and referrals

- Every customer with marketing consent gets the same review request with the public review link after a completed job, at most once in 90 days. There is **no filtering by how happy they seemed** (no "review gating"). Only reviews of 4 stars or more that include text are shown on the website; the average includes all public reviews.
- Separately, a first-visit check-in asks for a private 1–5 rating by text. A low rating prompts the owner to reach out personally; it does not change who gets the review request.
- [ ] Confirm this complies with the FTC rule on consumer reviews (2024, which bans review suppression and incentives that depend on sentiment) and with Google's review policies.
- [ ] Is showing only 4- and 5-star reviews on your own site, with the true average and count, acceptable?
- [ ] Referral credits: disclosure wording when customers share their link (FTC endorsement guides).

## 6. If you let other businesses use it (ALLOW_SIGNUP=true)

This makes you a software provider to other businesses. Before that:
- [ ] Platform terms of service between you and each business, covering who is responsible for consent, content and payments.
- [ ] A data processing agreement: you process their customers' data on their behalf.
- [ ] Twilio: each business needs its own A2P 10DLC brand and campaign (ISV registration), not yours.
- [ ] Stripe Connect instead of one Stripe account, so money goes to each business directly.
- [ ] Insurance (cyber and E&O).

## 7. AI assistant visibility check

- The monthly check asks an AI with web search whether it recommends the business. It's a normal API use of your own account; no scraping.
