import { describe, expect, it } from 'vitest';

import { minorUnits } from './payments.service.js';
import { signStripePayload, StripeProvider, stripeState } from './providers.js';

describe('payment amounts', () => {
  it('converts USD to minor units, rounding up so the payer never pays less than the credit', () => {
    expect(minorUnits('5', '1000000.5', 1)).toBe(5_000_003n);
    expect(minorUnits('12.5', '1', 100)).toBe(1_250n);
    expect(minorUnits('0.00000001', '1', 100)).toBe(1n);
  });
});

describe('Stripe webhooks', () => {
  const stripe = new StripeProvider({
    secretKey: 'sk_test',
    webhookSecret: 'whsec_x',
    baseUrl: 'http://stripe.invalid',
  });
  const body = JSON.stringify({
    id: 'evt',
    type: 'checkout.session.completed',
    data: { object: {} },
  });

  it('accepts a fresh, correctly signed event', () => {
    const sig = signStripePayload(body, 'whsec_x', 1_000);
    expect(stripe.parseWebhook(Buffer.from(body), sig, 1_010).id).toBe('evt');
  });

  it.each([
    ['a wrong secret', signStripePayload(body, 'whsec_y', 1_000), 1_000],
    ['an old signature', signStripePayload(body, 'whsec_x', 1_000), 2_000],
    ['no signature', undefined, 1_000],
  ])('refuses %s', (_name, sig, now) => {
    expect(() => stripe.parseWebhook(Buffer.from(body), sig, now)).toThrow(/stripe/);
  });

  it('refuses a body changed after signing', () => {
    const sig = signStripePayload(body, 'whsec_x', 1_000);
    expect(() => stripe.parseWebhook(Buffer.from(`${body} `), sig, 1_000)).toThrow(/invalid/);
  });

  it('maps session states and checks the amount', () => {
    expect(
      stripeState({ payment_status: 'paid', amount_total: 500, payment_intent: 'pi' }, 500n),
    ).toEqual({ state: 'paid', providerTxId: 'pi' });
    expect(stripeState({ payment_status: 'paid', amount_total: 400 }, 500n).state).toBe('failed');
    expect(stripeState({ status: 'expired' }, 500n).state).toBe('expired');
    expect(stripeState({ status: 'open', payment_status: 'unpaid' }, 500n).state).toBe('pending');
  });
});
