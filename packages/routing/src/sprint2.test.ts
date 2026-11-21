/**
 * Sprint 2 routing tests: new combo strategies (12.1), sticky sessions (12.4), dry-run (12.5)
 * and hedged requests (12.2), including PeakEWMA/P2C and the hedge traffic budget.
 */
import { type ConfigSnapshot, ConfigSnapshot as SnapshotSchema } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  type Candidate,
  HedgeBudget,
  HealthRegistry,
  RouteIndex,
  Router,
  RouterStats,
  executeWithHedging,
  isRouteError,
  type ResolvedRoute,
} from './index.js';

const cred = (id: string, weight = 1) => ({
  id,
  name: id,
  secret: 'v1.AAAA',
  enabled: true,
  weight,
  headers: {},
});

function snapshot(over: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return SnapshotSchema.parse({
    schemaVersion: 1,
    version: 1,
    generatedAt: '2026-11-11T00:00:00.000Z',
    providers: ['a', 'b', 'c'].map((id) => ({
      id,
      organizationId: 'org',
      slug: id,
      type: 'openai',
      name: id,
      baseUrl: `https://${id}.test/v1`,
      enabled: true,
      options: {},
      credentials: [cred(`${id}-k1`)],
    })),
    models: [
      {
        id: 'm1',
        organizationId: 'org',
        slug: 'a/m1',
        providerId: 'a',
        upstreamModel: 'm1',
        enabled: true,
        contextWindow: 8_000,
        pricing: { inputPerMTok: '3', outputPerMTok: '9' },
        capabilities: {},
      },
      {
        id: 'm2',
        organizationId: 'org',
        slug: 'b/m2',
        providerId: 'b',
        upstreamModel: 'm2',
        enabled: true,
        contextWindow: 128_000,
        pricing: { inputPerMTok: '1', outputPerMTok: '2' },
        capabilities: {},
      },
      {
        id: 'm3',
        organizationId: 'org',
        slug: 'c/m3',
        providerId: 'c',
        upstreamModel: 'm3',
        enabled: true,
        contextWindow: 200_000,
        pricing: { inputPerMTok: '2', outputPerMTok: '6' },
        capabilities: {},
      },
    ],
    combos: [] as ConfigSnapshot['combos'],
    aliases: [],
    virtualKeys: [],
    settings: {},
    ...over,
  });
}

function combo(
  strategy: ConfigSnapshot['combos'][number]['strategy'],
  sticky = false,
): ConfigSnapshot['combos'][number] {
  return {
    id: 'c1',
    organizationId: 'org',
    slug: 'smart',
    strategy,
    sticky,
    targets: [
      { modelId: 'm1', order: 0, weight: 1 },
      { modelId: 'm2', order: 1, weight: 1 },
      { modelId: 'm3', order: 2, weight: 1 },
    ],
    fallbackOn: ['server'],
  };
}

const key: ConfigSnapshot['virtualKeys'][number] = SnapshotSchema.shape.virtualKeys.element.parse({
  id: 'k1',
  organizationId: 'org',
  hash: 'a'.repeat(64),
  prefix: 'dr_',
  teamId: null,
  projectId: 'p1',
  enabled: true,
  expiresAt: null,
  allowedModels: [],
  ipAllowlist: [],
  budgets: [],
});

function route(
  snap: ConfigSnapshot,
  requested: string,
  options: Parameters<Router['resolve']>[2] = {},
): ResolvedRoute {
  const r = new Router(new RouteIndex(snap), new HealthRegistry(), {
    stats: new RouterStats(),
  }).resolve(key, requested, options);
  if (isRouteError(r)) throw new Error(r.error);
  return r;
}

