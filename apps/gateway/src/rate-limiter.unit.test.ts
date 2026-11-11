import { EventEmitter } from 'node:events';

import { createLogger } from '@dirouter/shared';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { LocalLimiter, RateLimiter } from './rate-limiter.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const scope = [{ name: 'key:test', limit: { requestsPerMinute: 10 } }];
type Call = [string, unknown[]];

class RedisStub extends EventEmitter {
  calls: Call[] = [];
  rlAcquire = async () => [1, 0, '', 0, 1_000_000, 0, 60_000, 0];
  rlSettle = async () => 1;
  defineCommand(name: string, _options: unknown) {
    if (name === 'rlAcquire') {
      this.rlAcquire = async (..._args: unknown[]) => {
        this.calls.push([name, _args]);
        return [1, 0, '', 0, 1_000_000, 0, 60_000, 0];
      };
    }
  }
  scan = async () => ['0', ['dirouter:gateway:node:a', 'dirouter:gateway:node:b']];
  zrem = async () => 1;
  asRedis() {
    return this as unknown as Redis;
  }
}

describe('rate limiter lifecycle and fallbacks', () => {
  it('discovers nodes, handles scan failures and stops its timer', async () => {
    vi.useFakeTimers();
    try {
      const redis = new RedisStub();
      const limiter = new RateLimiter({ redis: redis.asRedis(), logger, failMode: () => 'open' });
      limiter.startNodeCount(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(limiter.nodes).toBe(2);
      redis.scan = async () => {
        throw new Error('unavailable');
      };
      await vi.advanceTimersByTimeAsync(10);
      expect(limiter.nodes).toBe(2);
      limiter.stop();
      expect(vi.getTimerCount()).toBe(0);
      await limiter.acquire(scope, 0, 'r');
      expect(limiter.stats.remote).toBe(1);
      expect(new RateLimiter({ logger, failMode: () => 'open' }).nodes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports token-only scopes and idempotent asynchronous release/settlement', async () => {
    const redis = new RedisStub();
    const limiter = new RateLimiter({ redis: redis.asRedis(), logger, failMode: () => 'open' });
    const tokens = [{ name: 'p', limit: { tokensPerMinute: 100, maxConcurrency: 1 } }];
    const result = await limiter.acquire(tokens, 10.2, 'request');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers).toMatchObject({ 'x-ratelimit-limit-tokens': '100' });
      result.settle(10.2);
      result.settle(15);
      result.release();
      result.release();
    }
    const settled = await limiter.acquire(
      [{ name: 'none', limit: { tokensPerMinute: 1 } }],
      0,
      'x',
    );
    if (settled.ok) {
      settled.settle(1);
      settled.release();
    }
    expect(limiter.stats.remote).toBe(2);
  });

  it('expires local token buckets', () => {
    const local = new LocalLimiter(2_000, 1_000, () => 2_000);
    const tokens = [{ name: 'tokens', limit: { tokensPerMinute: 100 } }];
    const first = local.acquire(tokens, 110, 1);
    expect(first.ok).toBe(true);
    if (first.ok) first.settle(200);
    expect(local.acquire(tokens, 1, 1).ok).toBe(false);
    const expiry = new LocalLimiter(2_000, 1_000, () => 3_001);
    expect(expiry.acquire(tokens, 1, 1).ok).toBe(true);
    const rejected = local.acquire([{ name: 'unlimited', limit: { requestsPerMinute: 0 } }], 0, 1);
    expect(rejected.ok).toBe(true);
    const blocked = local.acquire([{ name: 'tokens', limit: { maxConcurrency: 1 } }], 0, 1);
    if (blocked.ok) blocked.release();
  });

  it('falls back when Valkey times out', async () => {
    const redis = new RedisStub();
    redis.defineCommand = () => undefined;
    redis.rlAcquire = () => new Promise(() => undefined);
    const options = {
      redis: redis.asRedis(),
      logger,
      commandTimeoutMs: 10,
    };
    const limiter = new RateLimiter({ ...options, failMode: () => 'open' });
    const tokens = [{ name: 'tokens', limit: { requestsPerMinute: 1, tokensPerMinute: 100 } }];
    expect((await limiter.acquire(tokens, 0, 'first')).ok).toBe(true);
    expect(limiter.stats.degraded).toBe(true);
    const closed = new RateLimiter({ ...options, failMode: () => 'closed' });
    expect(await closed.acquire(tokens, 0, 'closed')).toMatchObject({
      ok: false,
      unavailable: true,
    });
    const invalid = new RedisStub();
    invalid.defineCommand = () => undefined;
    invalid.rlAcquire = async () => [0, 99, 'requests', 'bad', 'bad'];
    const rejected = new RateLimiter({ redis: invalid.asRedis(), logger, failMode: () => 'open' });
    expect(await rejected.acquire(scope, 0, 'invalid')).toMatchObject({ ok: false, scope: '' });
    const noRedis = new RateLimiter({ logger, failMode: () => 'open' });
    expect(noRedis.nodes).toBe(1);
  });

  it('returns remote rejections', async () => {
    const redis = new RedisStub();
    const limiter = new RateLimiter({ redis: redis.asRedis(), logger, failMode: () => 'open' });
    redis.rlAcquire = async () => [0, 1, 'requests', 500, 1_000_000];
    expect(await limiter.acquire(scope, 0, 'limited')).toMatchObject({
      ok: false,
      kind: 'requests',
      retryAfterMs: 500,
    });
  });

  it('turns command failures into fail-open admissions', async () => {
    const redis = new RedisStub();
    redis.defineCommand = () => undefined;
    redis.rlAcquire = async () => {
      throw new Error('broken');
    };
    const fallback = new RateLimiter({ redis: redis.asRedis(), logger, failMode: () => 'open' });
    expect((await fallback.acquire(scope, 0, 'fallback')).ok).toBe(true);
    expect(fallback.stats.degraded).toBe(true);
    const second = await fallback.acquire(scope, 0, 'degraded-window');
    expect(second.ok).toBe(true);
    expect(fallback.stats.local).toBeGreaterThan(0);
  });

  it('converts non-Error rejections and parses short remote replies', async () => {
    const redis = new RedisStub();
    redis.defineCommand = () => undefined;
    redis.rlAcquire = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'boom';
    };
    const limiter = new RateLimiter({ redis: redis.asRedis(), logger, failMode: () => 'open' });
    expect((await limiter.acquire(scope, 0, 'string-throw')).ok).toBe(true);

    const short = new RedisStub();
    short.rlAcquire = async () => [1, 0, '', 0, 1_000];
    const remote = new RateLimiter({ redis: short.asRedis(), logger, failMode: () => 'open' });
    const admitted = await remote.acquire(scope, 0, 'short-raw');
    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      expect(admitted.headers['x-ratelimit-reset-requests']).toBe('60s');
      admitted.release();
    }
  });

  it('runs single-node and node-count paths without Valkey', async () => {
    const noRedis = new RateLimiter({ logger, failMode: () => 'open' });
    const limited = [{ name: 'solo', limit: { requestsPerMinute: 1 } }];
    expect((await noRedis.acquire(limited, 0, 'a')).ok).toBe(true);
    expect((await noRedis.acquire(limited, 0, 'b')).ok).toBe(false);
    noRedis.startNodeCount(10);
    expect(noRedis.nodes).toBe(1);
    noRedis.stop();
  });

  it('expires windows, settles fresh buckets and releases local scopes', () => {
    let now = 1_000;
    const local = new LocalLimiter(2_000, 1_000, () => now);
    const rpm = [{ name: 'rpm', limit: { requestsPerMinute: 2 } }];
    const first = local.acquire(rpm, 0, 1);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.headers['x-ratelimit-reset-requests']).toBe('0s');
      first.settle(1);
      first.release();
    }
    now = 1_500;
    expect(local.acquire(rpm, 0, 1).ok).toBe(true);
    now = 2_500;
    expect(local.acquire(rpm, 0, 1).ok).toBe(false);

    const tokens = [{ name: 'tokens', limit: { tokensPerMinute: 100 } }];
    const fresh = local.acquire(tokens, 0, 1);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) fresh.settle(5);
    now = 4_000;
    expect(local.acquire(tokens, 5, 1).ok).toBe(true);

    const conc = [{ name: 'conc', limit: { maxConcurrency: 1 } }];
    const held = local.acquire(conc, 0, 1);
    expect(held.ok).toBe(true);
    expect(local.acquire(conc, 0, 1).ok).toBe(false);
    if (held.ok) {
      held.release();
      held.release();
    }
    expect(local.acquire(conc, 0, 1).ok).toBe(true);
  });
});
