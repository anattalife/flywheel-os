import type { Business } from '../core/business.js';
import { esc } from './html.js';

/**
 * Plain-language starting points for a privacy policy and terms, including the SMS
 * program disclosures carriers require for business texting registration.
 * The owner should have a lawyer review and adapt these (see README).
 */
export function legalText(kind: 'privacy' | 'terms', b: Business): string {
  const name = esc(b.name);
  const contact = b.phone_number ? `text or call ${esc(b.phone_number)}` : 'contact us';
  const notice = b.pack.scheduling.min_notice_hours;
  if (kind === 'privacy') {
    return `<h1>Privacy policy</h1>
<p>This policy explains what ${name} collects when you book or contact us, and how we use it.</p>
<h2>What we collect</h2>
<p>Your name, phone number, email, service address, booking details, notes you give us, messages you send us, and payment records. Card numbers are handled by our payment processor and never stored by us.</p>
<h2>How we use it</h2>
<p>To schedule and provide our services, send confirmations and reminders, take payment, answer your questions, and improve our service. If you opt in, we also send occasional offers.</p>
<h2>Who we share it with</h2>
<p>Only service providers who help us run the business (text messaging, email, payment processing, hosting), and only for those purposes. We do not sell your information. Mobile numbers and text-message consent are never shared with third parties for their marketing.</p>
<h2>Automated help</h2>
<p>We may use an AI service to help draft replies to your messages and to summarize our records. It works for us only, under the same rules, and we review what is sent to you unless it is a routine confirmation or reminder.</p>
<h2>Photos</h2>
<p>We may take photos of our work for our records. We only show them publicly if you say that\u2019s OK.</p>
<h2>Text messages</h2>
<p>By giving us your mobile number when you book or ask for a quote, you agree to receive texts about your request and bookings. Marketing texts are sent only if you opt in. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Carriers are not liable for delayed or undelivered messages.</p>
<h2>How long we keep it</h2>
<p>As long as you are a customer, and afterwards as long as needed for records the law requires.</p>
<h2>Your choices</h2>
<p>You can ask to see, correct or delete your information at any time: ${contact}. When we delete it, we keep only the anonymous amounts and dates our bookkeeping requires.</p>`;
  }
  return `<h1>Terms of service</h1>
<p>These terms apply when you book with ${name}.</p>
<h2>Bookings and changes</h2>
<p>You can reschedule or cancel from the link in your confirmation text up to ${notice} hours before your appointment. Inside that window, please ${contact}.</p>
<h2>Prices and payment</h2>
<p>Prices shown online are estimates based on what you tell us. If the job turns out different, we will tell you before doing extra work. Payment is due when the work is done unless we agree otherwise.</p>
<h2>Text message program</h2>
<p>${name} sends texts about your bookings, and occasional offers if you opt in. Message frequency varies. Message and data rates may apply. Reply STOP to cancel, HELP for help. Carriers are not liable for delayed or undelivered messages. See our privacy policy for how we handle your information.</p>
<h2>Our responsibility</h2>
<p>We carry out the work with reasonable care. If something isn’t right, tell us within a few days and we will work to make it right.</p>
<h2>Contact</h2>
<p>Questions: ${contact}.</p>`;
}