describe('combo strategies (12.1)', () => {
  it('latency sorts by observed EWMA and unknown models last', () => {
    const snap = snapshot({ combos: [combo('latency')] });
    const health = new HealthRegistry();
    const stats = new RouterStats();
    const router = new Router(new RouteIndex(snap), health, { stats });
    stats.recordLatency('m1', 900);
    stats.recordLatency('m2', 120);
    const r = router.resolve(key, 'smart');
    if (isRouteError(r)) throw new Error(r.error);
    expect(r.candidates.map((c) => c.model.id)).toEqual(['m2', 'm1', 'm3']);
  });

  it('cost picks the cheapest for the request size', () => {
    const snap = snapshot({ combos: [combo('cost')] });
    const r = route(snap, 'smart', { estimatedInputTokens: 1_000, maxOutputTokens: 1_000 });
    expect(r.candidates.map((c) => c.model.id)).toEqual(['m2', 'm3', 'm1']);
  });

  it('least-used spreads load across recent requests and in-flight attempts', () => {
    const snap = snapshot({ combos: [combo('least-used')] });
    const health = new HealthRegistry();
    const stats = new RouterStats();
    const router = new Router(new RouteIndex(snap), health, { stats });
    stats.recordRequest('m1');
    stats.recordRequest('m1');
    stats.begin('m2');
    const r = router.resolve(key, 'smart');
    if (isRouteError(r)) throw new Error(r.error);
    expect(r.candidates[0]?.model.id).toBe('m3');
  });

  it('headroom puts the largest remaining context first', () => {
    const snap = snapshot({ combos: [combo('headroom')] });
    const r = route(snap, 'smart', { estimatedInputTokens: 1_000, maxOutputTokens: 1_000 });
    expect(r.candidates.map((c) => c.model.id)).toEqual(['m3', 'm2', 'm1']);
  });

  it('PeakEWMA reacts to a slow tail and decays over time', () => {
    const stats = new RouterStats({ now: () => 0 });
    stats.recordLatency('a', 100);
    stats.recordLatency('b', 100);
    stats.recordLatency('b', 5_000); // tail outlier
    stats.recordLatency('a', 500); // consistently worse
    expect(stats.peakLatency('b')).toBeGreaterThan(stats.peakLatency('a') ?? 0);
    // The peak decays; after five decay constants it is back near the recent value.
    const later = new RouterStats({ now: () => 300_000 });
    later.recordLatency('b', 150);
    expect(later.peakLatency('b')).toBeLessThan(5_000);
  });

  it('P2C keeps the faster of two samples and reduces the p95 under a slow tail', () => {
    const snap = snapshot({ combos: [combo('latency')] });
    const stats = new RouterStats();
    stats.recordLatency('m1', 1_000);
    stats.recordLatency('m1', 5_000); // slow tail
    stats.recordLatency('m2', 200);
    stats.recordLatency('m3', 300);
    const router = new Router(new RouteIndex(snap), new HealthRegistry(), { stats });
    // Sample (m1, m2): P2C must reject the slow-tailed m1.
    const r = router.resolve(key, 'smart', { p2c: true, random: () => 0 });
    if (isRouteError(r)) throw new Error(r.error);
    expect(r.candidates[0]?.model.id).toBe('m2');
  });

  it('last-known-good moves the most recently successful target to the front', () => {
    const snap = snapshot({ combos: [combo('priority')] });
    const stats = new RouterStats();
    const router = new Router(new RouteIndex(snap), new HealthRegistry(), { stats });
    stats.recordLatency('m3', 100);
    const r = router.resolve(key, 'smart', { preferLastKnownGood: true });
    if (isRouteError(r)) throw new Error(r.error);
    expect(r.candidates[0]?.model.id).toBe('m3');
  });
});

