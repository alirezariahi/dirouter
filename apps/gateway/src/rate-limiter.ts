/**
 * Distributed rate limiter on Valkey (card 6.1).
 *
 * Three kinds of cap for each scope (key, project, team):
 * - RPM: exact sliding window (sliding log in a ZSET). At most `rpm` requests in any 60-second span.
 * - TPM: one-second buckets in a HASH. Before the request the estimate is reserved, and after the actual usage
 *   the difference is settled.
 * - Concurrency: a semaphore in a ZSET with a TTL, so a dead node's request does not hold a slot forever.
 *
 * All scopes are checked and then applied by a single atomic Lua script (or none are), and
 * the reference clock is Valkey's own `TIME`, so nodes do not need synchronized clocks.
 *
 * Valkey outage: a local limiter with a share of `ceil(limit / number of nodes)` (fail-open, default), or
 * 429 for limited scopes (fail-closed). It never returns 5xx in any mode.
 */
import type { RateLimitConfig } from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';
import type { Redis } from 'ioredis';

export interface LimitScope {
  /** e.g. `key:<id>`, `project:<id>`, `team:<id>` */
  name: string;
  limit: RateLimitConfig;
}

export type LimitKind = 'requests' | 'tokens' | 'concurrency';

export interface LimitHeaders {
  [name: string]: string;
}

export type Admission =
  | {
      ok: true;
      headers: LimitHeaders;
      /** Settles TPM with actual usage (input + output). */
      settle: (actualTokens: number) => void;
      /** Releases the concurrency slot. */
      release: () => void;
    }
  | {
      ok: false;
      scope: string;
      kind: LimitKind;
      retryAfterMs: number;
      headers: LimitHeaders;
      /** The limiter was unavailable and failMode=closed. */
      unavailable?: boolean;
    };

export interface RateLimiterOptions {
  redis?: Redis;
  logger: Logger;
  failMode: () => 'open' | 'closed';
  /** Window length; only shortened for tests. */
  windowMs?: number;
  /** TTL of each concurrency slot (must exceed the longest request). */
  concurrencyTtlMs?: number;
  /** Timeout for each Valkey call; slower means local fallback. */
  commandTimeoutMs?: number;
  prefix?: string;
}

const PREFIX = 'dirouter:rl';

/**
 * KEYS: three keys per scope [rpm, tpm, conc]
 * ARGV: windowMs, bucketMs, requestId, estimate, concTtlMs, then [rpm, tpm, conc] for each scope
 * Output: {ok, failIndex, failKind, retryAfterMs, nowMs, ...[rpmUsed, rpmResetMs, tpmUsed] for each scope}
 */
const ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local bucketMs = tonumber(ARGV[2])
local id = ARGV[3]
local est = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local n = #KEYS / 3
local bucket = math.floor(now / bucketMs)
local buckets = math.floor(window / bucketMs)
local info = {}
for i = 1, n do
  local rpmKey, tpmKey, concKey = KEYS[i*3-2], KEYS[i*3-1], KEYS[i*3]
  local rpm = tonumber(ARGV[5 + i*3 - 2])
  local tpm = tonumber(ARGV[5 + i*3 - 1])
  local conc = tonumber(ARGV[5 + i*3])
  local rpmUsed, rpmReset, tpmUsed = 0, 0, 0
  if rpm > 0 then
    redis.call('ZREMRANGEBYSCORE', rpmKey, '-inf', now - window)
    rpmUsed = redis.call('ZCARD', rpmKey)
    if rpmUsed >= rpm then
      local oldest = redis.call('ZRANGE', rpmKey, 0, rpmUsed - rpm, 'WITHSCORES')
      local at = tonumber(oldest[#oldest])
      return {0, i, 'requests', math.max(1, at + window - now), now}
    end
    local first = redis.call('ZRANGE', rpmKey, 0, 0, 'WITHSCORES')
    if #first > 0 then rpmReset = tonumber(first[2]) + window - now end
  end
  if tpm > 0 then
    local all = redis.call('HGETALL', tpmKey)
    for j = 1, #all, 2 do
      local b = tonumber(all[j])
      if b <= bucket - buckets then redis.call('HDEL', tpmKey, all[j])
      else tpmUsed = tpmUsed + tonumber(all[j+1]) end
    end
    -- a request larger than the whole cap is only rejected when the window is empty.
    if tpmUsed > 0 and tpmUsed + est > tpm then
      return {0, i, 'tokens', bucketMs, now}
    end
  end
  if conc > 0 then
    redis.call('ZREMRANGEBYSCORE', concKey, '-inf', now)
    if redis.call('ZCARD', concKey) >= conc then
      return {0, i, 'concurrency', 1000, now}
    end
  end
  info[#info+1] = rpmUsed
  info[#info+1] = rpmReset
  info[#info+1] = tpmUsed
end
for i = 1, n do
  local rpmKey, tpmKey, concKey = KEYS[i*3-2], KEYS[i*3-1], KEYS[i*3]
  if tonumber(ARGV[5 + i*3 - 2]) > 0 then
    redis.call('ZADD', rpmKey, now, id)
    redis.call('PEXPIRE', rpmKey, window + 1000)
  end
  if tonumber(ARGV[5 + i*3 - 1]) > 0 and est > 0 then
    redis.call('HINCRBY', tpmKey, bucket, est)
    redis.call('PEXPIRE', tpmKey, window + 2000)
  end
  if tonumber(ARGV[5 + i*3]) > 0 then
    redis.call('ZADD', concKey, now + ttl, id)
    redis.call('PEXPIRE', concKey, ttl + 1000)
  end
end
local out = {1, 0, '', 0, now}
for j = 1, #info do out[#out+1] = info[j] end
return out
`;

/** KEYS: tpm keys; ARGV: bucket, delta, windowMs */
const SETTLE = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    redis.call('HINCRBY', KEYS[i], ARGV[1], ARGV[2])
  end
end
return 1
`;

type RedisWithScripts = Redis & {
  rlAcquire(numKeys: number, ...args: (string | number)[]): Promise<(number | string)[]>;
  rlSettle(numKeys: number, ...args: (string | number)[]): Promise<number>;
};

const formatReset = (ms: number) =>
  ms <= 0 ? '0s' : ms < 1000 ? `${String(Math.ceil(ms))}ms` : `${String(Math.ceil(ms / 1000))}s`;

// ───────────── local limiter (fallback) ─────────────

interface LocalScope {
  requests: number[];
  tokens: Map<number, number>;
  inFlight: number;
}

/** The same algorithms in one node's memory, with the cap split across nodes. */
export class LocalLimiter {
  readonly #scopes = new Map<string, LocalScope>();

  constructor(
    private readonly windowMs: number,
    private readonly bucketMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  acquire(scopes: LimitScope[], estimate: number, share: number): Admission {
    const now = this.clock();
    const bucket = Math.floor(now / this.bucketMs);
    const buckets = Math.floor(this.windowMs / this.bucketMs);
    const part = (limit: number | undefined) => (limit ? Math.max(1, Math.ceil(limit / share)) : 0);
    const states: { s: LocalScope; rpm: number; tpm: number; conc: number }[] = [];
    let tightest: { limit: number; used: number; reset: number } | undefined;
    for (const scope of scopes) {
      const s = this.#scopes.get(scope.name) ?? {
        requests: [],
        tokens: new Map<number, number>(),
        inFlight: 0,
      };
      this.#scopes.set(scope.name, s);
      const rpm = part(scope.limit.requestsPerMinute);
      const tpm = part(scope.limit.tokensPerMinute);
      const conc = part(scope.limit.maxConcurrency);
      while (s.requests.length > 0 && (s.requests[0] ?? 0) <= now - this.windowMs)
        s.requests.shift();
      if (rpm > 0 && s.requests.length >= rpm) {
        const at = s.requests[s.requests.length - rpm] ?? now;
        return reject(scope.name, 'requests', at + this.windowMs - now);
      }
      let tokensUsed = 0;
      for (const [b, v] of s.tokens) {
        if (b <= bucket - buckets) s.tokens.delete(b);
        else tokensUsed += v;
      }
      if (tpm > 0 && tokensUsed > 0 && tokensUsed + estimate > tpm)
        return reject(scope.name, 'tokens', this.bucketMs);
      if (conc > 0 && s.inFlight >= conc) return reject(scope.name, 'concurrency', 1000);
      if (rpm > 0 && (!tightest || rpm - s.requests.length < tightest.limit - tightest.used))
        tightest = {
          limit: rpm,
          used: s.requests.length,
          reset: s.requests[0] !== undefined ? s.requests[0] + this.windowMs - now : 0,
        };
      states.push({ s, rpm, tpm, conc });
    }
    for (const st of states) {
      if (st.rpm > 0) st.s.requests.push(now);
      if (st.tpm > 0 && estimate > 0)
        st.s.tokens.set(bucket, (st.s.tokens.get(bucket) ?? 0) + estimate);
      if (st.conc > 0) st.s.inFlight++;
    }
    let released = false;
    return {
      ok: true,
      headers: tightest ? requestHeaders(tightest.limit, tightest.used + 1, tightest.reset) : {},
      settle: (actual) => {
        for (const st of states)
          if (st.tpm > 0)
            st.s.tokens.set(
              bucket,
              Math.max(0, (st.s.tokens.get(bucket) ?? 0) + actual - estimate),
            );
      },
      release: () => {
        if (released) return;
        released = true;
        for (const st of states) if (st.conc > 0) st.s.inFlight--;
      },
    };
  }
}

function requestHeaders(limit: number, used: number, resetMs: number): LimitHeaders {
  return {
    'x-ratelimit-limit-requests': String(limit),
    'x-ratelimit-remaining-requests': String(Math.max(0, limit - used)),
    'x-ratelimit-reset-requests': formatReset(resetMs),
  };
}

function reject(scope: string, kind: LimitKind, retryAfterMs: number): Admission {
  return {
    ok: false,
    scope,
    kind,
    retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
    headers: kind === 'requests' ? { 'x-ratelimit-remaining-requests': '0' } : {},
  };
}

// ───────────── distributed limiter ─────────────

export class RateLimiter {
  readonly #redis: RedisWithScripts | undefined;
  readonly #local: LocalLimiter;
  readonly #windowMs: number;
  readonly #bucketMs = 1_000;
  readonly #concTtlMs: number;
  readonly #timeoutMs: number;
  readonly #prefix: string;
  /** Don't try Valkey until this time (after an error). */
  #degradedUntil = 0;
  #nodes = 1;
  #nodesTimer: NodeJS.Timeout | undefined;
  readonly stats = { remote: 0, local: 0, rejected: 0, degraded: false };

  constructor(private readonly options: RateLimiterOptions) {
    this.#windowMs = options.windowMs ?? 60_000;
    this.#concTtlMs = options.concurrencyTtlMs ?? 15 * 60_000;
    this.#timeoutMs = options.commandTimeoutMs ?? 100;
    this.#prefix = options.prefix ?? PREFIX;
    this.#local = new LocalLimiter(this.#windowMs, this.#bucketMs);
    if (options.redis) {
      const redis = options.redis as RedisWithScripts;
      redis.defineCommand('rlAcquire', { lua: ACQUIRE });
      redis.defineCommand('rlSettle', { lua: SETTLE });
      this.#redis = redis;
    }
  }

  /** Periodic count of live nodes (card 7.8 heartbeat) for the local limiter's share. */
  startNodeCount(intervalMs = 5_000): void {
    const count = async () => {
      if (!this.#redis) return;
      try {
        let cursor = '0';
        let nodes = 0;
        do {
          const [next, keys] = await this.#redis.scan(
            cursor,
            'MATCH',
            'dirouter:gateway:node:*',
            'COUNT',
            100,
          );
          cursor = next;
          nodes += keys.length;
        } while (cursor !== '0');
        this.#nodes = Math.max(1, nodes);
      } catch {
        // the last valid value is kept
      }
    };
    void count();
    this.#nodesTimer = setInterval(() => void count(), intervalMs);
    this.#nodesTimer.unref();
  }

  stop(): void {
    clearInterval(this.#nodesTimer);
  }

  get nodes(): number {
    return this.#nodes;
  }

  async acquire(scopes: LimitScope[], estimate: number, requestId: string): Promise<Admission> {
    const limited = scopes.filter(
      (s) => s.limit.requestsPerMinute || s.limit.tokensPerMinute || s.limit.maxConcurrency,
    );
    if (limited.length === 0) return { ok: true, headers: {}, settle: noop, release: noop };
    const est = Math.max(0, Math.round(estimate));

    if (this.#redis && Date.now() >= this.#degradedUntil) {
      try {
        const result = await this.#remote(limited, est, requestId);
        this.stats.remote++;
        this.stats.degraded = false;
        if (!result.ok) this.stats.rejected++;
        return result;
      } catch (error) {
        this.#degradedUntil = Date.now() + 1_000;
        if (!this.stats.degraded)
          this.options.logger.warn(
            { err: error },
            'rate limiter: Valkey unavailable, local fallback',
          );
        this.stats.degraded = true;
      }
    }

    if (this.#redis && this.options.failMode() === 'closed') {
      this.stats.rejected++;
      return {
        ok: false,
        scope: limited[0]?.name ?? '',
        kind: 'requests',
        retryAfterMs: 1_000,
        headers: {},
        unavailable: true,
      };
    }
    this.stats.local++;
    // Without Valkey (single-node run) the full share; during an outage, the share split across known nodes.
    const result = this.#local.acquire(limited, est, this.#redis ? this.#nodes : 1);
    if (!result.ok) this.stats.rejected++;
    return result;
  }

  async #remote(scopes: LimitScope[], est: number, requestId: string): Promise<Admission> {
    const redis = this.#redis;
    if (!redis) throw new Error('no redis');
    const keys: string[] = [];
    const args: (string | number)[] = [
      this.#windowMs,
      this.#bucketMs,
      requestId,
      est,
      this.#concTtlMs,
    ];
    for (const s of scopes) {
      keys.push(
        `${this.#prefix}:rpm:${s.name}`,
        `${this.#prefix}:tpm:${s.name}`,
        `${this.#prefix}:conc:${s.name}`,
      );
      args.push(
        s.limit.requestsPerMinute ?? 0,
        s.limit.tokensPerMinute ?? 0,
        s.limit.maxConcurrency ?? 0,
      );
    }
    const raw: (number | string)[] = await withTimeout(
      redis.rlAcquire(keys.length, ...keys, ...args),
      this.#timeoutMs,
    );
    const [ok, failIndex, kind, retryAfter, now] = raw;
    if (Number(ok) !== 1) {
      const scope = scopes[Number(failIndex) - 1];
      return reject(scope?.name ?? '', String(kind) as LimitKind, Number(retryAfter));
    }
    // headers come from the scope with the fewest remaining requests.
    let headers: LimitHeaders = {};
    let bestRemaining = Number.POSITIVE_INFINITY;
    scopes.forEach((s, i) => {
      const rpm = s.limit.requestsPerMinute;
      const used = Number(raw[5 + i * 3] ?? 0) + 1;
      const reset = Number(raw[6 + i * 3] ?? 0);
      const tpmUsed = Number(raw[7 + i * 3] ?? 0) + est;
      if (rpm && rpm - used < bestRemaining) {
        bestRemaining = rpm - used;
        headers = { ...requestHeaders(rpm, used, reset || this.#windowMs) };
      }
      if (s.limit.tokensPerMinute && !headers['x-ratelimit-limit-tokens']) {
        headers['x-ratelimit-limit-tokens'] = String(s.limit.tokensPerMinute);
        headers['x-ratelimit-remaining-tokens'] = String(
          Math.max(0, s.limit.tokensPerMinute - tpmUsed),
        );
        headers['x-ratelimit-reset-tokens'] = formatReset(this.#windowMs);
      }
    });
    const bucket = Math.floor(Number(now) / this.#bucketMs);
    const tpmKeys = scopes
      .filter((s) => s.limit.tokensPerMinute)
      .map((s) => `${this.#prefix}:tpm:${s.name}`);
    const concKeys = scopes
      .filter((s) => s.limit.maxConcurrency)
      .map((s) => `${this.#prefix}:conc:${s.name}`);
    let released = false;
    return {
      ok: true,
      headers,
      settle: (actual) => {
        const delta = Math.round(actual) - est;
        if (tpmKeys.length === 0 || delta === 0) return;
        void redis.rlSettle(tpmKeys.length, ...tpmKeys, bucket, delta).catch(() => undefined);
      },
      release: () => {
        if (released || concKeys.length === 0) return;
        released = true;
        for (const key of concKeys) void redis.zrem(key, requestId).catch(() => undefined);
      },
    };
  }
}

const noop = () => undefined;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Valkey timeout after ${String(ms)}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
