/** Shadow traffic (card 32.4): mirrored after the answer, billed apart, never seen by the client. */
import { randomUUID } from 'node:crypto';

import {
  budgetCounterKey,
  budgetPeriodKey,
  type ShadowPolicyConfig,
  shadowSpendKey,
  usdToUnits,
} from '@dirouter/contracts';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ownShadowModel, shadowPolicyFor } from './shadow.js';
import { KEYS, policyGateway, type PolicyGateway } from './testing/policy-kit.js';

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

const policy = (over: Partial<ShadowPolicyConfig>): ShadowPolicyConfig => ({
  id: 'shd_1',
  organizationId: 'org',
  name: 'try the slow one',
  enabled: true,
  match: 'mid',
  target: 'shadow-slow',
  sampleRate: 1,
  dailyBudgetUsd: '10',
  timeoutMs: 10_000,
  ...over,
});

const until = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('shadow traffic', () => {
  let env: PolicyGateway;

  beforeAll(async () => {
    env = await policyGateway({
      shadowPolicies: [
        policy({}),
        policy({ id: 'shd_broken', match: 'cheap', target: 'shadow-broken' }),
        policy({ id: 'shd_other', organizationId: 'org-2', match: '*', target: 'big' }),
      ],
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it('answers at the primary speed while the slow shadow model is still running', async () => {
    const started = Date.now();
    const res = await env.chat(KEYS.teamA, 'mid');
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-model')).toBe('mid');
    // The shadow model takes 1.5 s; the client is long gone by then.
    expect(elapsed).toBeLessThan(1_000);
    const primary = env.usage.at(-1);
    expect(primary?.shadow).toBeUndefined();
    expect(env.gw.shadow.inFlight).toBe(1);
    await until(() => env.usage.some((e) => e.shadow?.primaryRequestId === primary?.requestId));
    const shadow = env.usage.find((e) => e.shadow?.primaryRequestId === primary?.requestId);
    expect(shadow).toMatchObject({
      requestId: `${primary?.requestId ?? ''}:shadow`,
      organizationId: 'org',
      virtualKeyId: 'vk-a',
      resolvedModelId: 'org-shadow-slow',
      status: 'success',
      chargeUsd: '0.00000000',
      shadow: { policyId: 'shd_1', primaryModel: 'mid', primaryStatus: 200 },
    });
    expect(Number(shadow?.costUsd)).toBeGreaterThan(0);
    expect(shadow?.latencyMs).toBeGreaterThanOrEqual(1_400);
    expect(shadow?.shadow?.primaryLatencyMs).toBeLessThan(1_000);
    expect(shadow?.shadow?.primaryCostUsd).toBe(primary?.costUsd);
  });

  it('a failing shadow model changes nothing for the client', async () => {
    const res = await env.chat(KEYS.teamA, 'cheap');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ object: 'chat.completion', model: 'cheap' });
    const primary = env.usage.at(-1);
    await until(() => env.usage.some((e) => e.shadow?.primaryRequestId === primary?.requestId));
    const shadow = env.usage.find((e) => e.shadow?.primaryRequestId === primary?.requestId);
    expect(shadow).toMatchObject({ status: 'error', costUsd: '0', chargeUsd: '0.00000000' });
    expect(shadow?.httpStatus).toBeGreaterThanOrEqual(500);
  });

  it('mirrors a streamed request once the stream has ended, and the stream is untouched', async () => {
    const res = await fetch(`${env.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEYS.teamA}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mid',
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
      }),
    });
    const text = await res.text();
    expect(text).toContain('data: [DONE]');
    const primary = env.usage.filter((e) => !e.shadow).at(-1);
    expect(primary?.stream).toBe(true);
    await until(() => env.usage.some((e) => e.shadow?.primaryRequestId === primary?.requestId));
  });

  it("never mirrors another organization's requests, and only its own models", async () => {
    const before = env.usage.filter((e) => e.shadow).length;
    await env.chat(KEYS.teamA, 'big');
    await new Promise((r) => setTimeout(r, 200));
    expect(env.usage.filter((e) => e.shadow).length).toBe(before);
    const config = env.gw.store.current;
    if (!config) throw new Error('no config');
    expect(ownShadowModel(config, 'org', 'shadow-slow')?.id).toBe('org-shadow-slow');
    expect(ownShadowModel(config, 'org-2', 'shadow-slow')).toBeUndefined();
    // A public marketplace model is visible to the organization but never a shadow target.
    await env.publish({
      platformOrganizationId: 'org-2',
      models: [
        ...config.snapshot.models,
        {
          id: 'org-2-pub',
          organizationId: 'org-2',
          slug: 'pub',
          providerId: 'p2',
          upstreamModel: 'mock-small',
          enabled: true,
          public: true,
          pricing: { inputPerMTok: '1', outputPerMTok: '1' },
          capabilities: {},
        },
      ],
    });
    const next = env.gw.store.current;
    if (!next) throw new Error('no config');
    expect(next.router.index.lookup('org', 'pub')).toBeDefined();
    expect(ownShadowModel(next, 'org', 'pub')).toBeUndefined();
  });

  it('samples by the policy rate and matches by name, project and organization', () => {
    const snapshot = env.gw.store.current?.snapshot;
    if (!snapshot) throw new Error('no snapshot');
    const key = snapshot.virtualKeys.find((k) => k.id === 'vk-a');
    if (!key) throw new Error('no key');
    const with_ = (p: Partial<ShadowPolicyConfig>) => ({
      ...snapshot,
      shadowPolicies: [policy(p)],
    });
    expect(shadowPolicyFor(with_({ sampleRate: 0.25 }), key, 'mid', () => 0.2)?.id).toBe('shd_1');
    expect(shadowPolicyFor(with_({ sampleRate: 0.25 }), key, 'mid', () => 0.3)).toBeUndefined();
    expect(shadowPolicyFor(with_({ match: '*' }), key, 'anything')?.id).toBe('shd_1');
    expect(shadowPolicyFor(with_({ projectId: 'prj-x' }), key, 'mid')).toBeUndefined();
    expect(shadowPolicyFor(with_({ enabled: false }), key, 'mid')).toBeUndefined();
    expect(shadowPolicyFor(with_({ organizationId: 'org-2' }), key, 'mid')).toBeUndefined();
  });
});

describe.skipIf(!VALKEY_URL)('shadow cost', () => {
  const redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: true });
  const budgetId = `bud-shadow-${randomUUID()}`;
  const policyId = `shd_${randomUUID().slice(0, 8)}`;
  let env: PolicyGateway;

  beforeAll(async () => {
    env = await policyGateway(
      {
        shadowPolicies: [
          // The cap is one shadow request's worth: the second one waits for tomorrow.
          policy({ id: policyId, target: 'big', dailyBudgetUsd: '0.00000001' }),
        ],
      },
      { redis, budgetId },
    );
  });
  afterAll(async () => {
    await env.close();
    await redis.del(budgetCounterKey(budgetId, budgetPeriodKey('monthly')));
    await redis.del(shadowSpendKey(policyId, new Date().toISOString().slice(0, 10)));
    redis.disconnect();
  });

  it("is never taken from the customer's budget, and stops at its own daily cap", async () => {
    const res = await env.chat(KEYS.teamA, 'mid');
    expect(res.status).toBe(200);
    const primary = env.usage.at(-1);
    await until(() => env.usage.some((e) => e.shadow?.primaryRequestId === primary?.requestId));
    const shadow = env.usage.find((e) => e.shadow?.primaryRequestId === primary?.requestId);
    expect(Number(shadow?.costUsd)).toBeGreaterThan(Number(primary?.costUsd));
    await new Promise((r) => setTimeout(r, 100));
    // The team's budget counter holds the client's request only.
    const counted = await redis.hget(budgetCounterKey(budgetId, budgetPeriodKey('monthly')), 'usd');
    expect(Number(counted)).toBe(usdToUnits(primary?.costUsd ?? '0'));
    // The shadow policy's own counter holds the shadow's cost and is over the cap now.
    const day = new Date().toISOString().slice(0, 10);
    expect(Number(await redis.get(shadowSpendKey(policyId, day)))).toBe(
      usdToUnits(shadow?.costUsd ?? '0'),
    );
    const shadows = () => env.usage.filter((e) => e.shadow).length;
    const before = shadows();
    expect((await env.chat(KEYS.teamA, 'mid')).status).toBe(200);
    await until(() => env.gw.shadow.inFlight === 0);
    expect(shadows()).toBe(before);
    expect(env.gw.shadow.stats.overBudget).toBe(1);
  });
});

describe('shadow traffic under a data policy', () => {
  let env: PolicyGateway;

  beforeAll(async () => {
    env = await policyGateway({
      shadowPolicies: [policy({ id: 'shd_zdr', match: 'mid', target: 'shadow-slow' })],
      // "ZDR only" for the whole organization (card 32.5).
      routingPolicies: [
        {
          organizationId: 'org',
          scope: 'organization',
          scopeId: 'org',
          dataPolicy: { requireZdr: true },
        },
      ],
    });
    const config = env.gw.store.current;
    if (!config) throw new Error('no config');
    // The primary's provider offers zero data retention; the shadow model's does not.
    await env.publish({
      providers: config.snapshot.providers.map((p) =>
        p.id === 'p' ? { ...p, dataPolicy: { zdr: true } } : p,
      ),
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it('never sends the copy to a provider the policy rules out, and counts it as skipped', async () => {
    const res = await env.chat(KEYS.teamA, 'mid');
    expect(res.status).toBe(200);
    const primary = env.usage.at(-1);
    await until(() => env.gw.shadow.stats.policySkipped === 1);
    await until(() => env.gw.shadow.inFlight === 0);
    expect(env.gw.shadow.stats.started).toBe(0);
    expect(env.usage.some((e) => e.shadow?.primaryRequestId === primary?.requestId)).toBe(false);
  });
});
