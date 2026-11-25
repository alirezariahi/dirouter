/**
 * Organization, member, model and provider scopes, and weekly and yearly periods (card 33.1).
 * The scope resolution runs without Valkey; the request path, the fake-clock resets and the
 * overhead measurement run with INTEGRATION_VALKEY_URL.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type BudgetConfig,
  ConfigSnapshot,
  type ConfigSnapshotInput,
  type ScopeLimitConfig,
} from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import type { Candidate } from '@dirouter/routing';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BudgetGuard, type ScopedBudget } from './budget-guard.js';
import { RateLimiter } from './rate-limiter.js';
import { buildGateway } from './server.js';
import { admitRequest, budgetScopes, limitScopes } from './spend-guard.js';

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const logger = createLogger({ service: 'test', level: 'silent' });
const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const settle = () => new Promise((r) => setTimeout(r, 60));
/** Waits until a fire-and-forget budget write has landed. */
async function recorded(guard: BudgetGuard, write: () => void): Promise<void> {
  const before = guard.stats.recorded;
  write();
  for (let i = 0; i < 200 && guard.stats.recorded === before; i++) await settle();
}
/** A Valkey connection without an offline queue, once it is ready. */
async function connect(): Promise<Redis> {
  const redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false, lazyConnect: true });
  await redis.connect();
  return redis;
}

const provider = (id: string, organizationId: string, baseUrl: string) => ({
  id,
  organizationId,
  slug: id,
  type: 'openai-compatible' as const,
  name: id,
  baseUrl,
  enabled: true,
  options: {},
  credentials: [
    { id: `cred-${id}`, name: 'k', secret: encrypt(keyring, 'sk-x', `cred-${id}`), enabled: true },
  ],
});
// About $0.01 per request, so a few requests reach a cap of a few cents.
const model = (id: string, organizationId: string, providerId: string) => ({
  id,
  organizationId,
  slug: id,
  providerId,
  upstreamModel: 'mock-small',
  enabled: true,
  pricing: { inputPerMTok: '1000', outputPerMTok: '1000' },
  capabilities: {},
});
const vk = (
  raw: string,
  id: string,
  organizationId: string,
  projectId: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  hash: hashApiKey(raw, pepper),
  prefix: id,
  organizationId,
  teamId: null,
  projectId,
  enabled: true,
  expiresAt: null,
  ...extra,
});

