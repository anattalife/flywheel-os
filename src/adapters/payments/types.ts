export interface CheckoutRequest {
  mode: 'payment' | 'setup';
  customer: string;                 // provider customer id
  amountCents?: number;             // payment mode
  description?: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey?: string;
}
export interface ChargeResult { status: 'succeeded' | 'failed' | 'requires_action'; providerId: string; failureReason?: string }

/** Every payment provider sits behind this interface. Card numbers only ever go to the provider's hosted pages. */
export interface PaymentsAdapter {
  readonly name: string;
  ensureCustomer(c: { existing?: string | null; name?: string | null; email?: string | null; phone?: string | null; metadata: Record<string, string> }): Promise<string>;
  createCheckout(req: CheckoutRequest): Promise<{ url: string; providerId: string }>;
  chargeSaved(req: { customer: string; paymentMethod: string; amountCents: number; description: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<ChargeResult>;
  cardFromSetup(setupIntentId: string): Promise<{ paymentMethod: string; brand: string | null; last4: string | null }>;
  refund(req: { paymentIntent: string; amountCents?: number; idempotencyKey: string }): Promise<{ providerId: string; status: string }>;
}