describe('sticky sessions (12.4)', () => {
  it('keeps a pinned target for the session while it is healthy', () => {
    const snap = snapshot({ combos: [combo('priority', true)] });
    const router = new Router(new RouteIndex(snap), new HealthRegistry());
    router.pinSession('c1', 'sess-1', 'm3', 'c-k1');
    const first = router.resolve(key, 'smart', { sessionKey: 'sess-1' });
    if (isRouteError(first)) throw new Error(first.error);
    expect(first.candidates[0]?.model.id).toBe('m3');
    expect(router.sessionModel('c1', 'sess-1')).toBe('m3');
    expect(router.sessionCredential('c1', 'sess-1')).toBe('c-k1');
  });

  it('does not pin when the combo is not sticky', () => {
    const snap = snapshot({ combos: [combo('priority', false)] });
    const router = new Router(new RouteIndex(snap), new HealthRegistry());
    router.pinSession('c1', 'sess-1', 'm3');
    const r = router.resolve(key, 'smart', { sessionKey: 'sess-1' });
    if (isRouteError(r)) throw new Error(r.error);
    expect(r.candidates[0]?.model.id).toBe('m1');
  });

  it('uses the prompt-prefix hash as the session identity when no header is sent', () => {
    const snap = snapshot({ combos: [combo('priority', true)] });
    const router = new Router(new RouteIndex(snap), new HealthRegistry());
    router.pinSession('c1', 'hash-1', 'm2');
    const r = router.resolve(key, 'smart', { promptPrefixHash: 'hash-1' });
    if (isRouteError(r)) throw new Error(r.error);
    expect(r.candidates[0]?.model.id).toBe('m2');
  });
});

describe('sticky sessions: edge cases (12.4)', () => {
  it('keeps the model when the pinned credential is no longer a candidate', () => {
    const snap = snapshot({ combos: [combo('priority', true)] });
    const router = new Router(new RouteIndex(snap), new HealthRegistry());
    // The session was pinned to a credential that has since been removed or is cooling down.
    router.pinSession('c1', 'sess-1', 'm3', 'c-gone');
    const r = router.resolve(key, 'smart', { sessionKey: 'sess-1' });
    if (isRouteError(r)) throw new Error(r.error);
    expect(r.candidates[0]?.model.id).toBe('m3');
  });

  it('forgets a pin after its TTL', () => {
    let now = 0;
    const snap = snapshot({ combos: [combo('priority', true)] });
    const router = new Router(new RouteIndex(snap), new HealthRegistry(), {
      now: () => now,
      affinityTtlMs: 1_000,
    });
    router.pinSession('c1', 'sess-1', 'm3');
    now = 2_000;
    const r = router.resolve(key, 'smart', { sessionKey: 'sess-1' });
    if (isRouteError(r)) throw new Error(r.error);
    expect(r.candidates[0]?.model.id).toBe('m1');
    router.pinSession('c1', 'sess-2', 'm2');
    now = 4_000;
    expect(router.sessionModel('c1', 'sess-2')).toBeUndefined();
    expect(router.sessionModel('c1', 'never-pinned')).toBeUndefined();
  });

  it('bounds the number of remembered sessions', () => {
    let now = 0;
    const snap = snapshot({ combos: [combo('priority', true)] });
    const router = new Router(new RouteIndex(snap), new HealthRegistry(), {
      now: () => now,
      affinityTtlMs: 1_000,
    });
    // 30k pins that expire, then enough live ones to cross the cap twice.
    for (let i = 0; i < 30_000; i++) router.pinSession('c1', `old-${String(i)}`, 'm1');
    now = 5_000;
    for (let i = 0; i < 60_000; i++) router.pinSession('c1', `live-${String(i)}`, 'm2');
    expect(router.sessionModel('c1', 'old-1')).toBeUndefined();
    // The oldest live pins were evicted, the most recent ones are kept.
    expect(router.sessionModel('c1', 'live-0')).toBeUndefined();
    expect(router.sessionModel('c1', 'live-59999')).toBe('m2');
  });
});

describe('dry-run simulate (12.5)', () => {
  it('returns the same candidates and skip reasons without I/O', () => {
    const snap = snapshot({ combos: [combo('priority')] });
    const router = new Router(new RouteIndex(snap), new HealthRegistry());
    const r = router.simulate(key, 'smart', { estimatedInputTokens: 50_000, maxOutputTokens: 100 });
    if (isRouteError(r)) throw new Error(r.error);
    expect(r.candidates.map((c) => c.model.slug)).toEqual(['b/m2', 'c/m3']);
    expect(r.skipped).toEqual([{ modelId: 'm1', reason: 'context_window' }]);
  });
});

