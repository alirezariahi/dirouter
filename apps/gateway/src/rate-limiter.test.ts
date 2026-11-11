/**
 * Rate limiter (card 6.1). The Valkey part runs with INTEGRATION_VALKEY_URL.
 */
import { randomUUID } from 'node:crypto';

import { createLogger } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { type Admission, LocalLimiter, RateLimiter } from './rate-limiter.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const ok = (a: Admission) => a.ok;

describe('local limiter', () => {
  it('rpm is a sliding window and reports the wait until a slot frees', () => {
    let now = 1_000_000;
    const l = new LocalLimiter(60_000, 1_000, () => now);
    const scope = [{ name: 'key:a', limit: { requestsPerMinute: 3 } }];
    expect([1, 2, 3].map(() => l.acquire(scope, 0, 1).ok)).toEqual([true, true, true]);
    now += 10_000;
    const rejected = l.acquire(scope, 0, 1);
    expect(rejected).toMatchObject({ ok: false, kind: 'requests', retryAfterMs: 50_000 });
    now += 50_000;
    expect(l.acquire(scope, 0, 1).ok).toBe(true);
  });

  it('the share divides the limit between nodes', () => {
    const l = new LocalLimiter(60_000, 1_000, () => 5);
    const scope = [{ name: 'key:b', limit: { requestsPerMinute: 60 } }];
    const results = Array.from({ length: 30 }, () => l.acquire(scope, 0, 3).ok);
    expect(results.filter(Boolean)).toHaveLength(20);
  });

  it('tpm reserves the estimate and settles to the actual usage', () => {
    const l = new LocalLimiter(60_000, 1_000, () => 5);
    const scope = [{ name: 'key:c', limit: { tokensPerMinute: 1_000 } }];
    const first = l.acquire(scope, 800, 1);
    expect(first.ok).toBe(true);
    expect(l.acquire(scope, 300, 1)).toMatchObject({ ok: false, kind: 'tokens' });
    if (first.ok) first.settle(100); // actual usage was lower
    expect(l.acquire(scope, 300, 1).ok).toBe(true);
  });

  it('one request larger than the whole tpm passes only when the window is empty', () => {
    const l = new LocalLimiter(60_000, 1_000, () => 5);
    const scope = [{ name: 'key:d', limit: { tokensPerMinute: 100 } }];
    expect(l.acquire(scope, 500, 1).ok).toBe(true);
    expect(l.acquire(scope, 1, 1).ok).toBe(false);
  });

  it('concurrency counts in-flight requests until release', () => {
    const l = new LocalLimiter(60_000, 1_000);
    const scope = [{ name: 'key:e', limit: { maxConcurrency: 1 } }];
    const a = l.acquire(scope, 0, 1);
    expect(l.acquire(scope, 0, 1)).toMatchObject({ ok: false, kind: 'concurrency' });
    if (a.ok) {
      a.release();
      a.release();
    }
    expect(l.acquire(scope, 0, 1).ok).toBe(true);
  });

  it('a rejection in one scope does not consume the others', () => {
    let now = 0;
    const l = new LocalLimiter(60_000, 1_000, () => now);
    const key = { name: 'key:f', limit: { requestsPerMinute: 10 } };
    const project = { name: 'project:p', limit: { requestsPerMinute: 1 } };
    expect(l.acquire([key, project], 0, 1).ok).toBe(true);
    expect(l.acquire([key, project], 0, 1)).toMatchObject({ ok: false, scope: 'project:p' });
    now += 1;
    // The key still has 9 free slots because the rejected request consumed nothing.
    expect(Array.from({ length: 9 }, () => l.acquire([key], 0, 1).ok).every(Boolean)).toBe(true);
    expect(l.acquire([key], 0, 1).ok).toBe(false);
  });
});

