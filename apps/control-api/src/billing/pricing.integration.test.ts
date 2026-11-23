/** Sale pricing, customer groups, plans and the marketplace snapshot (card 19.4). */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TokenService } from '../auth/crypto.js';
import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const CUSTOMER = 'org_price_customer';

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('sale pricing over HTTP', () => {
  let app: NestFastifyApplication;
  let operator = '';
  let platform = '';
  let customer = '';
  let modelId = '';

  const call = (method: string, url: string, t: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url: `/api/v1/${url}`,
        headers: { authorization: `Bearer ${t}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });
  const admin = (method: string, path: string, body?: unknown) =>
    call(method, `orgs/${platform}/${path}`, operator, body);
  const snapshot = () => app.get(SnapshotService).build();

  beforeAll(async () => {
    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        VALKEY_URL,
        MASTER_KEY: generateKey(),
        KEY_PEPPER: 'q'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
      }),
    );
    const db = app.get(PrismaService).client;
    await db.$executeRawUnsafe(
      'TRUNCATE refresh_tokens, memberships, audit_logs, users, subscription_usage, subscriptions, plans, customer_groups, api_keys, projects, models, providers, wallet_transactions, wallets, organizations CASCADE',
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    operator = (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            organizationName: 'Operator',
            name: 'O',
            email: 'price-op@example.com',
            password: 'a-long-enough-password',
          },
        })
    ).json<{ accessToken: string }>().accessToken;
    platform =
      (await call('GET', 'auth/me', operator)).json<{ organizations: { id: string }[] }>()
        .organizations[0]?.id ?? '';
    const user = await db.user.create({
      data: { id: 'usr_price', email: 'price@example.com', name: 'P', passwordHash: 'x' },
    });
    await db.organization.create({
      data: {
        id: CUSTOMER,
        name: 'Customer',
        slug: 'price-customer',
        memberships: { create: { id: 'mem_price', userId: user.id, role: 'OWNER' } },
        projects: { create: { id: 'prj_price', name: 'P', slug: 'p' } },
        apiKeys: {
          create: {
            id: 'key_price',
            projectId: 'prj_price',
            name: 'k',
            prefix: 'dr-price',
            hash: 'b'.repeat(64),
          },
        },
      },
    });
    customer = await new TokenService('j'.repeat(32)).signAccess({
      sub: user.id,
      email: user.email,
    });
    const provider = (
      await admin('POST', 'providers', {
        name: 'Upstream',
        type: 'openai',
        credentials: [{ name: 'k', secret: 'sk-x' }],
      })
    ).json<{ id: string }>().id;
    modelId = (
      await admin('POST', 'models', {
        providerId: provider,
        upstreamModel: 'gpt-4.1',
        slug: 'shop/gpt',
        pricing: { inputPerMTok: '2', outputPerMTok: '8' },
      })
    ).json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('a model is private and sold at cost until the operator says otherwise', async () => {
    const before = await snapshot();
    expect(before.platformOrganizationId).toBe(platform);
    const m = before.models.find((x) => x.id === modelId);
    expect(m?.public).toBeUndefined();
    expect(m?.sale).toBeUndefined();
  });

  it('publishing and pricing a model changes the next snapshot, no deploy needed', async () => {
    const res = await admin('PATCH', `models/${modelId}`, {
      isPublic: true,
      sale: { multiplier: '1.3', cacheMultiplier: '0.5' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      isPublic: true,
      sale: { multiplier: '1.3', perRequestUsd: null, cacheMultiplier: '0.5' },
    });
    expect((await snapshot()).models.find((x) => x.id === modelId)).toMatchObject({
      public: true,
      sale: { multiplier: '1.3', cacheMultiplier: '0.5' },
    });
    await admin('PATCH', `models/${modelId}`, {
      sale: { multiplier: '1.1', perRequestUsd: '0.04' },
    });
    expect((await snapshot()).models.find((x) => x.id === modelId)?.sale).toEqual({
      multiplier: '1.1',
      cacheMultiplier: '0.5',
      perRequestUsd: '0.04',
    });
  });

  it("a customer group's multiplier reaches its organization's keys", async () => {
    const group = (
      await admin('POST', 'billing/groups', { name: 'Resellers', multiplier: '0.8' })
    ).json<{
      id: string;
    }>();
    expect(
      (await admin('POST', 'billing/groups', { name: 'Resellers', multiplier: '1' })).statusCode,
    ).toBe(409);
    await admin('PUT', `billing/wallets/${CUSTOMER}/group`, { customerGroupId: group.id });
    const key = () => snapshot().then((s) => s.virtualKeys.find((k) => k.id === 'key_price'));
    expect((await key())?.priceMultiplier).toBe('0.8');
    await admin('PATCH', `billing/groups/${group.id}`, { multiplier: '0.75' });
    expect((await key())?.priceMultiplier).toBe('0.75');
    await admin('DELETE', `billing/groups/${group.id}`);
    expect((await key())?.priceMultiplier).toBeUndefined();
  });

  it('plans: subscribing needs a prepaid wallet with credit and charges the first period', async () => {
    const plan = (
      await admin('POST', 'billing/plans', { name: 'Starter', priceUsd: '10', includedUsd: '12' })
    ).json<{ id: string }>();
    const listed = (await call('GET', `orgs/${CUSTOMER}/wallet/plans`, customer)).json<
      { id: string }[]
    >();
    expect(listed.map((p) => p.id)).toEqual([plan.id]);
    const subscribe = () =>
      call('POST', `orgs/${CUSTOMER}/wallet/subscription`, customer, { planId: plan.id });
    expect((await subscribe()).statusCode).toBe(422);
    await admin('PATCH', `billing/wallets/${CUSTOMER}`, { prepaid: true });
    expect((await subscribe()).statusCode).toBe(402);
    expect((await call('GET', `orgs/${CUSTOMER}/wallet/subscription`, customer)).json()).toBeNull();
    await admin('POST', `billing/wallets/${CUSTOMER}/adjustments`, {
      amountUsd: '15',
      reason: 'test credit',
      idempotencyKey: 'plan-credit-1',
    });
    const ok = await subscribe();
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      status: 'active',
      includedUsd: '12.00000000',
      remainingUsd: '12.00000000',
      cancelAtPeriodEnd: false,
    });
    expect((await subscribe()).statusCode).toBe(409);
    const wallet = (await call('GET', `orgs/${CUSTOMER}/wallet`, customer)).json<{
      wallet: { balanceUsd: string };
    }>();
    expect(wallet.wallet.balanceUsd).toBe('5.00000000');
    const cancelled = await call('DELETE', `orgs/${CUSTOMER}/wallet/subscription`, customer);
    expect(cancelled.json()).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
  });
});
