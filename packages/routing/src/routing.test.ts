import { performance } from 'node:perf_hooks';

import {
  type ConfigSnapshot,
  ConfigSnapshot as SnapshotSchema,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { type ClassifiedError, classified } from '@dirouter/providers';
import { describe, expect, it } from 'vitest';

import {
  type Candidate,
  CircuitBreaker,
  DEFAULT_BREAKER,
  HealthRegistry,
  RetryBudget,
  RouteIndex,
  Router,
  backoffDelay,
  executeWithFallback,
  isRouteError,
  type ResolvedRoute,
  type RouteError,
} from './index.js';

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const cred = (id: string, weight = 1, enabled = true) => ({
  id,
  name: id,
  secret: 'v1.AAAA',
  enabled,
  weight,
  headers: {},
});

function snapshot(over: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  const provider = (id: string, creds = [cred(`${id}-k1`)]) => ({
    id,
    organizationId: 'org',
    slug: id,
    type: 'openai' as const,
    name: id,
    baseUrl: `https://${id}.test/v1`,
    enabled: true,
    options: {},
    credentials: creds,
  });
  const model = (id: string, providerId: string, contextWindow?: number) => ({
    id,
    organizationId: 'org',
    slug: `${providerId}/${id}`,
    providerId,
    upstreamModel: id,
    enabled: true,
    ...(contextWindow ? { contextWindow } : {}),
    pricing: { inputPerMTok: '1', outputPerMTok: '2' },
    capabilities: {},
  });
  return SnapshotSchema.parse({
    schemaVersion: 1,
    version: 1,
    generatedAt: '2026-11-07T00:00:00.000Z',
    providers: [provider('a', [cred('a-k1'), cred('a-k2')]), provider('b'), provider('c')],
    models: [model('m1', 'a', 8_000), model('m2', 'b', 128_000), model('m3', 'c', 200_000)],
    combos: [
      {
        id: 'cmb',
        organizationId: 'org',
        slug: 'best',
        strategy: 'priority',
        targets: [
          { modelId: 'm1', order: 0 },
          { modelId: 'm2', order: 1 },
          { modelId: 'm3', order: 2 },
        ],
      },
      {
        id: 'w',
        organizationId: 'org',
        slug: 'weighted',
        strategy: 'weighted',
        targets: [
          { modelId: 'm1', order: 0, weight: 1 },
          { modelId: 'm2', order: 1, weight: 0 },
        ],
      },
      {
        id: 'rr',
        organizationId: 'org',
        slug: 'rr',
        strategy: 'round-robin',
        targets: [
          { modelId: 'm1', order: 0 },
          { modelId: 'm2', order: 1 },
          { modelId: 'm3', order: 2 },
        ],
      },
    ],
    aliases: [
      { organizationId: 'org', slug: 'smart', target: { kind: 'combo', comboId: 'cmb' } },
      { organizationId: 'org', slug: 'gpt', target: { kind: 'model', modelId: 'm2' } },
    ],
    virtualKeys: [],
    settings: {},
    ...over,
  });
}

const key = (over: Partial<VirtualKeyConfig> = {}): VirtualKeyConfig => ({
  id: 'vk',
  hash: 'a'.repeat(64),
  prefix: 'dr-x',
  organizationId: 'org',
  teamId: null,
  projectId: 'p',
  enabled: true,
  expiresAt: null,
  allowedModels: [],
  ipAllowlist: [],
  budgets: [],
  ...over,
});

function setup(snap = snapshot()) {
  const clock = fakeClock();
  const health = new HealthRegistry({ clock: clock.now });
  const router = new Router(new RouteIndex(snap), health);
  return { clock, health, router };
}

const ids = (r: ResolvedRoute | RouteError) =>
  isRouteError(r) ? r.error : r.candidates.map((c) => `${c.model.id}:${c.credential.id}`);

// ───────────── router ─────────────

describe('router: resolution', () => {
  const { router } = setup();

  it('resolves alias → combo in priority order with credentials expanded', () => {
    expect(ids(router.resolve(key(), 'smart', { random: () => 0 }))).toEqual([
      'm1:a-k1',
      'm1:a-k2',
      'm2:b-k1',
      'm3:c-k1',
    ]);
  });

  it('resolves alias → model, combo slug and model slug', () => {
    expect(ids(router.resolve(key(), 'gpt'))).toEqual(['m2:b-k1']);
    expect(ids(router.resolve(key(), 'best', { random: () => 0 }))[0]).toBe('m1:a-k1');
    expect(ids(router.resolve(key(), 'c/m3'))).toEqual(['m3:c-k1']);
  });

  it('rejects unknown names and names outside the key allow-list', () => {
    expect(ids(router.resolve(key(), 'nope'))).toBe('model_not_found');
    expect(ids(router.resolve(key({ allowedModels: ['gpt'] }), 'smart'))).toBe('model_not_allowed');
    expect(ids(router.resolve(key({ allowedModels: ['gpt'] }), 'gpt'))).toEqual(['m2:b-k1']);
  });

  it('never resolves a name from another organization', () => {
    expect(ids(router.resolve(key({ organizationId: 'other' }), 'smart'))).toBe('model_not_found');
  });

  it('weighted: zero-weight targets come last', () => {
    for (const r of [0, 0.5, 0.99])
      expect(ids(router.resolve(key(), 'weighted', { random: () => r }))[0]?.startsWith('m1')).toBe(
        true,
      );
  });

  it('weighted credentials follow weights', () => {
    const snap = snapshot();
    snap.providers[0]!.credentials = [cred('heavy', 9), cred('light', 1)];
    const r = setup(snap).router;
    const firsts = [0.05, 0.5, 0.85, 0.95].map(
      (x) => ids(r.resolve(key(), 'a/m1', { random: () => x }))[0],
    );
    expect(firsts).toEqual(['m1:heavy', 'm1:heavy', 'm1:heavy', 'm1:light']);
  });

  it('round-robin rotates per key (sticky counter per key)', () => {
    const r = setup().router;
    const first = (k: VirtualKeyConfig) =>
      (ids(r.resolve(k, 'rr', { random: () => 0 })) as string[])[0]?.split(':')[0];
    expect([first(key()), first(key()), first(key()), first(key())]).toEqual([
      'm1',
      'm2',
      'm3',
      'm1',
    ]);
    expect(first(key({ id: 'other' }))).toBe('m1');
  });
});

describe('router: filters', () => {
  it('skips models whose context window is too small', () => {
    const r = setup().router.resolve(key(), 'smart', {
      estimatedInputTokens: 10_000,
      random: () => 0,
    });
    expect(ids(r)).toEqual(['m2:b-k1', 'm3:c-k1']);
    expect(!isRouteError(r) && r.skipped).toContainEqual({
      modelId: 'm1',
      reason: 'context_window',
    });
  });

  it('too large for every model is a context error, not an outage', () => {
    const r = setup().router.resolve(key(), 'smart', {
      estimatedInputTokens: 10_000_000,
      random: () => 0,
    });
    expect(isRouteError(r) && r.error).toBe('context_length_exceeded');
    expect(isRouteError(r) && r.neededTokens).toBe(10_000_000);
  });

  it('stays an outage when a healthy-sized model is only temporarily unavailable', () => {
    const s = setup();
    for (const p of ['b', 'c'])
      for (let i = 0; i < 20; i++) s.health.providerBreaker(p).record(false);
    const r = s.router.resolve(key(), 'smart', { estimatedInputTokens: 10_000, random: () => 0 });
    expect(isRouteError(r) && r.error).toBe('no_available_provider');
  });

  it('skips disabled models, providers and credentials', () => {
    const snap = snapshot();
    snap.models[1]!.enabled = false;
    snap.providers[2]!.enabled = false;
    snap.providers[0]!.credentials[0]!.enabled = false;
    expect(ids(setup(snap).router.resolve(key(), 'smart'))).toEqual(['m1:a-k2']);
  });

  it('skips providers whose breaker is open and credentials in cooldown', () => {
    const { router, health } = setup();
    health.providerBreaker('a').force('open');
    health.recordFailure(
      { providerId: 'b', modelId: 'm2', credentialId: 'b-k1' },
      classified('rate_limit', { message: 'slow down', retryAfterMs: 5000 }),
    );
    expect(ids(router.resolve(key(), 'smart'))).toEqual(['m3:c-k1']);
  });

  it('returns no_available_provider when everything is filtered', () => {
    const { router, health } = setup();
    for (const p of ['a', 'b', 'c']) health.providerBreaker(p).force('open');
    expect(ids(router.resolve(key(), 'smart'))).toBe('no_available_provider');
  });

  it('resolves a 10-target combo in under 50µs', () => {
    const snap = snapshot();
    const providers = Array.from({ length: 10 }, (_, i) => ({
      ...snap.providers[1]!,
      id: `p${i}`,
      slug: `p${i}`,
      credentials: [cred(`p${i}-k`)],
    }));
    const models = providers.map((p, i) => ({
      ...snap.models[1]!,
      id: `x${i}`,
      slug: `p${i}/x`,
      providerId: p.id,
    }));
    const big = snapshot({
      providers,
      models,
      combos: [
        {
          id: 'ten',
          organizationId: 'org',
          slug: 'ten',
          strategy: 'priority',
          targets: models.map((m, i) => ({ modelId: m.id, order: i, weight: 1 })),
          fallbackOn: ['server'],
        },
      ],
      aliases: [],
    });
    const { router } = setup(big);
    const k = key();
    for (let i = 0; i < 2_000; i++) router.resolve(k, 'ten');
    const n = 20_000;
    const start = performance.now();
    for (let i = 0; i < n; i++) router.resolve(k, 'ten');
    const perCallUs = ((performance.now() - start) * 1000) / n;
    // معیار کارت ۵.۱ (کمتر از ۵۰µs) روی ماشین توسعه اندازه گرفته می‌شود؛ runnerهای مشترک CI
    // کندتر و پرنوسان‌اند، پس آن‌جا فقط جلوی پسرفت جدی (۴ برابر) را می‌گیرد.
    expect(perCallUs).toBeLessThan(process.env.CI ? 200 : 50);
  });
});

// ───────────── circuit breaker ─────────────

describe('circuit breaker', () => {
  it('opens at 50% errors in the 30s window, half-opens, then closes after recovery', () => {
    const clock = fakeClock();
    const b = new CircuitBreaker(DEFAULT_BREAKER, clock.now);
    for (let i = 0; i < 5; i++) b.record(true);
    for (let i = 0; i < 4; i++) b.record(false);
    expect(b.state).toBe('closed'); // ۹ درخواست، کمتر از حداقل حجم
    b.record(false);
    expect(b.state).toBe('open');
    expect(b.allow()).toBe(false);

    clock.advance(DEFAULT_BREAKER.openMs);
    expect(b.state).toBe('half_open');
    expect(b.allow()).toBe(true);
    b.begin();
    expect(b.allow()).toBe(false); // فقط یک probe
    b.record(true);
    b.begin();
    b.record(true);
    expect(b.state).toBe('closed');
  });

  it('a failed probe reopens for twice as long', () => {
    const clock = fakeClock();
    const b = new CircuitBreaker({ ...DEFAULT_BREAKER, minRequests: 1 }, clock.now);
    b.record(false);
    expect(b.reopensAt).toBe(clock.now() + DEFAULT_BREAKER.openMs);
    clock.advance(DEFAULT_BREAKER.openMs);
    b.begin();
    b.record(false);
    expect(b.reopensAt).toBe(clock.now() + DEFAULT_BREAKER.openMs * 2);
  });

  it('old errors fall out of the sliding window', () => {
    const clock = fakeClock();
    const b = new CircuitBreaker(DEFAULT_BREAKER, clock.now);
    for (let i = 0; i < 9; i++) b.record(false);
    clock.advance(31_000);
    b.record(false);
    expect(b.state).toBe('closed');
    expect(b.stats()).toEqual({ total: 1, errors: 1 });
  });

  it('client errors do not trip the breaker', () => {
    const { health } = setup();
    const t = { providerId: 'a', modelId: 'm1', credentialId: 'a-k1' };
    for (let i = 0; i < 20; i++)
      health.recordFailure(t, classified('bad_request', { message: 'x' }));
    expect(health.providerBreaker('a').state).toBe('closed');
  });

  it('applies breaker state from other nodes and reports changes', () => {
    const changes: unknown[] = [];
    const health = new HealthRegistry({
      onChange: (c) => changes.push(c),
      breaker: { minRequests: 1 },
    });
    health.recordFailure(
      { providerId: 'a', modelId: 'm1', credentialId: 'k' },
      classified('server', { message: 'boom' }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ kind: 'breaker', scope: 'provider', id: 'a', state: 'open' }),
    );
    health.applyRemote({
      kind: 'breaker',
      scope: 'provider',
      id: 'b',
      state: 'open',
      reopensAt: Date.now() + 60_000,
    });
    expect(health.providerBreaker('b').allow()).toBe(false);
  });
});