describe('scope resolution', () => {
  const snapshot = ConfigSnapshot.parse({
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [provider('pa', 'a', 'http://x/v1'), provider('pb', 'b', 'http://x/v1')],
    models: [model('ma', 'a', 'pa'), model('mb', 'b', 'pb')],
    combos: [],
    aliases: [],
    virtualKeys: [],
    limits: [
      {
        organizationId: 'a',
        scope: 'organization',
        scopeId: 'a',
        rateLimit: { requestsPerMinute: 5 },
      },
      { organizationId: 'a', scope: 'user', scopeId: 'u1', rateLimit: { requestsPerMinute: 5 } },
      {
        organizationId: 'a',
        scope: 'model',
        scopeId: 'ma',
        rateLimit: { requestsPerMinute: 5 },
        budgets: [{ id: 'bud-ma', period: 'weekly', limitUsd: '1' }],
      },
      {
        organizationId: 'a',
        scope: 'provider',
        scopeId: 'pa',
        budgets: [{ id: 'bud-pa', period: 'yearly', limitTokens: 10 }],
      },
      // The same member in another organization has limits of its own.
      { organizationId: 'b', scope: 'user', scopeId: 'u1', rateLimit: { requestsPerMinute: 9 } },
      { organizationId: 'b', scope: 'organization', scopeId: 'b', budgets: [] },
    ],
    settings: {},
  } satisfies ConfigSnapshotInput);
  const config = { snapshot };
  const key = (organizationId: string, userId?: string) =>
    snapshot.virtualKeys[0] ??
    ({
      id: `k-${organizationId}`,
      hash: '0'.repeat(64),
      prefix: 'k',
      organizationId,
      teamId: null,
      projectId: 'p',
      enabled: true,
      expiresAt: null,
      allowedModels: [],
      ipAllowlist: [],
      budgets: [],
      mcpTools: [],
      ...(userId ? { userId } : {}),
    } as const);
  const candidate = (modelId: string, providerId: string) =>
    ({
      model: snapshot.models.find((m) => m.id === modelId),
      provider: snapshot.providers.find((p) => p.id === providerId),
      credential: snapshot.providers.find((p) => p.id === providerId)?.credentials[0],
    }) as Candidate;

  it('names every shared rate-limit counter with the organization', () => {
    const names = limitScopes(config, key('a', 'u1'), candidate('ma', 'pa')).map((s) => s.name);
    expect(names).toEqual(['org:a', 'user:a:u1', 'model:a:ma']);
    expect(limitScopes(config, key('b', 'u1')).map((s) => s.name)).toEqual(['user:b:u1']);
    // A key without a member gets no member scope; another organization's model is never matched.
    expect(limitScopes(config, key('a'), candidate('mb', 'pb')).map((s) => s.name)).toEqual([
      'org:a',
    ]);
  });

  it('model and provider budgets target their candidates instead of rejecting', () => {
    const budgets = budgetScopes(config, key('a'), [candidate('ma', 'pa'), candidate('ma', 'pa')]);
    expect(budgets.map((b) => [b.scope, b.budget.id, b.target])).toEqual([
      ['model', 'bud-ma', { modelId: 'ma' }],
      ['provider', 'bud-pa', { providerId: 'pa' }],
    ]);
  });
});

