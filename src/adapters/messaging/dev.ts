import { randomUUID } from 'node:crypto';
import type { MessagingAdapter, OutboundSms, SendResult } from './types.js';

/** Development adapter: records messages instead of sending them. */
export class DevMessagingAdapter implements MessagingAdapter {
  readonly name = 'dev';
  readonly outbox: OutboundSms[] = [];
  async sendSms(msg: OutboundSms): Promise<SendResult> {
    this.outbox.push(msg);
    if (process.env.NODE_ENV !== 'test') console.log(`[sms → ${msg.to}] ${msg.body}`);
    return { providerId: `dev_${randomUUID()}`, status: 'sent' };
  }
}
