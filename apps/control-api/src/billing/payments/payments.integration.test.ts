/**
 * Wallet top-ups through fake Zarinpal and Stripe against real Postgres and Valkey (card 19.2).
 */
import { registerPayments } from '@dirouter/mock-provider/payments';
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TokenService } from '../../auth/crypto.js';
import { createApp } from '../../bootstrap.js';
import { envSchema } from '../../env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { PaymentsService } from './payments.service.js';
import { signStripePayload } from './providers.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const WEBHOOK_SECRET = 'whsec_integration';
const CUSTOMER = 'org_pay_customer';

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('wallet top-ups over HTTP', () => {
  let app: NestFastifyApplication;
  const mock = Fastify();
  let apiUrl = '';
  let mockUrl = '';
  let operator = '';
  let platform = '';
  let customer = '';

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, t?: string, body?: unknown) =>
    fetch(`${apiUrl}/api/v1/${url}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(t ? { authorization: `Bearer ${t}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const balance = async () =>
    (
      await app.get(PrismaService).client.wallet.findUniqueOrThrow({
        where: { organizationId: CUSTOMER },
      })
    ).balanceUsd.toFixed(8);
  const pay = async (provider: 'zarinpal' | 'stripe', amountUsd: string) => {
    const res = await call('POST', `orgs/${CUSTOMER}/wallet/payments`, customer, {
      provider,
      amountUsd,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { paymentId: string; redirectUrl: string };
  };
  /** The payer's browser: open the provider page and follow it back to us. */
  const browse = async (url: string) => {
    const page = await fetch(url, { redirect: 'manual' });
    const back = page.headers.get('location') ?? '';
    const landing = await fetch(back, { redirect: 'manual' });
    return new URL(landing.headers.get('location') ?? '');
  };
  const payment = (id: string) =>
    app.get(PrismaService).client.payment.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    // Ports are only known after listen; the mock reads these options lazily.
    const mockOptions: NonNullable<Parameters<typeof registerPayments>[1]> = {
      stripeWebhookSecret: WEBHOOK_SECRET,
    };
    registerPayments(mock, mockOptions);
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    mockUrl = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    mockOptions.publicUrl = mockUrl;

    const env = envSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL,
      VALKEY_URL,
      MASTER_KEY: generateKey(),
      KEY_PEPPER: 'q'.repeat(32),
      JWT_SECRET: 'j'.repeat(32),
      INTERNAL_TOKEN: 'i'.repeat(32),
      PUBLIC_DASHBOARD_URL: 'https://app.example.test',
      PAYMENT_RETURN_ORIGINS: 'https://portal.example.test',
      ZARINPAL_MERCHANT_ID: '00000000-0000-0000-0000-000000000000',
      ZARINPAL_BASE_URL: `${mockUrl}/zarinpal`,
      STRIPE_SECRET_KEY: 'sk_test_integration',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_BASE_URL: `${mockUrl}/stripe`,
    });
    app = await createApp(env);
    const db = app.get(PrismaService).client;
    await db.$executeRawUnsafe(
      'TRUNCATE refresh_tokens, memberships, audit_logs, users, payments, billing_settings, wallets, organizations CASCADE',
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    const aa = app.getHttpServer().address();
    apiUrl = `http://127.0.0.1:${String(typeof aa === 'object' && aa ? aa.port : 0)}`;
    // Callbacks must come back to this test server.
    (env as { PUBLIC_API_URL: string }).PUBLIC_API_URL = apiUrl;
    mockOptions.stripeWebhookUrl = `${apiUrl}/api/v1/payments/stripe/webhook`;

    operator = (
      (await (
        await call('POST', 'auth/setup', undefined, {
          organizationName: 'Operator',
          name: 'O',
          email: 'pay-op@example.com',
          password: 'a-long-enough-password',
        })
      ).json()) as { accessToken: string }
    ).accessToken;
    platform =
      (
        (await (await call('GET', 'auth/me', operator)).json()) as {
          organizations: { id: string }[];
        }
      ).organizations[0]?.id ?? '';
    const user = await db.user.create({
      data: { id: 'usr_pay_customer', email: 'payer@example.com', name: 'P', passwordHash: 'x' },
    });
    await db.organization.create({
      data: {
        id: CUSTOMER,
        name: 'Payer',
        slug: 'payer',
        memberships: { create: { id: 'mem_pay_customer', userId: user.id, role: 'OWNER' } },
      },
    });
    customer = await new TokenService('j'.repeat(32)).signAccess({
      sub: user.id,
      email: user.email,
    });
  });

  afterAll(async () => {
    await app.close();
    if (mock.server.listening) await mock.close();
  });

  it('nothing is offered until the operator configures it', async () => {
    const res = await call('POST', `orgs/${CUSTOMER}/wallet/payments`, customer, {
      provider: 'zarinpal',
      amountUsd: '5',
    });
    expect(res.status).toBe(422);
    const put = await call('PUT', `orgs/${platform}/billing/settings`, operator, {
      exchangeRates: { IRR: '1000000.5' },
      topup: { minUsd: '1', maxUsd: '100' },
      providers: ['zarinpal', 'stripe'],
    });
    expect(put.status).toBe(200);
    const options = (await (
      await call('GET', `orgs/${CUSTOMER}/wallet/payment-options`, customer)
    ).json()) as { providers: string[] };
    expect(options.providers).toEqual(['zarinpal', 'stripe']);
  });

  it('refuses amounts outside the limits and foreign return URLs', async () => {
    for (const body of [
      { provider: 'stripe', amountUsd: '0.5' },
      { provider: 'stripe', amountUsd: '101' },
      { provider: 'stripe', amountUsd: '5', returnUrl: 'https://evil.example/steal' },
    ])
      expect((await call('POST', `orgs/${CUSTOMER}/wallet/payments`, customer, body)).status).toBe(
        422,
      );
  });

  it('Zarinpal: a paid top-up is credited once, however many callbacks arrive', async () => {
    const { paymentId, redirectUrl } = await pay('zarinpal', '5');
    // 5 USD × 1,000,000.5 IRR, rounded up.
    expect((await payment(paymentId)).amountMinor).toBe(5_000_003n);
    const landing = await browse(redirectUrl);
    expect(landing.origin).toBe('https://app.example.test');
    expect(landing.searchParams.get('payment')).toBe(paymentId);
    expect(landing.searchParams.get('status')).toBe('succeeded');
    expect(await balance()).toBe('5.00000000');

    // The payer reloads the callback page, several times and at once.
    const { providerRef } = await payment(paymentId);
    const replays = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('GET', `payments/zarinpal/callback?Authority=${String(providerRef)}&Status=OK`),
      ),
    );
    expect(replays.every((r) => r.status === 302)).toBe(true);
    expect(await balance()).toBe('5.00000000');
    const p = await payment(paymentId);
    expect(p.status).toBe('SUCCEEDED');
    expect(p.providerTxId).toMatch(/^\d+$/);
    expect(
      await app.get(PrismaService).client.walletTransaction.count({
        where: { idempotencyKey: `payment:${paymentId}` },
      }),
    ).toBe(1);
  });

  it('Zarinpal: a cancelled payment changes nothing but its own status', async () => {
    const { paymentId, redirectUrl } = await pay('zarinpal', '7');
    const landing = await browse(`${redirectUrl}?result=NOK`);
    expect(landing.searchParams.get('status')).toBe('failed');
    expect(await payment(paymentId)).toMatchObject({ status: 'FAILED', transactionId: null });
    expect(await balance()).toBe('5.00000000');
    // A forged "OK" for the cancelled authority: Zarinpal refuses to verify it.
    const { providerRef } = await payment(paymentId);
    await call('GET', `payments/zarinpal/callback?Authority=${String(providerRef)}&Status=OK`);
    expect(await balance()).toBe('5.00000000');
  });

  it('Stripe: the signed webhook credits once; replays and forged events do not', async () => {
    const { paymentId, redirectUrl } = await pay('stripe', '12.5');
    expect((await payment(paymentId)).amountMinor).toBe(1250n);
    const landing = await browse(redirectUrl);
    expect(landing.searchParams.get('status')).toBe('succeeded');
    expect(await balance()).toBe('17.50000000');

    const { providerRef } = await payment(paymentId);
    const event = JSON.stringify({
      id: 'evt_replay',
      type: 'checkout.session.completed',
      data: { object: { id: providerRef, payment_status: 'paid', amount_total: 1250 } },
    });
    const send = (signature: string) =>
      fetch(`${apiUrl}/api/v1/payments/stripe/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        body: event,
      });
    const now = Math.floor(Date.now() / 1000);
    expect((await send(signStripePayload(event, WEBHOOK_SECRET, now))).status).toBe(200);
    expect((await send(signStripePayload(event, 'whsec_wrong', now))).status).toBe(400);
    expect((await send(signStripePayload(event, WEBHOOK_SECRET, now - 3_600))).status).toBe(400);
    expect(await balance()).toBe('17.50000000');
  });

  it('Stripe: a lost webhook is caught up by reconciliation; an expired session credits nothing', async () => {
    const lost = await pay('stripe', '2');
    await fetch(`${lost.redirectUrl}?webhook=none`, { redirect: 'manual' });
    const expired = await pay('stripe', '3');
    const { providerRef } = await payment(expired.paymentId);
    await fetch(`${mockUrl}/__payments/stripe/${String(providerRef)}/expire`, { method: 'POST' });
    expect((await payment(lost.paymentId)).status).toBe('PENDING');

    const service = app.get(PaymentsService);
    const result = await service.reconcileOnce({ force: true, now: Date.now() + 5 * 60_000 });
    expect(result).toMatchObject({ checked: 1, succeeded: 1 });
    expect(await payment(lost.paymentId)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await payment(expired.paymentId)).toMatchObject({ status: 'EXPIRED' });
    expect(await balance()).toBe('19.50000000');
  });

  it('a provider outage fails the checkout cleanly', async () => {
    await mock.close();
    const res = await call('POST', `orgs/${CUSTOMER}/wallet/payments`, customer, {
      provider: 'stripe',
      amountUsd: '4',
    });
    expect(res.status).toBe(503);
    const listed = (await (
      await call('GET', `orgs/${platform}/billing/payments?status=failed`, operator)
    ).json()) as { provider: string; failureReason: string }[];
    expect(listed.some((p) => p.provider === 'stripe' && /unreachable/.test(p.failureReason))).toBe(
      true,
    );
    expect(await balance()).toBe('19.50000000');
  });
});
