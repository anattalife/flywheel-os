import { config } from '../../config.js';
import { DevMessagingAdapter } from './dev.js';
import { TwilioAdapter } from './twilio.js';
import type { MessagingAdapter } from './types.js';

let adapter: MessagingAdapter | undefined;

export function messaging(): MessagingAdapter {
  if (!adapter) {
    const c = config();
    if (c.MESSAGING_PROVIDER === 'twilio') {
      if (!c.TWILIO_ACCOUNT_SID || !c.TWILIO_AUTH_TOKEN) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
      adapter = new TwilioAdapter(c.TWILIO_ACCOUNT_SID, c.TWILIO_AUTH_TOKEN, c.TWILIO_MESSAGING_SERVICE_SID);
    } else adapter = new DevMessagingAdapter();
  }
  return adapter;
}

export function setMessagingAdapter(a: MessagingAdapter) { adapter = a; }