describe.skipIf(!VALKEY_URL)('weekly and yearly budgets reset on a fake clock', () => {
  let redis: Redis;
  beforeAll(async () => {
    redis = await connect();
  }, 60_000);
  afterAll(() => {
    redis.disconnect();
  });
  const scoped = (budget: Partial<BudgetConfig> & { id: string }): ScopedBudget => ({
    budget: { period: 'weekly', alertThresholds: [100], ...budget },
    scope: 'organization',
    scopeId: 'org',
    organizationId: 'org',
  });

  it('a weekly budget is exhausted until Monday 00:00 UTC and starts from zero then', async () => {
    let now = new Date('2026-11-29T23:59:00.000Z'); // a Sunday
    const guard = new BudgetGuard({ redis, logger, failMode: () => 'open', clock: () => now });
    const b = [scoped({ id: `wk-${randomUUID()}`, limitUsd: '1' })];
    expect(await guard.check(b)).toEqual({ ok: true });
    await recorded(guard, () => {
      guard.record(b, '1', 10);
    });
    expect(await guard.check(b)).toEqual({
      ok: false,
      scope: 'organization',
      period: 'weekly',
      kind: 'usd',
      limit: '1',
      resetAt: new Date('2026-11-30T00:00:00.000Z'),
    });
    now = new Date('2026-11-30T00:00:01.000Z');
    expect(await guard.check(b)).toEqual({ ok: true });
    // The same week from its Monday to its Sunday shares one counter.
    await recorded(guard, () => {
      guard.record(b, '1', 10);
    });
    now = new Date('2026-12-06T23:59:59.000Z');
    expect(await guard.check(b)).toMatchObject({ ok: false, period: 'weekly' });
  });

  it('a yearly budget runs to 1 January UTC', async () => {
    let now = new Date('2026-03-01T00:00:00.000Z');
    const guard = new BudgetGuard({ redis, logger, failMode: () => 'open', clock: () => now });
    const b = [scoped({ id: `yr-${randomUUID()}`, period: 'yearly', limitTokens: 100 })];
    await recorded(guard, () => {
      guard.record(b, '0', 100);
    });
    now = new Date('2026-12-31T23:59:59.000Z');
    expect(await guard.check(b)).toMatchObject({
      ok: false,
      kind: 'tokens',
      resetAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    now = new Date('2027-01-01T00:00:00.000Z');
    expect(await guard.check(b)).toEqual({ ok: true });
  });
});

describe.skipIf(!VALKEY_URL)(
  'organization, member, model and provider scopes on the request path',
  () => {
    const mock = buildMock();
    let redis: Redis;
    let gw: ReturnType<typeof buildGateway>;
    let base = '';
    const KEYS = {
      acmeA: 'dr-scope33-acme-a1',
      acmeB: 'dr-scope33-acme-b1',
      betaU1: 'dr-scope33-beta-u1',
      betaU2: 'dr-scope33-beta-u2',
      betaFree: 'dr-scope33-beta-f1',
      gammaU1: 'dr-scope33-gamma-u1',
    };

    beforeAll(async () => {
      redis = await connect();
      // Rate windows of an earlier run (same scope names) would still be open.
      const stale = await redis.keys('dirouter:rl:*:beta:*');
      if (stale.length > 0) await redis.del(...stale);
      await mock.listen({ port: 0, host: '127.0.0.1' });
      const ma = mock.server.address();
      const upstream = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}/v1`;
      const run = randomUUID();
      const limits: ScopeLimitConfig[] = [
        {
          organizationId: 'acme',
          scope: 'organization',
          scopeId: 'acme',
          budgets: [
            { id: `bud-org-${run}`, period: 'monthly', limitUsd: '0.03', alertThresholds: [100] },
          ],
        },
        {
          organizationId: 'beta',
          scope: 'user',
          scopeId: 'u1',
          budgets: [
            { id: `bud-u1-${run}`, period: 'daily', limitUsd: '0.03', alertThresholds: [] },
          ],
        },
        {
          organizationId: 'beta',
          scope: 'model',
          scopeId: 'pricey',
          budgets: [
            { id: `bud-pricey-${run}`, period: 'weekly', limitUsd: '0.03', alertThresholds: [] },
          ],
        },
        {
          organizationId: 'beta',
          scope: 'provider',
          scopeId: 'pc',
          rateLimit: { requestsPerMinute: 2 },
          budgets: [],
        },
      ];
      const snapshot: ConfigSnapshotInput = {
        schemaVersion: 1,
        version: 1,
        generatedAt: new Date().toISOString(),
        providers: [
          provider('pacme', 'acme', upstream),
          provider('pa', 'beta', upstream),
          provider('pb', 'beta', upstream),
          provider('pc', 'beta', upstream),
          provider('pgamma', 'gamma', upstream),
        ],
        models: [
          model('acme-m', 'acme', 'pacme'),
          model('pricey', 'beta', 'pb'),
          model('cheap', 'beta', 'pa'),
          model('via-c', 'beta', 'pc'),
          model('gamma-m', 'gamma', 'pgamma'),
        ],
        combos: [
          {
            id: 'combo-smart',
            organizationId: 'beta',
            slug: 'smart',
            strategy: 'priority',
            targets: [
              { modelId: 'pricey', order: 0 },
              { modelId: 'cheap', order: 1 },
            ],
          },
        ],
        aliases: [],
        virtualKeys: [
          vk(KEYS.acmeA, 'vk-acme-a', 'acme', 'prj-acme-a'),
          vk(KEYS.acmeB, 'vk-acme-b', 'acme', 'prj-acme-b', { teamId: 'team-acme' }),
          vk(KEYS.betaU1, 'vk-beta-u1', 'beta', 'prj-beta', { userId: 'u1' }),
          vk(KEYS.betaU2, 'vk-beta-u2', 'beta', 'prj-beta', { userId: 'u2' }),
          vk(KEYS.betaFree, 'vk-beta-free', 'beta', 'prj-beta-2'),
          // The same member in another organization: beta's member budget must not reach it.
          vk(KEYS.gammaU1, 'vk-gamma-u1', 'gamma', 'prj-gamma', { userId: 'u1' }),
        ],
        limits,
        settings: {},
      };
      const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-budget-scopes-'));
      await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
      gw = buildGateway({
        logger,
        keyring,
        pepper,
        dataDir,
        emitUsage: () => undefined,
        limiterRedis: redis,
      });
      await gw.start();
      await gw.app.listen({ port: 0, host: '127.0.0.1' });
      const ga = gw.app.server.address();
      base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
    }, 60_000);

    afterAll(async () => {
      await gw.app.close();
      await mock.close();
      redis.disconnect();
    });

    const chat = async (raw: string, modelName: string) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      await settle();
      return { status: res.status, body, model: res.headers.get('x-dirouter-model') };
    };
    const untilRefused = async (raw: string, modelName: string) => {
      const statuses: number[] = [];
      for (let i = 0; i < 10 && statuses.at(-1) !== 429; i++)
        statuses.push((await chat(raw, modelName)).status);
      return statuses;
    };

    it('a monthly organization budget stops every key of the organization and no other', async () => {
      const statuses = await untilRefused(KEYS.acmeA, 'acme-m');
      expect(statuses[0]).toBe(200);
      expect(statuses.at(-1)).toBe(429);
      // A key of another project and team, which never spent anything, is stopped as well.
      const sibling = await chat(KEYS.acmeB, 'acme-m');
      expect(sibling.status).toBe(429);
      expect(sibling.body.error).toMatchObject({
        code: 'budget_exceeded',
        message: 'Monthly organization budget exceeded (USD 0.03)',
      });
      expect((await chat(KEYS.betaFree, 'cheap')).status).toBe(200);
      expect((await chat(KEYS.gammaU1, 'gamma-m')).status).toBe(200);
    });

    it("a member budget stops that member's keys only, and only in its organization", async () => {
      const statuses = await untilRefused(KEYS.betaU1, 'cheap');
      expect(statuses.at(-1)).toBe(429);
      expect((await chat(KEYS.betaU1, 'cheap')).body.error?.message).toBe(
        'Daily user budget exceeded (USD 0.03)',
      );
      expect((await chat(KEYS.betaU2, 'cheap')).status).toBe(200);
      expect((await chat(KEYS.gammaU1, 'gamma-m')).status).toBe(200);
    });

    it('a used-up model budget takes the model out of a combo, and refuses the model itself', async () => {
      const served: (string | null)[] = [];
      for (let i = 0; i < 10 && served.at(-1) !== 'cheap'; i++) {
        const res = await chat(KEYS.betaU2, 'smart');
        expect(res.status).toBe(200);
        served.push(res.model);
      }
      expect(served[0]).toBe('pricey');
      expect(served.at(-1)).toBe('cheap');
      const direct = await chat(KEYS.betaU2, 'pricey');
      expect(direct.status).toBe(429);
      expect(direct.body.error).toMatchObject({
        code: 'budget_exceeded',
        message: "Weekly model budget exceeded for every target of 'pricey'",
      });
      expect((await chat(KEYS.betaU2, 'cheap')).status).toBe(200);
    });

    it('a provider rate limit counts every key of the organization on that provider', async () => {
      expect((await chat(KEYS.betaU2, 'via-c')).status).toBe(200);
      expect((await chat(KEYS.betaFree, 'via-c')).status).toBe(200);
      const third = await chat(KEYS.betaU2, 'via-c');
      expect(third.status).toBe(429);
      expect(third.body.error?.message).toBe('Rate limit exceeded for provider (requests)');
      expect((await chat(KEYS.betaFree, 'cheap')).status).toBe(200);
    });
  },
);

describe.skipIf(!VALKEY_URL)('cost of the extra scopes', () => {
  let redis: Redis;
  beforeAll(async () => {
    redis = await connect();
  }, 60_000);
  afterAll(() => {
    redis.disconnect();
  });

  it('adding organization, member, model and provider scopes costs under 0.3 ms per check', async () => {
    const run = randomUUID();
    const wide = { requestsPerMinute: 10_000_000, tokensPerMinute: 1_000_000_000 };
    const budget = (id: string): BudgetConfig[] => [
      { id: `${id}-${run}`, period: 'monthly', limitUsd: '1000000', alertThresholds: [] },
    ];
    const shared = (scope: ScopeLimitConfig['scope'], scopeId: string): ScopeLimitConfig => ({
      organizationId: 'org',
      scope,
      scopeId,
      rateLimit: wide,
      budgets: budget(scope),
    });
    const build = (limits: ScopeLimitConfig[]) =>
      ConfigSnapshot.parse({
        schemaVersion: 1,
        version: 1,
        generatedAt: new Date().toISOString(),
        providers: [provider('p', 'org', 'http://x/v1')],
        models: [model('m', 'org', 'p')],
        combos: [],
        aliases: [],
        virtualKeys: [
          vk('dr-overhead-key-0001', 'vk', 'org', 'prj', {
            teamId: 'team',
            userId: 'usr',
            rateLimit: wide,
            budgets: budget('key'),
          }),
        ],
        limits,
        settings: {},
      } satisfies ConfigSnapshotInput);
    const before = build([shared('team', 'team'), shared('project', 'prj')]);
    const after = build([
      shared('team', 'team'),
      shared('project', 'prj'),
      shared('organization', 'org'),
      shared('user', 'usr'),
      shared('model', 'm'),
      shared('provider', 'p'),
    ]);
    const deps = {
      budgets: new BudgetGuard({ redis, logger, failMode: () => 'open' }),
      limiter: new RateLimiter({ redis, logger, failMode: () => 'open' }),
    };
    const admitOnce = async (snapshot: ConfigSnapshot) => {
      const key = snapshot.virtualKeys[0];
      const p = snapshot.providers[0];
      const m = snapshot.models[0];
      if (!key || !p || !m) throw new Error('fixture');
      const admission = await admitRequest(deps, {
        config: { snapshot },
        key,
        candidates: [{ model: m, provider: p, credential: p.credentials[0] } as Candidate],
        requested: 'm',
        estimatedTokens: 100,
        requestId: randomUUID(),
      });
      if (!admission.ok) throw new Error('refused');
      admission.cancel();
    };
    /** Valkey's own time spent in the commands an admission sends (scripts and reads), in µs. */
    const serverMicros = async () => {
      const info = await redis.info('commandstats');
      let total = 0;
      for (const m of info.matchAll(/^cmdstat_(\w+):calls=\d+,usec=(\d+)/gm))
        if (/^(evalsha|eval|zrem)$/.test(m[1] ?? '')) total += Number(m[2]);
      return total;
    };
    // Gateway CPU (scope resolution, script arguments, encoding) plus Valkey CPU per admission:
    // what the extra scopes add, without the network wait, which they do not change (still one
    // pipelined read and one script call).
    const cost = async (snapshot: ConfigSnapshot, n: number) => {
      const server = await serverMicros();
      const cpu = process.cpuUsage();
      for (let i = 0; i < n; i++) await admitOnce(snapshot);
      const used = process.cpuUsage(cpu);
      return {
        gatewayMs: (used.user + used.system) / 1000 / n,
        valkeyMs: ((await serverMicros()) - server) / 1000 / n,
      };
    };
    await cost(before, 50);
    await cost(after, 50);
    const n = 400;
    const narrow = await cost(before, n);
    const widened = await cost(after, n);
    const overhead = widened.gatewayMs + widened.valkeyMs - (narrow.gatewayMs + narrow.valkeyMs);
    const show = (c: { gatewayMs: number; valkeyMs: number }) =>
      `gateway ${c.gatewayMs.toFixed(3)} ms + Valkey ${c.valkeyMs.toFixed(3)} ms`;
    // Printed so a run shows the numbers (vitest --silent=false).
    process.stdout.write(
      `per admission: key, team and project: ${show(narrow)}; with organization, member, model and provider: ${show(widened)}\n`,
    );
    expect(overhead, `${show(narrow)} → ${show(widened)}`).toBeLessThan(0.3);
  }, 120_000);
});
