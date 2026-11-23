/**
 * Payment providers (card 19.2). Each adapter starts a hosted checkout and can tell, from the
 * provider itself, whether a payment was really made: the browser redirect and the webhook are only
 * hints, and nothing is credited without the provider's own confirmation.
 *
 * - Zarinpal (v4 REST): charges rials; `verify` is the confirmation and is idempotent on their side
 *   (code 101 = already verified).
 * - Stripe (Checkout): charges cents; the signed webhook carries the session, and `lookup` reads
 *   the session back for reconciliation.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type PaymentProviderName = 'zarinpal' | 'stripe';

export interface CheckoutRequest {
  paymentId: string;
  /** Integer minor units of the provider's currency. */
  amountMinor: bigint;
  description: string;
  /** Where the provider sends the browser back. */
  callbackUrl: string;
  cancelUrl: string;
  email?: string | undefined;
}

export interface Checkout {
  providerRef: string;
  redirectUrl: string;
}

/** The provider's answer about one payment. */
export type PaymentState =
  | { state: 'paid'; providerTxId: string }
  | { state: 'pending' }
  | { state: 'failed' | 'expired'; reason: string };

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** ISO 4217 code of what the provider charges. */
  readonly currency: string;
  /** Minor units per major unit (rial: 1, cent: 100). */
  readonly minorPerMajor: number;
  createCheckout(request: CheckoutRequest): Promise<Checkout>;
  /** Asks the provider whether the payment was made (Zarinpal verify, Stripe session lookup). */
  confirm(payment: { providerRef: string; amountMinor: bigint }): Promise<PaymentState>;
}

export class PaymentProviderError extends Error {
  constructor(
    readonly provider: PaymentProviderName,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'PaymentProviderError';
  }
}

const TIMEOUT_MS = 15_000;

async function call(
  provider: PaymentProviderName,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new PaymentProviderError(
      provider,
      `unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    throw new PaymentProviderError(provider, `non-JSON answer (HTTP ${String(response.status)})`);
  }
}

// ───────────── Zarinpal ─────────────

interface ZarinpalAnswer {
  data?: { code?: number; authority?: string; ref_id?: number | string; message?: string } | [];
  errors?: { code?: number; message?: string } | [];
}

export class ZarinpalProvider implements PaymentProvider {
  readonly name = 'zarinpal' as const;
  readonly currency = 'IRR';
  readonly minorPerMajor = 1;

  constructor(
    private readonly options: {
      merchantId: string;
      /** e.g. https://payment.zarinpal.com or https://sandbox.zarinpal.com */
      baseUrl: string;
    },
  ) {}

  #post(path: string, body: Record<string, unknown>) {
    return call(this.name, `${this.options.baseUrl}/pg/v4/payment/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ merchant_id: this.options.merchantId, ...body }),
    }) as Promise<{ status: number; body: ZarinpalAnswer }>;
  }

  async createCheckout(request: CheckoutRequest): Promise<Checkout> {
    const { body } = await this.#post('request.json', {
      amount: Number(request.amountMinor),
      currency: 'IRR',
      description: request.description,
      callback_url: request.callbackUrl,
      metadata: { order_id: request.paymentId, ...(request.email ? { email: request.email } : {}) },
    });
    const data = Array.isArray(body.data) ? undefined : body.data;
    if (data?.code !== 100 || !data.authority)
      throw new PaymentProviderError(this.name, `request refused (${errorText(body)})`);
    return {
      providerRef: data.authority,
      redirectUrl: `${this.options.baseUrl}/pg/StartPay/${data.authority}`,
    };
  }

  async confirm(payment: { providerRef: string; amountMinor: bigint }): Promise<PaymentState> {
    const { body } = await this.#post('verify.json', {
      amount: Number(payment.amountMinor),
      authority: payment.providerRef,
    });
    const data = Array.isArray(body.data) ? undefined : body.data;
    // 100 = verified now, 101 = verified before: both mean the money arrived.
    if ((data?.code === 100 || data?.code === 101) && data.ref_id !== undefined)
      return { state: 'paid', providerTxId: String(data.ref_id) };
    const errors = Array.isArray(body.errors) ? undefined : body.errors;
    // -51: the payment failed or was cancelled by the payer.
    if (errors?.code === -51)
      return { state: 'failed', reason: 'cancelled or failed by the payer' };
    return { state: 'failed', reason: `verify refused (${errorText(body)})` };
  }
}