// ───────────── cooldown & lockout ─────────────

describe('cooldown, lockout and auth', () => {
  const t = { providerId: 'a', modelId: 'm1', credentialId: 'a-k1' };

  it('429 cools down only that credential; other keys keep working; cooldown ends automatically', () => {
    const { router, health, clock } = setup();
    health.recordFailure(
      t,
      classified('rate_limit', { message: 'Rate limit reached for requests', retryAfterMs: 2_000 }),
    );
    expect(ids(router.resolve(key(), 'a/m1'))).toEqual(['m1:a-k2']);
    clock.advance(2_000);
    expect((ids(router.resolve(key(), 'a/m1', { random: () => 0 })) as string[]).sort()).toEqual([
      'm1:a-k1',
      'm1:a-k2',
    ]);
  });

  it('cooldown without Retry-After grows exponentially', () => {
    const { health } = setup();
    health.recordFailure(t, classified('rate_limit', { message: 'x' }));
    const first = health.report().credentials[0]?.cooldownUntil ?? 0;
    health.recordFailure(t, classified('rate_limit', { message: 'x' }));
    const second = health.report().credentials[0]?.cooldownUntil ?? 0;
    expect(second - health.now()).toBe(2 * (first - health.now()));
  });

  it('model-specific limits lock only that model on that credential', () => {
    const { health } = setup();
    health.recordFailure(
      t,
      classified('rate_limit', {
        message: 'Rate limit reached for model gpt-4.1 on tokens per min',
        retryAfterMs: 1000,
      }),
    );
    expect(health.credentialAvailable('a-k1', 'm1')).toBe(false);
    expect(health.credentialAvailable('a-k1', 'other-model')).toBe(true);
    expect(health.report().credentials[0]?.lockouts).toHaveLength(1);
  });

  it('auth errors disable the credential and emit an event', () => {
    const changes: { kind: string }[] = [];
    const health = new HealthRegistry({ onChange: (c) => changes.push(c) });
    health.recordFailure(t, classified('auth', { message: 'Invalid API key' }));
    expect(health.credentialAvailable('a-k1', 'm1')).toBe(false);
    expect(changes.map((c) => c.kind)).toContain('credential_disabled');
    health.enableCredential('a-k1');
    expect(health.credentialAvailable('a-k1', 'm1')).toBe(true);
  });
});

