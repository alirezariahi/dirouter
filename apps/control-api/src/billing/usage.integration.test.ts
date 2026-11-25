/**
 * The portal's usage page (card 26.2): a customer sees only its own organization's usage, and the
 * figures equal its wallet statement.
 */
import { chargeUsage, ensureWallet, postTransaction, SYSTEM_WALLETS, toUnits } from '@dirouter/db';
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TokenService } from '../auth/crypto.js';
import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const A = 'org_use_a';
const B = 'org_use_b';
const C = 'org_use_c';

interface Usage {
  from: string;
  to: string;
  basis: string;
  totals: { requests: number; inputTokens: number; outputTokens: number; costUsd: string };
  byDay: { day: string; requests: number; costUsd: string; inputTokens: number }[];
  byModel: { model: string; requests: number; costUsd: string }[];
  byKey: { apiKeyId: string | null; name: string | null; requests: number; costUsd: string }[];
  recent: {
    requestId: string;
    model: string;
    keyName: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: string;
  }[];
}

const sum = (values: string[]) => values.reduce((s, v) => s + toUnits(v), 0n);

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('portal usage over HTTP', () => {
  let app: NestFastifyApplication;
  const tokens: Record<string, string> = {};

  const call = (url: string, who: string) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/api/v1/${url}`,
        headers: { authorization: `Bearer ${tokens[who] ?? ''}` },
      });

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
      'TRUNCATE refresh_tokens, memberships, audit_logs, users, invoices, usage_daily, request_log, api_keys, projects, wallet_transactions, wallets, organizations CASCADE',
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const signer = new TokenService('j'.repeat(32));
    for (const org of [A, B, C]) {
      const user = `usr_${org}`;
      await db.user.create({
        data: { id: user, email: `${user}@example.com`, name: user, passwordHash: 'x' },
      });
      await db.organization.create({
        data: {
          id: org,
          name: org,
          slug: org.replaceAll('_', '-'),
          prepaid: org !== C,
          memberships: { create: { id: `mem_${org}`, userId: user, role: 'OWNER' } },
          projects: { create: { id: `prj_${org}`, name: 'P', slug: 'p' } },
        },
      });
      for (const key of ['main', 'ci'])
        await db.apiKey.create({
          data: {
            id: `key_${org}_${key}`,
            organizationId: org,
            projectId: `prj_${org}`,
            name: `${org} ${key}`,
            prefix: `${org}${key}`,
            hash: `hash_${org}_${key}`,
          },
        });
      tokens[org] = await signer.signAccess({ sub: user, email: `${user}@example.com` });
    }

    const log = (
      org: string,
      id: string,
      key: string,
      model: string,
      input: number,
      output: number,
      charge: string,
    ) =>
      db.$executeRaw`
        INSERT INTO request_log (id, created_at, organization_id, project_id, api_key_id, inbound_api,
          requested_model, model_id, stream, status, http_status, input_tokens, output_tokens,
          cost_usd, charge_usd, latency_ms, config_version, gateway_instance)
        VALUES (${id}, now() - interval '1 second', ${org}, ${`prj_${org}`}, ${`key_${org}_${key}`}, 'openai',
          ${model}, ${model}, false, 'success', 200, ${input}, ${output}, ${charge}::numeric * 0.8,
          ${charge}::numeric, 100, 1, 'gw')`;

    // Two prepaid customers whose usage goes through the real ledger, as the worker posts it.
    const requests: [string, string, string, string, number, number, string][] = [
      [A, 'req_a1', 'main', 'shop/fast', 1000, 200, '0.75'],
      [A, 'req_a2', 'main', 'shop/fast', 500, 100, '0.5'],
      [A, 'req_a3', 'ci', 'shop/smart', 3000, 900, '3.125'],
      [B, 'req_b1', 'main', 'shop/smart', 70, 7, '9.99'],
      [B, 'req_b2', 'main', 'shop/fast', 1, 1, '0.01'],
    ];
    for (const org of [A, B]) {
      const wallet = (await ensureWallet(db, org)).id;
      await postTransaction(db, {
        kind: 'topup',
        idempotencyKey: `use-test:${org}`,
        legs: [
          { walletId: wallet, amountUsd: '50' },
          { walletId: SYSTEM_WALLETS.funding, amountUsd: '-50' },
        ],
      });
    }
    // A log row of A whose id B's charge also names: B must not see A's tokens through it.
    await log(A, 'req_shared', 'main', 'shop/fast', 123456, 654321, '0');
    requests.push([B, 'req_shared', 'ci', 'shop/fast', 0, 0, '0.02']);
    for (const [org, id, key, model, input, output, charge] of requests) {
      if (id !== 'req_shared') await log(org, id, key, model, input, output, charge);
      await chargeUsage(db, {
        requestId: id,
        walletId: (await ensureWallet(db, org)).id,
        amountUsd: charge,
        metadata: { organizationId: org, model, apiKeyId: `key_${org}_${key}` },
      });
    }
    // A postpaid customer: the request log's sale price.
    await log(C, 'req_c1', 'main', 'shop/fast', 10, 20, '1.1');
    await log(C, 'req_c2', 'ci', 'shop/fast', 30, 40, '2.2');
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows a prepaid customer its usage by day, model and key, with the cost of each request', async () => {
    const res = await call(`orgs/${A}/usage`, A);
    expect(res.statusCode).toBe(200);
    const usage = res.json<Usage>();
    expect(usage.basis).toBe('prepaid');
    expect(usage.totals).toEqual({
      requests: 3,
      inputTokens: 4500,
      outputTokens: 1200,
      costUsd: '4.37500000',
    });
    expect(usage.byDay).toHaveLength(30);
    expect(usage.byModel).toEqual([
      {
        model: 'shop/smart',
        requests: 1,
        inputTokens: 3000,
        outputTokens: 900,
        costUsd: '3.12500000',
      },
      {
        model: 'shop/fast',
        requests: 2,
        inputTokens: 1500,
        outputTokens: 300,
        costUsd: '1.25000000',
      },
    ]);
    expect(usage.byKey.map((k) => [k.name, k.requests, k.costUsd])).toEqual([
      [`${A} ci`, 1, '3.12500000'],
      [`${A} main`, 2, '1.25000000'],
    ]);
    expect(usage.recent.map((r) => r.requestId).sort()).toEqual(['req_a1', 'req_a2', 'req_a3']);
    expect(usage.recent.find((r) => r.requestId === 'req_a3')).toMatchObject({
      model: 'shop/smart',
      keyName: `${A} ci`,
      inputTokens: 3000,
      outputTokens: 900,
      costUsd: '3.12500000',
    });
  });

  it('agrees with the wallet statement, in total and day by day', async () => {
    for (const org of [A, B]) {
      const usage = (await call(`orgs/${org}/usage`, org)).json<Usage>();
      const statement = (await call(`orgs/${org}/wallet/statement?limit=500`, org)).json<
        { kind: string; amountUsd: string; createdAt: string }[]
      >();
      const usageLines = statement.filter(
        (e) =>
          e.kind === 'usage' &&
          e.createdAt.slice(0, 10) >= usage.from &&
          e.createdAt.slice(0, 10) < usage.to,
      );
      expect(toUnits(usage.totals.costUsd)).toBe(-sum(usageLines.map((e) => e.amountUsd)));
      expect(usage.totals.requests).toBe(usageLines.length);
      for (const day of usage.byDay)
        expect(toUnits(day.costUsd), day.day).toBe(
          -sum(usageLines.filter((e) => e.createdAt.startsWith(day.day)).map((e) => e.amountUsd)),
        );
      // Every breakdown adds up to the same total.
      for (const parts of [usage.byDay, usage.byModel, usage.byKey, usage.recent])
        expect(sum(parts.map((p) => p.costUsd))).toBe(toUnits(usage.totals.costUsd));
      // And the balance moved by exactly that much since the top-up.
      const wallet = (await call(`orgs/${org}/wallet`, org)).json<{
        wallet: { balanceUsd: string };
      }>();
      expect(toUnits(wallet.wallet.balanceUsd)).toBe(toUnits('50') - toUnits(usage.totals.costUsd));
    }
  });

  it('never shows another organization’s usage', async () => {
    // Members of B or C cannot open A's usage, and A cannot open theirs.
    expect((await call(`orgs/${A}/usage`, B)).statusCode).toBe(404);
    expect((await call(`orgs/${A}/usage`, C)).statusCode).toBe(404);
    expect((await call(`orgs/${B}/usage`, A)).statusCode).toBe(404);
    expect((await call(`orgs/${A}/wallet/statement`, B)).statusCode).toBe(404);
    expect((await call(`orgs/${A}/invoices`, B)).statusCode).toBe(404);
    // B's own page holds B's requests only, and A's log row with a shared id lends it nothing.
    const usage = (await call(`orgs/${B}/usage`, B)).json<Usage>();
    expect(usage.recent.map((r) => r.requestId).sort()).toEqual(['req_b1', 'req_b2', 'req_shared']);
    expect(usage.totals).toMatchObject({ requests: 3, inputTokens: 71, costUsd: '10.02000000' });
    expect(usage.recent.find((r) => r.requestId === 'req_shared')).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
    expect(usage.byKey.every((k) => k.name === null || k.name.startsWith(B))).toBe(true);
  });

  it('bills a postpaid customer from the request log', async () => {
    const usage = (await call(`orgs/${C}/usage`, C)).json<Usage>();
    expect(usage.basis).toBe('postpaid');
    expect(usage.totals).toEqual({
      requests: 2,
      inputTokens: 40,
      outputTokens: 60,
      costUsd: '3.30000000',
    });
  });

  it('takes a range of at most 93 days', async () => {
    const ok = (await call(`orgs/${A}/usage?from=2026-01-01&to=2026-04-01`, A)).json<Usage>();
    expect(ok.byDay).toHaveLength(90);
    expect((await call(`orgs/${A}/usage?from=2026-01-01&to=2026-06-01`, A)).statusCode).toBe(422);
    expect((await call(`orgs/${A}/usage?from=2026-02-01&to=2026-02-01`, A)).statusCode).toBe(422);
  });
});