describe('Valkey outage', () => {
  const dead = () =>
    new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      lazyConnect: false,
      retryStrategy: () => 1_000,
    }).on('error', () => undefined);

  it('fail-open falls back to the local limiter and never throws', async () => {
    const redis = dead();
    try {
      const limiter = new RateLimiter({ redis, logger, failMode: () => 'open' });
      const scope = [{ name: `key:${randomUUID()}`, limit: { requestsPerMinute: 2 } }];
      const results = await Promise.all([1, 2, 3].map((i) => limiter.acquire(scope, 0, `r${i}`)));
      expect(results.map(ok)).toEqual([true, true, false]);
      expect(limiter.stats).toMatchObject({ degraded: true, local: 3 });
    } finally {
      redis.disconnect();
    }
  });

  it('fail-closed rejects limited scopes as unavailable (429, not 5xx)', async () => {
    const redis = dead();
    try {
      const limiter = new RateLimiter({ redis, logger, failMode: () => 'closed' });
      const limited = await limiter.acquire(
        [{ name: 'key:x', limit: { requestsPerMinute: 100 } }],
        0,
        'r',
      );
      expect(limited).toMatchObject({ ok: false, unavailable: true });
      // A scope without a cap never needs Valkey.
      expect((await limiter.acquire([{ name: 'key:y', limit: {} }], 0, 'r')).ok).toBe(true);
    } finally {
      redis.disconnect();
    }
  });
});

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
describe.skipIf(!VALKEY_URL)('distributed limiter on real Valkey', () => {
  const conns: Redis[] = [];
  const node = (windowMs = 60_000) => {
    const redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false });
    conns.push(redis);
    return new RateLimiter({
      redis,
      logger,
      failMode: () => 'open',
      windowMs,
      commandTimeoutMs: 1_000,
      prefix: `test:rl:${randomUUID()}`,
    });
  };
  afterAll(() => {
    for (const c of conns) c.disconnect();
  });
  const ready = async () => {
    for (const c of conns) if (c.status !== 'ready') await new Promise((r) => c.once('ready', r));
  };

  it('three nodes share one rpm limit exactly over a sliding window', async () => {
    // A 3-second window with a cap of 60 = the same 60 RPM rate, compressed for CI.
    const prefix = `test:rl:${randomUUID()}`;
    const nodes = [1, 2, 3].map(() => {
      const redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false });
      conns.push(redis);
      return new RateLimiter({ redis, logger, failMode: () => 'open', windowMs: 3_000, prefix });
    });
    await ready();
    const scope = [{ name: 'key:shared', limit: { requestsPerMinute: 60 } }];
    const started = Date.now();
    let accepted = 0;
    let n = 0;
    await Promise.all(
      nodes.map(async (limiter) => {
        while (Date.now() - started < 7_500) {
          const a = await limiter.acquire(scope, 0, `req-${String(n++)}`);
          if (a.ok) accepted++;
          else await new Promise((r) => setTimeout(r, 5));
        }
      }),
    );
    // Windows [0,3) [3,6) [6,7.5): three times 60 = 180, within ±5%.
    expect(accepted).toBeGreaterThanOrEqual(171);
    expect(accepted).toBeLessThanOrEqual(189);
    expect(nodes.every((l) => l.stats.remote > 0 && l.stats.local === 0)).toBe(true);
  }, 15_000);

  it('rejections carry the wait until the oldest request leaves the window', async () => {
    const limiter = node(2_000);
    await ready();
    const scope = [{ name: 'key:wait', limit: { requestsPerMinute: 2 } }];
    const first = await limiter.acquire(scope, 0, 'a');
    expect(first.ok && first.headers).toMatchObject({
      'x-ratelimit-limit-requests': '2',
      'x-ratelimit-remaining-requests': '1',
    });
    await limiter.acquire(scope, 0, 'b');
    const rejected = await limiter.acquire(scope, 0, 'c');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.kind).toBe('requests');
      expect(rejected.retryAfterMs).toBeGreaterThan(1_500);
      expect(rejected.retryAfterMs).toBeLessThanOrEqual(2_000);
    }
  });

  it('tpm reservation and settlement across nodes', async () => {
    const prefix = `test:rl:${randomUUID()}`;
    const mk = () => {
      const redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false });
      conns.push(redis);
      return new RateLimiter({ redis, logger, failMode: () => 'open', prefix });
    };
    const [a, b] = [mk(), mk()];
    await ready();
    const scope = [{ name: 'project:p', limit: { tokensPerMinute: 1_000 } }];
    const first = await a.acquire(scope, 900, 'x');
    expect(first.ok && first.headers['x-ratelimit-remaining-tokens']).toBe('100');
    expect((await b.acquire(scope, 200, 'y')).ok).toBe(false);
    if (first.ok) first.settle(150);
    await new Promise((r) => setTimeout(r, 50));
    expect((await b.acquire(scope, 200, 'z')).ok).toBe(true);
  });

  it('concurrency is global and freed on release', async () => {
    const prefix = `test:rl:${randomUUID()}`;
    const mk = () => {
      const redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false });
      conns.push(redis);
      return new RateLimiter({ redis, logger, failMode: () => 'open', prefix });
    };
    const [a, b] = [mk(), mk()];
    await ready();
    const scope = [{ name: 'key:c', limit: { maxConcurrency: 1 } }];
    const held = await a.acquire(scope, 0, 'h');
    expect((await b.acquire(scope, 0, 'i')).ok).toBe(false);
    if (held.ok) held.release();
    await new Promise((r) => setTimeout(r, 50));
    expect((await b.acquire(scope, 0, 'j')).ok).toBe(true);
  });

  it('expired concurrency slots (dead node) are reclaimed by TTL', async () => {
    const redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false });
    conns.push(redis);
    const limiter = new RateLimiter({
      redis,
      logger,
      failMode: () => 'open',
      concurrencyTtlMs: 200,
      prefix: `test:rl:${randomUUID()}`,
    });
    await ready();
    const scope = [{ name: 'key:ttl', limit: { maxConcurrency: 1 } }];
    expect((await limiter.acquire(scope, 0, 'lost')).ok).toBe(true); // is never released
    expect((await limiter.acquire(scope, 0, 'next')).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 250));
    expect((await limiter.acquire(scope, 0, 'later')).ok).toBe(true);
  });
});