// ───────────── executor ─────────────

const policy = { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 };
const fail = (cls: Parameters<typeof classified>[0], extra: Partial<ClassifiedError> = {}) => ({
  ok: false as const,
  error: { ...classified(cls, { message: cls }), ...extra },
});

function candidatesFor(router: Router, name = 'smart') {
  const r = router.resolve(key(), name, { random: () => 0 });
  if (isRouteError(r)) throw new Error(r.error);
  return r;
}

describe('executor: retry and fallback', () => {
  const run = (
    route: ResolvedRoute,
    fn: (c: Candidate, attempt: number) => unknown,
    over: Partial<Parameters<typeof executeWithFallback>[2]> = {},
  ) =>
    executeWithFallback(
      route.candidates,
      async (c, _s, attempt) => (await fn(c, attempt)) as never,
      {
        retry: policy,
        fallbackOn: route.fallbackOn,
        deadline: Date.now() + 60_000,
        budget: new RetryBudget(),
        sleep: async () => undefined,
        random: () => 0.5,
        ...over,
      },
    );

  it('when the first provider is down, the second succeeds and every attempt is recorded', async () => {
    const route = candidatesFor(setup().router);
    const result = await run(route, (c) =>
      c.provider.id === 'a' ? fail('server', { status: 503 }) : { ok: true, value: c.model.id },
    );
    expect(result).toMatchObject({ ok: true, value: 'm2' });
    expect(result.attempts.map((a) => `${a.credentialId}#${a.attempt}:${a.outcome}`)).toEqual([
      'a-k1#1:error',
      'a-k1#2:error',
      'a-k2#0:skipped',
      'b-k1#1:success',
    ]);
  });

  it('rate limit moves to the next credential without retrying the same one', async () => {
    const route = candidatesFor(setup().router);
    const result = await run(route, (c) =>
      c.credential.id === 'a-k1' ? fail('rate_limit') : { ok: true, value: c.credential.id },
    );
    expect(result).toMatchObject({ ok: true, value: 'a-k2' });
    expect(result.attempts).toHaveLength(2);
  });

  it('bad_request is never sent to another provider', async () => {
    const route = candidatesFor(setup().router);
    let calls = 0;
    const result = await run(route, () => {
      calls++;
      return fail('bad_request', { status: 400 });
    });
    expect(result).toMatchObject({ ok: false, reason: 'no_fallback' });
    expect(calls).toBe(1);
  });

  it('respects the combo fallbackOn list', async () => {
    const route = candidatesFor(setup().router);
    const result = await run({ ...route, fallbackOn: ['rate_limit'] }, () => fail('server'));
    expect(result).toMatchObject({ ok: false, reason: 'no_fallback' });
  });

  it('context_length falls back only to larger context windows', async () => {
    const route = candidatesFor(setup().router);
    const tried: string[] = [];
    const result = await run(route, (c) => {
      tried.push(c.model.id);
      return c.model.id === 'm3' ? { ok: true, value: 'ok' } : fail('context_length');
    });
    expect(result.ok).toBe(true);
    expect(tried).toEqual(['m1', 'm2', 'm3']);
  });

  it('stops immediately once bytes were committed to the client', async () => {
    const route = candidatesFor(setup().router);
    const result = await run(route, () => ({ ...fail('connection'), committed: true }));
    expect(result).toMatchObject({ ok: false, reason: 'committed' });
    expect(result.attempts).toHaveLength(1);
  });

  it('honours the deadline', async () => {
    const route = candidatesFor(setup().router);
    const clock = fakeClock();
    const result = await run(
      route,
      () => {
        clock.advance(5_000);
        return fail('server');
      },
      { clock: clock.now, deadline: clock.now() + 6_000 },
    );
    expect(result).toMatchObject({ ok: false, reason: 'deadline' });
  });

  it('retry budget stops retry storms during a full outage', async () => {
    const route = candidatesFor(setup().router);
    const budget = new RetryBudget({ ratio: 0.1, minPerWindow: 5 });
    let calls = 0;
    for (let i = 0; i < 100; i++) {
      await run(
        route,
        () => {
          calls++;
          return fail('server');
        },
        { budget },
      );
    }
    // بدون budget هر درخواست ۲ تلاش × ۳ provider = ۶ می‌شد (۶۰۰)؛ با budget حدود ۱۰۰ + ۱۰ + ۵.
    expect(calls).toBeLessThanOrEqual(120);
    expect(calls).toBeGreaterThanOrEqual(100);
  });

  it('stops when the client disconnects', async () => {
    const route = candidatesFor(setup().router);
    const controller = new AbortController();
    const result = await run(
      route,
      () => {
        controller.abort();
        return fail('server');
      },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
  });

  it('feeds breakers so later requests avoid the failing provider', async () => {
    const { router, health } = setup();
    for (let i = 0; i < 10; i++) {
      await executeWithFallback(
        candidatesFor(router).candidates,
        async (c) => (c.provider.id === 'a' ? fail('server') : { ok: true, value: 1 }),
        {
          retry: { ...policy, maxAttempts: 1 },
          fallbackOn: ['server'],
          deadline: Date.now() + 1000,
          budget: new RetryBudget({ minPerWindow: 1000 }),
          health,
        },
      );
    }
    expect(health.providerBreaker('a').state).toBe('open');
    expect(ids(router.resolve(key(), 'smart'))[0]).toBe('m2:b-k1');
  });

  it('full jitter backoff stays within the exponential cap', () => {
    expect(backoffDelay(1, policy, () => 0.999)).toBeLessThan(100);
    expect(backoffDelay(3, policy, () => 0.999)).toBeLessThan(400);
    expect(backoffDelay(10, policy, () => 0.999)).toBeLessThan(1000);
  });
});

describe('manual reset (card 7.8)', () => {
  it('closes breakers and clears cooldowns, lockouts and disabled credentials', () => {
    const { health } = setup();
    for (let i = 0; i < 20; i++) health.providerBreaker('p').record(false);
    for (let i = 0; i < 20; i++) health.modelBreaker('m').record(false);
    expect(health.providerBreaker('p').state).toBe('open');
    health.recordFailure(
      { providerId: 'p', modelId: 'm', credentialId: 'c' },
      {
        class: 'rate_limit',
        retryable: false,
        fallbackAllowed: true,
        message: 'rate limit for model m',
        retryAfterMs: 60_000,
      },
    );
    health.recordFailure(
      { providerId: 'p', modelId: 'm2', credentialId: 'c' },
      {
        class: 'rate_limit',
        retryable: false,
        fallbackAllowed: true,
        message: 'Rate limit reached',
        retryAfterMs: 60_000,
      },
    );
    expect(health.credentialAvailable('c', 'm')).toBe(false);
    health.applyRemote({ kind: 'reset', scope: 'provider', id: 'p' });
    health.applyRemote({ kind: 'reset', scope: 'model', id: 'm' });
    health.applyRemote({ kind: 'reset', scope: 'credential', id: 'c' });
    expect(health.providerBreaker('p').state).toBe('closed');
    expect(health.modelBreaker('m').state).toBe('closed');
    expect(health.credentialAvailable('c', 'm')).toBe(true);
    expect(health.credentialAvailable('c', 'm2')).toBe(true);
    expect(health.report().credentials).toEqual([]);
  });
});