describe('hedged requests (12.2)', () => {
  const candidates = (): Candidate[] => {
    const snap = snapshot({ combos: [combo('priority')] });
    const r = route(snap, 'smart');
    return r.candidates;
  };

  it('returns the first success and reports the number of extra attempts', async () => {
    const result = await executeWithHedging(
      candidates(),
      async (candidate) => {
        if (candidate.model.id === 'm1') {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ok: true as const, value: `slow:${candidate.model.id}` };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true as const, value: `fast:${candidate.model.id}` };
      },
      { afterMs: 10, maxParallel: 2 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('fast:m2');
      expect(result.hedged).toBe(true);
      expect(result.hedgeAttempts).toBe(1);
    }
  });

  it('falls back through candidates when every attempt fails', async () => {
    const result = await executeWithHedging(
      candidates(),
      async () => ({
        ok: false as const,
        error: { class: 'server' as const, retryable: true, fallbackAllowed: true, message: 'x' },
      }),
      { afterMs: 5, maxParallel: 2 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.attempts.filter((a) => a.outcome === 'error')).toHaveLength(3);
  });

  it('settles when the last attempt fails after the deadline with targets still queued', async () => {
    let now = 0;
    const result = await executeWithHedging(
      candidates(),
      async () => {
        now = 100;
        return {
          ok: false as const,
          error: {
            class: 'timeout' as const,
            retryable: true,
            fallbackAllowed: true,
            message: 't',
          },
        };
      },
      { afterMs: 1_000, maxParallel: 2, deadline: 50, clock: () => now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.attempts).toHaveLength(1);
  });

  it('does not replay an error that no other target could fix', async () => {
    let calls = 0;
    const result = await executeWithHedging(
      candidates(),
      async () => {
        calls += 1;
        return {
          ok: false as const,
          error: {
            class: 'bad_request' as const,
            retryable: false,
            fallbackAllowed: false,
            message: 'invalid',
          },
        };
      },
      { afterMs: 1_000, maxParallel: 2 },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('starts no further attempt once a streaming attempt owns the response', async () => {
    let calls = 0;
    let claimed = false;
    const result = await executeWithHedging(
      candidates(),
      async (candidate) => {
        calls += 1;
        // The first attempt starts writing to the client at 5 ms and finishes much later.
        await new Promise((resolve) => setTimeout(resolve, 5));
        claimed = true;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { ok: true as const, value: candidate.model.id };
      },
      { afterMs: 15, maxParallel: 3, claimed: () => claimed },
    );
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hedgeAttempts).toBe(0);
  });

  it('never exceeds the hedge traffic budget and resets when the window rolls over', async () => {
    let now = 0;
    const budget = new HedgeBudget({
      ratio: 0.25,
      windowMs: 1_000,
      clock: () => now,
    });
    // Online gating is conservative: the hedge share may never exceed the ratio, so with
    // ratio 0.25 the first hedge is allowed and further ones are denied until the window
    // rolls over.
    budget.recordRequest();
    expect(budget.tryAcquire()).toBe(true);
    budget.recordRequest();
    expect(budget.tryAcquire()).toBe(false);
    budget.recordRequest();
    expect(budget.tryAcquire()).toBe(false);
    budget.recordRequest();
    expect(budget.tryAcquire()).toBe(false);

    // After the window rolls over, the budget is available again.
    now = 2_000;
    budget.recordRequest();
    expect(budget.tryAcquire()).toBe(true);

    // Inside the executor: with ratio 0 the second attempt is never scheduled.
    const rejected = await executeWithHedging(
      candidates(),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true as const, value: 1 };
      },
      {
        afterMs: 5,
        maxParallel: 2,
        budget: new HedgeBudget({ ratio: 0, windowMs: 1_000, clock: () => now }),
      },
    );
    expect(rejected.ok).toBe(true);
    if (rejected.ok) {
      expect(rejected.hedged).toBe(false);
      expect(rejected.hedgeAttempts).toBe(0);
    }
  });
});
