/**
 * Fake payment providers (card 19.2): just enough of Zarinpal v4 and Stripe Checkout to run the
 * top-up flow end to end in tests and on the dev stack, without real accounts.
 *
 * Zarinpal: POST /zarinpal/pg/v4/payment/{request,verify}.json and the payer's page
 *   GET /zarinpal/pg/StartPay/:authority?result=OK|NOK (redirects to the callback).
 * Stripe:   POST /stripe/v1/checkout/sessions, GET /stripe/v1/checkout/sessions/:id and the payer's
 *   page GET /stripe/pay/:id?result=paid|cancel, which also delivers a signed webhook.
 * Test hooks: POST /__payments/stripe/:id/expire, GET /__payments.
 */
import { createHmac, randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

export interface PaymentMockOptions {
  /** Public origin of this mock as the payer's browser sees it (Stripe session URLs). */
  publicUrl?: string | undefined;
  /** Where to deliver Stripe webhooks and the secret to sign them with. */
  stripeWebhookUrl?: string | undefined;
  stripeWebhookSecret?: string | undefined;
}

interface ZarinpalPayment {
  amount: number;
  callbackUrl: string;
  paid: boolean;
  verified: boolean;
  refId: number;
}
interface StripeSession {
  id: string;
  amount: number;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId: string;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid';
  paymentIntent: string | null;
}

const token = (prefix: string) => `${prefix}${randomBytes(12).toString('hex')}`;

export function registerPayments(app: FastifyInstance, options: PaymentMockOptions = {}): void {
  const zarinpal = new Map<string, ZarinpalPayment>();
  const stripe = new Map<string, StripeSession>();
  let refId = 100_000;

  if (!app.hasContentTypeParser('application/x-www-form-urlencoded'))
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );

  // ───────────── Zarinpal ─────────────

  app.post<{ Body: { amount?: number; callback_url?: string; merchant_id?: string } }>(
    '/zarinpal/pg/v4/payment/request.json',
    (req) => {
      const { amount, callback_url: callbackUrl, merchant_id: merchant } = req.body;
      if (!merchant || !amount || amount < 1_000 || !callbackUrl)
        return { data: [], errors: { code: -9, message: 'The input params invalid' } };
      const authority = `A${randomBytes(17).toString('hex').toUpperCase()}`.slice(0, 36);
      zarinpal.set(authority, { amount, callbackUrl, paid: false, verified: false, refId: 0 });
      return { data: { code: 100, message: 'Success', authority, fee: 0 }, errors: [] };
    },
  );

  app.get<{ Params: { authority: string }; Querystring: { result?: string } }>(
    '/zarinpal/pg/StartPay/:authority',
    (req, reply) => {
      const payment = zarinpal.get(req.params.authority);
      if (!payment) return reply.status(404).send({ error: 'unknown authority' });
      const ok = (req.query.result ?? 'OK') === 'OK';
      if (ok) {
        payment.paid = true;
        payment.refId = ++refId;
      }
      const target = new URL(payment.callbackUrl);
      target.searchParams.set('Authority', req.params.authority);
      target.searchParams.set('Status', ok ? 'OK' : 'NOK');
      return reply.redirect(target.toString(), 302);
    },
  );

  app.post<{ Body: { authority?: string; amount?: number } }>(
    '/zarinpal/pg/v4/payment/verify.json',
    (req) => {
      const payment = zarinpal.get(req.body.authority ?? '');
      if (!payment || payment.amount !== req.body.amount)
        return { data: [], errors: { code: -50, message: 'Amount or authority mismatch' } };
      if (!payment.paid)
        return { data: [], errors: { code: -51, message: 'Session is not valid' } };
      const code = payment.verified ? 101 : 100;
      payment.verified = true;
      return {
        data: { code, message: code === 100 ? 'Paid' : 'Verified', ref_id: payment.refId },
        errors: [],
      };
    },
  );

  // ───────────── Stripe ─────────────

  const sessionView = (s: StripeSession) => ({
    id: s.id,
    object: 'checkout.session',
    url: s.status === 'open' ? `${options.publicUrl ?? ''}/stripe/pay/${s.id}` : null,
    status: s.status,
    payment_status: s.paymentStatus,
    payment_intent: s.paymentIntent,
    amount_total: s.amount,
    client_reference_id: s.clientReferenceId,
  });

  async function deliver(session: StripeSession, type: string) {
    if (!options.stripeWebhookUrl || !options.stripeWebhookSecret) return;
    const payload = JSON.stringify({
      id: token('evt_'),
      type,
      data: { object: sessionView(session) },
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', options.stripeWebhookSecret)
      .update(`${String(t)}.${payload}`)
      .digest('hex');
    await fetch(options.stripeWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${String(t)},v1=${v1}`,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  app.post<{ Body: Record<string, string> }>('/stripe/v1/checkout/sessions', (req, reply) => {
    if (!req.headers.authorization?.startsWith('Bearer sk_'))
      return reply.status(401).send({ error: { message: 'Invalid API Key provided' } });
    const amount = Number(req.body['line_items[0][price_data][unit_amount]']);
    if (!Number.isInteger(amount) || amount < 50)
      return reply.status(400).send({ error: { message: 'Amount must be at least 50 cents' } });
    const session: StripeSession = {
      id: token('cs_test_'),
      amount,
      successUrl: req.body.success_url ?? '',
      cancelUrl: req.body.cancel_url ?? '',
      clientReferenceId: req.body.client_reference_id ?? '',
      status: 'open',
      paymentStatus: 'unpaid',
      paymentIntent: null,
    };
    stripe.set(session.id, session);
    return sessionView(session);
  });

  app.get<{ Params: { id: string } }>('/stripe/v1/checkout/sessions/:id', (req, reply) => {
    const session = stripe.get(req.params.id);
    if (!session) return reply.status(404).send({ error: { message: 'No such checkout.session' } });
    return sessionView(session);
  });

  app.get<{ Params: { id: string }; Querystring: { result?: string; webhook?: string } }>(
    '/stripe/pay/:id',
    async (req, reply) => {
      const session = stripe.get(req.params.id);
      if (session?.status !== 'open') return reply.status(404).send({ error: 'session closed' });
      if ((req.query.result ?? 'paid') !== 'paid') return reply.redirect(session.cancelUrl, 302);
      session.status = 'complete';
      session.paymentStatus = 'paid';
      session.paymentIntent = token('pi_');
      // ?webhook=none simulates a lost webhook (the return page or reconcile must credit).
      if (req.query.webhook !== 'none') await deliver(session, 'checkout.session.completed');
      return reply.redirect(session.successUrl, 302);
    },
  );

  app.post<{ Params: { id: string } }>('/__payments/stripe/:id/expire', async (req, reply) => {
    const session = stripe.get(req.params.id);
    if (session?.status !== 'open') return reply.status(404).send({ error: 'not open' });
    session.status = 'expired';
    await deliver(session, 'checkout.session.expired');
    return sessionView(session);
  });

  app.get('/__payments', () => ({
    zarinpal: Object.fromEntries(zarinpal),
    stripe: Object.fromEntries([...stripe].map(([id, s]) => [id, sessionView(s)])),
  }));
}
