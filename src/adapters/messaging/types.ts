export interface OutboundSms { from: string; to: string; body: string; statusCallback?: string; mediaUrls?: string[] }
export interface SendResult { providerId: string; status: string }

/** Every texting provider sits behind this interface, so switching is a config change. */
export interface MessagingAdapter {
  readonly name: string;
  sendSms(msg: OutboundSms): Promise<SendResult>;
}
