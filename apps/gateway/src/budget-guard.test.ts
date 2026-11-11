/**
 * Budget (card 6.3). The Valkey part runs with INTEGRATION_VALKEY_URL.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUDGET_ALERTS_KEY,
  type BudgetAlertEvent,
  type BudgetConfig,
  type ConfigSnapshotInput,
} from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { BudgetGuard, type ScopedBudget } from './budget-guard.js';
import { buildGateway } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const scoped = (budget: Partial<BudgetConfig> & { id: string }): ScopedBudget => ({
  budget: { period: 'daily', alertThresholds: [50, 80, 100], ...budget },
  scope: 'project',
  scopeId: 'prj',
  organizationId: 'org',
});
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('Valkey outage', () => {
  const dead = () =>
    new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => 1_000,
    }).on('error', () => undefined);

  it('fail-open lets requests through, fail-closed rejects as unavailable', async () => {
    const redis = dead();
    try {
      const b = [scoped({ id: 'b1', limitUsd: '1' })];
      const open = new BudgetGuard({ redis, logger, failMode: () => 'open' });
      expect(await open.check(b)).toEqual({ ok: true });
      const closed = new BudgetGuard({ redis, logger, failMode: () => 'closed' });
      expect(await closed.check(b)).toMatchObject({ ok: false, unavailable: true });
      // Without a budget, Valkey is never needed.
      expect(await closed.check([])).toEqual({ ok: true });
      open.record(b, '0.5', 10); // never throws
    } finally {
      redis.disconnect();
    }
  });
});

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
describe.skipIf(!VALKEY_URL)('budgets on real Valkey', () => {
  const conns: Redis[] = [];
  const conn = () => {
    const r = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false });
    conns.push(r);
    return r;
  };
  const ready = async () => {
    for (const c of conns) if (c.status !== 'ready') await new Promise((r) => c.once('ready', r));
  };
  afterAll(() => {
    for (const c of conns) c.disconnect();
  });

  it('the request after the cap is rejected, per USD and per tokens', async () => {
    const guard = new BudgetGuard({ redis: conn(), logger, failMode: () => 'open' });
    await ready();
    const usd = [scoped({ id: `usd-${randomUUID()}`, limitUsd: '0.001' })];
    expect((await guard.check(usd)).ok).toBe(true);
    guard.record(usd, '0.0006', 10);
    await settle();
    expect((await guard.check(usd)).ok).toBe(true); // 60%
    guard.record(usd, '0.0004', 10);
    await settle();
    const rejected = await guard.check(usd);
    expect(rejected).toMatchObject({ ok: false, kind: 'usd', limit: '0.001', period: 'daily' });
    if (!rejected.ok) expect(rejected.resetAt.getTime()).toBeGreaterThan(Date.now());

    const tokens = [scoped({ id: `tok-${randomUUID()}`, limitTokens: 100, period: 'monthly' })];
    guard.record(tokens, '0', 100);
    await settle();
    expect(await guard.check(tokens)).toMatchObject({
      ok: false,
      kind: 'tokens',
      period: 'monthly',
    });
  });

  it('a new period starts from zero', async () => {
    let now = new Date('2026-11-08T23:59:00Z');
    const guard = new BudgetGuard({
      redis: conn(),
      logger,
      failMode: () => 'open',
      clock: () => now,
    });
    await ready();
    const b = [scoped({ id: `period-${randomUUID()}`, limitUsd: '1' })];
    guard.record(b, '1', 1);
    await settle();
    expect((await guard.check(b)).ok).toBe(false);
    now = new Date('2026-11-09T00:00:01Z');
    expect((await guard.check(b)).ok).toBe(true);
  });

  it('each threshold fires exactly once even with concurrent replicas', async () => {
    const watcher = conn();
    const guards = [1, 2, 3].map(
      () => new BudgetGuard({ redis: conn(), logger, failMode: () => 'open' }),
    );
    await ready();
    const id = `alerts-${randomUUID()}`;
    const b = [scoped({ id, limitUsd: '1' })];
    // 20 concurrent $0.06 increments from three replicas = $1.2 (crosses 50%, 80% and 100%)
    for (let i = 0; i < 20; i++) guards[i % 3]?.record(b, '0.06', 1);
    await new Promise((r) => setTimeout(r, 300));
    const events = (await watcher.lrange(BUDGET_ALERTS_KEY, 0, -1))
      .map((l) => JSON.parse(l) as BudgetAlertEvent)
      .filter((e) => e.budgetId === id);
    expect(events.map((e) => e.threshold).sort((x, y) => x - y)).toEqual([50, 80, 100]);
    expect(events.every((e) => e.kind === 'usd' && e.limit === '1')).toBe(true);
    for (const line of await watcher.lrange(BUDGET_ALERTS_KEY, 0, -1))
      if (line.includes(id)) await watcher.lrem(BUDGET_ALERTS_KEY, 0, line);
  });

  it('end to end: the gateway answers budget_exceeded in each client format', async () => {
    const keyring = parseKeyring(generateKey());
    const pepper = 'p'.repeat(32);
    const KEY = 'dr-budget-e2e-0001';
    const mock = buildMock();
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const budgetId = `e2e-${randomUUID()}`;
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        {
          id: 'p',
          organizationId: 'org',
          slug: 'p',
          type: 'openai-compatible',
          name: 'p',
          baseUrl: `${mockRoot}/v1`,
          enabled: true,
          options: {},
          credentials: [
            { id: 'k', name: 'k', secret: encrypt(keyring, 'sk-x', 'k'), enabled: true },
          ],
        },
      ],
      // High price so we reach the cap with a few requests: each request is about $0.01.
      models: [
        {
          id: 'm',
          organizationId: 'org',
          slug: 'm',
          providerId: 'p',
          upstreamModel: 'mock-small',
          enabled: true,
          pricing: { inputPerMTok: '1000', outputPerMTok: '1000' },
          capabilities: {},
        },
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        {
          id: 'vk',
          hash: hashApiKey(KEY, pepper),
          prefix: 'dr-budg',
          organizationId: 'org',
          teamId: null,
          projectId: 'prj',
          enabled: true,
          expiresAt: null,
          budgets: [{ id: budgetId, period: 'monthly', limitUsd: '0.03' }],
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-budget-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    const gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: () => undefined,
      limiterRedis: conn(),
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    const base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
    try {
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 10 && statuses.at(-1) !== 429; i++) {
        last = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
        });
        statuses.push(last.status);
        if (last.status === 200) await last.text();
        await settle();
      }
      expect(statuses[0]).toBe(200);
      expect(statuses.at(-1)).toBe(429);
      expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(2);
      expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await last?.json()).toMatchObject({
        error: {
          type: 'insufficient_quota',
          code: 'budget_exceeded',
          message: 'Monthly key budget exceeded (USD 0.03)',
        },
      });
      const anthropic = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'm',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'x' }],
        }),
      });
      expect(anthropic.status).toBe(429);
      expect(await anthropic.json()).toMatchObject({
        type: 'error',
        error: { type: 'billing_error' },
      });
      expect(gw.budgets.stats.rejected).toBeGreaterThanOrEqual(2);
    } finally {
      await gw.app.close();
      await mock.close();
    }
  });
});
