/**
 * Upstream balances (card 32.9) on real services: gateway samples in Valkey reach
 * credential_balances, and an `upstream_balance_low` rule fires and is delivered to its channel.
 * Runs with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL set.
 */
import { UPSTREAM_BALANCES_KEY } from '@dirouter/contracts';
import { createPrismaClient } from '@dirouter/db';
import { createLogger } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evaluateAlerts } from './alerts.js';
import { type BalanceDb, drainBalances } from './balances.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const logger = createLogger({ service: 'test', level: 'silent' });
const RUN = Date.now().toString(36);
const ORG = `org_balance_${RUN}`;

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('upstream balances on real services', () => {
  const db = createPrismaClient({ databaseUrl: DATABASE_URL ?? '', maxConnections: 2 });
  const redis = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: null });
  const provider = `prv_bal_${RUN}`;
  const credentials = [`cred_bal_a_${RUN}`, `cred_bal_b_${RUN}`];

  beforeAll(async () => {
    await db.organization.create({ data: { id: ORG, name: 'Balance IT', slug: `bal-${RUN}` } });
    await db.provider.create({
      data: {
        id: provider,
        organizationId: ORG,
        slug: 'openrouter',
        name: 'OpenRouter',
        type: 'OPENAI_COMPATIBLE',
        baseUrl: 'https://openrouter.ai/api/v1',
        options: { preset: 'openrouter' },
      },
    });
    for (const id of credentials)
      await db.credential.create({
        data: {
          id,
          providerId: provider,
          name: id,
          secretEnc: 'v1.x',
          keyVersion: 1,
          last4: 'xxxx',
        },
      });
    await redis.del(UPSTREAM_BALANCES_KEY);
  });
  afterAll(async () => {
    await db.organization.delete({ where: { id: ORG } }).catch(() => undefined);
    await db.credentialBalance.deleteMany({ where: { providerId: provider } });
    await db.provider.deleteMany({ where: { id: provider } });
    await db.$disconnect();
    redis.disconnect();
  });

  it('stores the samples and fires a delivered low-balance alert', async () => {
    const at = new Date().toISOString();
    await redis.lpush(
      UPSTREAM_BALANCES_KEY,
      JSON.stringify({
        providerId: provider,
        credentialId: credentials[0],
        kind: 'openrouter',
        ok: true,
        amount: '25',
        currency: 'USD',
        checkedAt: at,
      }),
      JSON.stringify({
        providerId: provider,
        credentialId: credentials[1],
        kind: 'openrouter',
        ok: true,
        amount: '0.4',
        currency: 'USD',
        checkedAt: at,
      }),
    );
    expect(await drainBalances(db as unknown as BalanceDb, redis, logger)).toMatchObject({
      written: 2,
    });
    const stored = await db.credentialBalance.findMany({
      where: { providerId: provider },
      orderBy: { amount: 'asc' },
    });
    expect(stored.map((b) => [b.credentialId, b.amount?.toString(), b.currency])).toEqual([
      [credentials[1], '0.4', 'USD'],
      [credentials[0], '25', 'USD'],
    ]);

    const channel = await db.notificationChannel.create({
      data: {
        id: `nch_bal_${RUN}`,
        organizationId: ORG,
        name: 'ops',
        type: 'webhook',
        config: { url: 'https://hooks.example.com/balance' },
      },
    });
    await db.alertRule.create({
      data: {
        id: `alr_bal_${RUN}`,
        organizationId: ORG,
        name: 'Low upstream credit',
        type: 'upstream_balance_low',
        threshold: '1',
        channelId: channel.id,
      },
    });
    const delivered: string[] = [];
    const result = await evaluateAlerts({
      db: db,
      logger,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        delivered.push(typeof init.body === 'string' ? init.body : '');
        return new Response('ok');
      }) as unknown as typeof fetch,
      urlPolicy: { production: false },
    });
    const fired = result.fired.find((f) => f.rule.organizationId === ORG);
    expect(fired?.value).toBe(0.4);
    expect(delivered.some((body) => body.includes('Low upstream credit'))).toBe(true);
    const event = await db.alertEvent.findFirst({ where: { organizationId: ORG } });
    expect(event?.deliveredAt).toBeInstanceOf(Date);
    const details = event?.details as { balances: Record<string, unknown>[] };
    expect(details.balances[0]).toMatchObject({
      credentialId: credentials[1],
      amount: 0.4,
      currency: 'USD',
    });
  });
});
