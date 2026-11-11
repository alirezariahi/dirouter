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
  });
});
