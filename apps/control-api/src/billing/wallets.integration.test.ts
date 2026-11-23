/** Wallets and operator billing routes against real Postgres and Valkey (card 19.1). */
import { walletKey } from '@dirouter/contracts';
import { checkLedger } from '@dirouter/db';
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TokenService } from '../auth/crypto.js';
import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('wallets over HTTP', () => {
  let app: NestFastifyApplication;
  let operator = '';
  let platform = '';
  let customerToken = '';
  const customer = 'org_customer_it';

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, t: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/${url}`,
        remoteAddress: '10.7.0.2',
        headers: { authorization: `Bearer ${t}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });

  beforeAll(async () => {
    const env = envSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL,
      VALKEY_URL,
      MASTER_KEY: generateKey(),
      KEY_PEPPER: 'q'.repeat(32),
      JWT_SECRET: 'j'.repeat(32),
      INTERNAL_TOKEN: 'i'.repeat(32),
    });
    app = await createApp(env);
    const db = app.get(PrismaService).client;
    await db.$executeRawUnsafe(
      'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, api_keys, projects, teams, users, wallet_transactions, wallets, organizations CASCADE',
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
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
            email: 'op@example.com',
            password: PW,
          },
        })
    ).json<{ accessToken: string }>().accessToken;
    platform =
      (await call('GET', 'auth/me', operator)).json<{ organizations: { id: string }[] }>()
        .organizations[0]?.id ?? '';
    // A customer organization with its own owner (the portal creates these in card 19.5).
    const user = await db.user.create({
      data: { id: 'usr_customer_it', email: 'c@example.com', name: 'C', passwordHash: 'x' },
    });
    await db.organization.create({
      data: {
        id: customer,
        name: 'Customer',
        slug: 'customer-it',
        memberships: { create: { id: 'mem_customer_it', userId: user.id, role: 'OWNER' } },
      },
    });
    customerToken = await new TokenService('j'.repeat(32)).signAccess({
      sub: user.id,
      email: user.email,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('the setup organization is the platform; billing routes are closed to everyone else', async () => {
    expect((await call('GET', `orgs/${platform}/billing/wallets`, operator)).statusCode).toBe(200);
    expect((await call('GET', `orgs/${customer}/billing/wallets`, customerToken)).statusCode).toBe(
      404,
    );
  });

  it('the operator turns on prepaid mode and credits the wallet exactly once', async () => {
    const on = await call('PATCH', `orgs/${platform}/billing/wallets/${customer}`, operator, {
      prepaid: true,
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ prepaid: true, wallet: { balanceUsd: '0.00000000' } });

    const credit = {
      amountUsd: '25.5',
      reason: 'bank transfer #77',
      idempotencyKey: 'transfer-77',
    };
    const first = await call(
      'POST',
      `orgs/${platform}/billing/wallets/${customer}/adjustments`,
      operator,
      credit,
    );
    const again = await call(
      'POST',
      `orgs/${platform}/billing/wallets/${customer}/adjustments`,
      operator,
      credit,
    );
    expect(first.json()).toMatchObject({ created: true });
    expect(again.json()).toMatchObject({ created: false });

    const mine = await call('GET', `orgs/${customer}/wallet`, customerToken);
    expect(mine.json()).toMatchObject({
      prepaid: true,
      wallet: { balanceUsd: '25.50000000', heldUsd: '0.00000000', availableUsd: '25.50000000' },
    });
    const walletId = mine.json<{ wallet: { id: string } }>().wallet.id;
    // The gateway's copy is updated at once, not only by the worker's next sync.
    expect(await app.get(ValkeyService).client.hget(walletKey(walletId), 'balance')).toBe(
      '2550000000',
    );
    const statement = (await call('GET', `orgs/${customer}/wallet/statement`, customerToken)).json<
      { kind: string; amountUsd: string; balanceAfterUsd: string; description: string }[]
    >();
    expect(statement).toEqual([
      expect.objectContaining({
        kind: 'adjustment',
        amountUsd: '25.50000000',
        balanceAfterUsd: '25.50000000',
        description: 'bank transfer #77',
      }),
    ]);
  });

  it('a debit larger than the balance is refused with 402', async () => {
    const res = await call(
      'POST',
      `orgs/${platform}/billing/wallets/${customer}/adjustments`,
      operator,
      { amountUsd: '-100', reason: 'too much', idempotencyKey: 'overdraw-1' },
    );
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'insufficient_credit' });
  });

  it('the snapshot gives prepaid keys their wallet', async () => {
    const db = app.get(PrismaService).client;
    await db.project.create({
      data: { id: 'prj_customer_it', organizationId: customer, name: 'P', slug: 'p' },
    });
    await db.apiKey.create({
      data: {
        id: 'key_customer_it',
        organizationId: customer,
        projectId: 'prj_customer_it',
        name: 'k',
        prefix: 'dr-custit',
        hash: 'a'.repeat(64),
      },
    });
    const content = await app.get(SnapshotService).build();
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: customer } });
    expect(content.virtualKeys.find((k) => k.id === 'key_customer_it')?.walletId).toBe(wallet.id);
  });

  it('the ledger check reports a balanced ledger', async () => {
    const res = await call('GET', `orgs/${platform}/billing/ledger/check`, operator);
    expect(res.json()).toMatchObject({ ok: true, totalUsd: '0.00000000' });
    expect(await checkLedger(app.get(PrismaService).client)).toMatchObject({ driftedWallets: 0 });
  });
});
