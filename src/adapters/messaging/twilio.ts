import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/secrets.js';
import type { MessagingAdapter, OutboundSms, SendResult } from './types.js';

export class TwilioAdapter implements MessagingAdapter {
  readonly name = 'twilio';
  constructor(private accountSid: string, private authToken: string, private messagingServiceSid?: string) {}

  async sendSms(msg: OutboundSms): Promise<SendResult> {
    const form = new URLSearchParams({ To: msg.to, Body: msg.body });
    // A Messaging Service handles A2P 10DLC compliance and number pools; fall back to a plain From.
    if (this.messagingServiceSid) form.set('MessagingServiceSid', this.messagingServiceSid);
    else form.set('From', msg.from);
    if (msg.statusCallback) form.set('StatusCallback', msg.statusCallback);
    for (const url of (msg.mediaUrls ?? []).slice(0, 10)) form.append('MediaUrl', url);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const body = (await res.json()) as { sid?: string; status?: string; message?: string; code?: number };
    if (!res.ok) throw new Error(`twilio ${res.status}: ${body.message ?? 'send failed'} (code ${body.code ?? '?'})`);
    return { providerId: body.sid!, status: body.status ?? 'queued' };
  }
}

/**
 * Verify X-Twilio-Signature: base64(HMAC-SHA1(authToken, fullUrl + sorted(key+value)...)).
 * `url` must be the exact public URL Twilio called, including any query string.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  return safeEqual(twilioSignature(authToken, url, params), signature);
}
