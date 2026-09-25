import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { signS3 } from '../storage/s3.js';

export interface OutboundEmail { from: string; fromName?: string; to: string; subject: string; text: string; html?: string; replyTo?: string; listUnsubscribe?: string }
export interface EmailAdapter { readonly name: string; send(m: OutboundEmail): Promise<{ providerId: string }> }

/** Amazon SES (v2 API), signed with AWS Signature Version 4. */
export class SesEmail implements EmailAdapter {
  readonly name = 'ses';
  constructor(private region: string, private accessKeyId: string, private secretAccessKey: string) {}
  async send(m: OutboundEmail) {
    const host = `email.${this.region}.amazonaws.com`;
    const path = '/v2/email/outbound-emails';
    const headers: { Name: string; Value: string }[] = m.listUnsubscribe ? [{ Name: 'List-Unsubscribe', Value: `<${m.listUnsubscribe}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }] : [];
    const payload = JSON.stringify({
      FromEmailAddress: m.fromName ? `"${m.fromName.replace(/"/g, '')}" <${m.from}>` : m.from,
      Destination: { ToAddresses: [m.to] },
      ReplyToAddresses: m.replyTo ? [m.replyTo] : undefined,
      Content: { Simple: { Subject: { Data: m.subject }, Body: { Text: { Data: m.text }, ...(m.html ? { Html: { Data: m.html } } : {}) }, Headers: headers.length ? headers : undefined } },
    });
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const s = signS3({ method: 'POST', host, path, headers: { 'content-type': 'application/json' }, payloadHash: createHash('sha256').update(payload).digest('hex'), amzDate, region: this.region, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, service: 'ses' });
    const { host: _h, ...rest } = s.headers;
    const res = await fetch(`https://${host}${path}`, { method: 'POST', headers: { ...rest, authorization: s.authorization }, body: payload });
    const body = (await res.json().catch(() => ({}))) as { MessageId?: string; message?: string };
    if (!res.ok) throw new Error(`ses ${res.status}: ${body.message ?? 'send failed'}`);
    return { providerId: body.MessageId ?? '' };
  }
}

export class DevEmail implements EmailAdapter {
  readonly name = 'dev';
  readonly outbox: OutboundEmail[] = [];
  async send(m: OutboundEmail) {
    this.outbox.push(m);
    if (process.env.NODE_ENV !== 'test') console.log(`[email → ${m.to}] ${m.subject}`);
    return { providerId: `email_dev_${this.outbox.length}` };
  }
}

let adapter: EmailAdapter | undefined;
export function email(): EmailAdapter {
  if (!adapter) {
    const c = config();
    if (c.EMAIL_PROVIDER === 'ses') {
      if (!c.SES_ACCESS_KEY_ID || !c.SES_SECRET_ACCESS_KEY) throw new Error('SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY are required');
      adapter = new SesEmail(c.SES_REGION, c.SES_ACCESS_KEY_ID, c.SES_SECRET_ACCESS_KEY);
    } else adapter = new DevEmail();
  }
  return adapter;
}
export function setEmailAdapter(a: EmailAdapter) { adapter = a; }