function errorText(body: ZarinpalAnswer): string {
  const errors = Array.isArray(body.errors) ? undefined : body.errors;
  const data = Array.isArray(body.data) ? undefined : body.data;
  return `code ${String(errors?.code ?? data?.code ?? '?')}: ${errors?.message ?? data?.message ?? 'no message'}`;
}

// ───────────── Stripe ─────────────

interface StripeSession {
  id?: string;
  url?: string;
  status?: 'open' | 'complete' | 'expired';
  payment_status?: 'paid' | 'unpaid' | 'no_payment_required';
  payment_intent?: string | null;
  amount_total?: number;
  client_reference_id?: string | null;
  error?: { message?: string };
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: StripeSession };
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  readonly currency = 'USD';
  readonly minorPerMajor = 100;

  constructor(
    private readonly options: {
      secretKey: string;
      webhookSecret: string;
      /** https://api.stripe.com (overridable for tests and the dev mock). */
      baseUrl: string;
      /** Accepted age of a webhook signature (replay protection). */
      toleranceSeconds?: number;
    },
  ) {}

  #request(method: 'GET' | 'POST', path: string, form?: URLSearchParams) {
    return call(this.name, `${this.options.baseUrl}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.secretKey}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: form.toString() } : {}),
    }) as Promise<{ status: number; body: StripeSession }>;
  }

  async createCheckout(request: CheckoutRequest): Promise<Checkout> {
    const form = new URLSearchParams({
      mode: 'payment',
      client_reference_id: request.paymentId,
      'metadata[paymentId]': request.paymentId,
      success_url: request.callbackUrl,
      cancel_url: request.cancelUrl,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': request.amountMinor.toString(),
      'line_items[0][price_data][product_data][name]': request.description,
      ...(request.email ? { customer_email: request.email } : {}),
    });
    // Stripe's own idempotency: a retried create returns the same session.
    const { status, body } = await this.#request('POST', 'checkout/sessions', form);
    if (status >= 400 || !body.id || !body.url)
      throw new PaymentProviderError(this.name, body.error?.message ?? `HTTP ${String(status)}`);
    return { providerRef: body.id, redirectUrl: body.url };
  }

  async confirm(payment: { providerRef: string; amountMinor: bigint }): Promise<PaymentState> {
    const { status, body } = await this.#request(
      'GET',
      `checkout/sessions/${encodeURIComponent(payment.providerRef)}`,
    );
    if (status >= 400)
      throw new PaymentProviderError(this.name, body.error?.message ?? `HTTP ${String(status)}`);
    return stripeState(body, payment.amountMinor);
  }

  /** Verifies `Stripe-Signature` (HMAC-SHA256 of `t.payload`) and parses the event. */
  parseWebhook(rawBody: Buffer, signature: string | undefined, nowSeconds: number): StripeEvent {
    const parts = new Map<string, string[]>();
    for (const item of (signature ?? '').split(',')) {
      const [k, v] = item.split('=');
      if (k && v) parts.set(k.trim(), [...(parts.get(k.trim()) ?? []), v.trim()]);
    }
    const timestamp = Number(parts.get('t')?.[0]);
    if (!Number.isInteger(timestamp))
      throw new PaymentProviderError(this.name, 'webhook signature missing');
    if (Math.abs(nowSeconds - timestamp) > (this.options.toleranceSeconds ?? 300))
      throw new PaymentProviderError(this.name, 'webhook signature too old');
    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(`${String(timestamp)}.`)
      .update(rawBody)
      .digest();
    const valid = (parts.get('v1') ?? []).some((hex) => {
      const given = Buffer.from(hex, 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!valid) throw new PaymentProviderError(this.name, 'webhook signature invalid');
    return JSON.parse(rawBody.toString('utf8')) as StripeEvent;
  }
}

/** Session to payment state; the amount must match what we asked for. */
export function stripeState(session: StripeSession, amountMinor: bigint): PaymentState {
  if (session.status === 'expired') return { state: 'expired', reason: 'checkout session expired' };
  if (session.payment_status === 'paid') {
    if (session.amount_total !== undefined && BigInt(session.amount_total) !== amountMinor)
      return { state: 'failed', reason: `amount mismatch (${String(session.amount_total)})` };
    return { state: 'paid', providerTxId: session.payment_intent ?? session.id ?? '' };
  }
  return { state: 'pending' };
}

/** Signs a payload like Stripe does (tests and the dev mock). */
export function signStripePayload(payload: string, secret: string, timestamp: number): string {
  const v1 = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${payload}`)
    .digest('hex');
  return `t=${String(timestamp)},v1=${v1}`;
}
