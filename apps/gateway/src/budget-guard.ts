/**
 * Budgets (card 6.3) for keys, projects and teams, and since card 33.1 for the organization, a
 * member's keys, models and providers, in daily, weekly, monthly and yearly periods.
 *
 * - Before the request: if the current period's counter has reached the cap (dollars or tokens), 429
 *   `budget_exceeded`. The request's own cost is unknown before it runs, so a request that has started
 *   finishes, and the "next request" is rejected.
 * - After the request: atomically increment the counters with the real cost and tokens. Crossing each threshold
 *   (default 50/80/100%) creates exactly one event, even with multiple replicas (SET NX).
 * - Budgets with a `target` (a model, provider or credential) do not reject: when exhausted they are
 *   reported back so the caller takes the matching candidates out of the route, and they only count
 *   requests that the matching candidate served.
 * - Every budget of a request is read by one Lua script and written by another: one command
 *   each, however many scopes cover the request (card 33.1).
 * - Valkey outage: failMode=open means pass through (the shortfall is corrected by reconciling from the ledger), and
 *   failMode=closed means 429.
 */
import {
  BUDGET_ALERTS_KEY,
  type BudgetAlertEvent,
  type BudgetConfig,
  type BudgetScope,
  type QuotaWindowConfig,
  quotaWindowKey,
  budgetCounterKey,
  budgetPeriodKey,
  budgetPeriodRange,
  unitsToUsd,
  usdToUnits,
} from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';
import type { Redis } from 'ioredis';

/** The model, provider and credential a request was (or would be) served by. */
export interface BudgetTarget {
  modelId?: string;
  providerId?: string;
  credentialId?: string;
}

export interface ScopedBudget {
  budget: BudgetConfig;
  scope: BudgetScope;
  scopeId: string;
  organizationId: string;
  /** Valkey counter id; the budget id unless one budget counts many subjects separately. */
  counterId?: string;
  /**
   * Only candidates matching every given field count against this budget, and exhaustion takes
   * them out of the route instead of rejecting the request.
   */
  target?: BudgetTarget;
}

/** Whether a candidate is covered by a targeted budget. */
export function matchesTarget(target: BudgetTarget, served: BudgetTarget): boolean {
  return (
    (target.modelId === undefined || target.modelId === served.modelId) &&
    (target.providerId === undefined || target.providerId === served.providerId) &&
    (target.credentialId === undefined || target.credentialId === served.credentialId)
  );
}

/** One quota window of one credential (card 32.6). */
export interface QuotaRef {
  credentialId: string;
  window: QuotaWindowConfig;
}

/** A quota window's state: used up or not, and when it resets (undefined before first use). */
export interface QuotaState {
  ref: QuotaRef;
  exhausted: boolean;
  resetAt?: Date;
}

const counterKey = (b: ScopedBudget, now: Date) =>
  budgetCounterKey(b.counterId ?? b.budget.id, budgetPeriodKey(b.budget.period, now));

export type BudgetCheck =
  | {
      ok: true;
      /** Targeted budgets that are used up, with the start of their next period. */
      exhausted?: { budget: ScopedBudget; resetAt: Date }[];
      /** The quota windows asked about (card 32.6). */
      quotas?: QuotaState[];
    }
  | {
      ok: false;
      scope: ScopedBudget['scope'];
      period: BudgetConfig['period'];
      kind: 'usd' | 'tokens';
      limit: string;
      /** Start of the next period (for Retry-After). */
      resetAt: Date;
      unavailable?: boolean;
    };

/** Percent of the current period's budget spent per scope (card 32.2). */
export interface BudgetUsage {
  key: number;
  project: number;
  team: number;
  /** The highest of the three. */
  max: number;
}

/** KEYS: counter keys; ARGV: usdDelta, tokenDelta, nowMs, then expireAt for each key */
const RECORD = `
local out = {}
for i = 1, #KEYS do
  local usd = redis.call('HINCRBY', KEYS[i], 'usd', ARGV[1])
  local tokens = redis.call('HINCRBY', KEYS[i], 'tokens', ARGV[2])
  redis.call('HSET', KEYS[i], 'ts', ARGV[3])
  redis.call('PEXPIREAT', KEYS[i], ARGV[3 + i])
  out[#out+1] = usd
  out[#out+1] = tokens
end
return out
`;

/**
 * KEYS: budget counter keys, then quota window keys; ARGV: the number of budget keys.
 * Output: usd and tokens of each counter, then requests, tokens, usd and PTTL of each window.
 */
const READ = `
local out = {}
local budgets = tonumber(ARGV[1] or #KEYS)
for i = 1, #KEYS do
  if i <= budgets then
    local v = redis.call('HMGET', KEYS[i], 'usd', 'tokens')
    out[#out+1] = v[1] or '0'
    out[#out+1] = v[2] or '0'
  else
    local v = redis.call('HMGET', KEYS[i], 'requests', 'tokens', 'usd')
    out[#out+1] = v[1] or '0'
    out[#out+1] = v[2] or '0'
    out[#out+1] = v[3] or '0'
    out[#out+1] = redis.call('PTTL', KEYS[i])
  end
end
return out
`;

/**
 * KEYS: quota window keys; ARGV: usdDelta, tokenDelta, then the window length of each key (ms).
 * A window starts with its first request and lasts its length (the TTL is set only then).
 */
const QUOTA_RECORD = `
for i = 1, #KEYS do
  redis.call('HINCRBY', KEYS[i], 'requests', 1)
  redis.call('HINCRBY', KEYS[i], 'tokens', ARGV[2])
  redis.call('HINCRBY', KEYS[i], 'usd', ARGV[1])
  if redis.call('PTTL', KEYS[i]) < 0 then redis.call('PEXPIRE', KEYS[i], ARGV[2 + i]) end
end
return 1
`;

type RedisWithBudget = Redis & {
  budgetRead(numKeys: number, ...args: (string | number)[]): Promise<(string | number)[]>;
  quotaRecord(numKeys: number, ...args: (string | number)[]): Promise<number>;
  budgetRecord(numKeys: number, ...args: (string | number)[]): Promise<number[]>;
};

/** Counters are kept for one week after the period ends (for reporting and reconciliation). */
const KEEP_AFTER_PERIOD_MS = 7 * 86_400_000;

export class BudgetGuard {
  readonly #redis: RedisWithBudget | undefined;
  readonly #timeoutMs: number;
  readonly stats = { checks: 0, rejected: 0, recorded: 0, alerts: 0, errors: 0 };
  readonly #usageCache = new Map<string, { percent: number; expires: number }>();

  constructor(
    private readonly options: {
      redis?: Redis;
      logger: Logger;
      failMode: () => 'open' | 'closed';
      commandTimeoutMs?: number;
      clock?: () => Date;
    },
  ) {
    this.#timeoutMs = options.commandTimeoutMs ?? 100;
    if (options.redis) {
      const redis = options.redis as RedisWithBudget;
      redis.defineCommand('budgetRecord', { lua: RECORD });
      redis.defineCommand('budgetRead', { lua: READ });
      redis.defineCommand('quotaRecord', { lua: QUOTA_RECORD });
      this.#redis = redis;
    }
  }

  #now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  async check(budgets: ScopedBudget[], quotas: QuotaRef[] = []): Promise<BudgetCheck> {
    if (budgets.length === 0 && quotas.length === 0) return { ok: true };
    const redis = this.#redis;
    // Without Valkey (single node, no queue) the budget cannot be counted.
    if (!redis) return { ok: true };
    this.stats.checks++;
    const now = this.#now();
    try {
      const keys = budgets.map((b) => counterKey(b, now));
      const quotaKeys = quotas.map((q) => quotaWindowKey(q.credentialId, q.window.id));
      const values = await withTimeout(
        redis.budgetRead(keys.length + quotaKeys.length, ...keys, ...quotaKeys, keys.length),
        this.#timeoutMs,
      );
      const states: QuotaState[] = quotas.map((ref, j) => {
        const at = keys.length * 2 + j * 4;
        const [requests, tokens, usd, pttl] = [0, 1, 2, 3].map((k) => Number(values[at + k] ?? 0));
        const w = ref.window;
        const exhausted =
          (w.limitRequests !== undefined && (requests ?? 0) >= w.limitRequests) ||
          (w.limitTokens !== undefined && (tokens ?? 0) >= w.limitTokens) ||
          (w.limitUsd !== undefined && (usd ?? 0) >= usdToUnits(w.limitUsd));
        return {
          ref,
          exhausted,
          ...(pttl !== undefined && pttl > 0 ? { resetAt: new Date(now.getTime() + pttl) } : {}),
        };
      });
      const exhausted: { budget: ScopedBudget; resetAt: Date }[] = [];
      for (const [i, b] of budgets.entries()) {
        const usd = Number(values[i * 2] ?? 0);
        const tokens = Number(values[i * 2 + 1] ?? 0);
        const { end } = budgetPeriodRange(b.budget.period, now);
        if (b.target) {
          const over =
            (b.budget.limitUsd !== undefined && usd >= usdToUnits(b.budget.limitUsd)) ||
            (b.budget.limitTokens !== undefined && tokens >= b.budget.limitTokens);
          if (over) exhausted.push({ budget: b, resetAt: end });
          continue;
        }
        if (b.budget.limitUsd !== undefined && usd >= usdToUnits(b.budget.limitUsd)) {
          this.stats.rejected++;
          return {
            ok: false,
            scope: b.scope,
            period: b.budget.period,
            kind: 'usd',
            limit: b.budget.limitUsd,
            resetAt: end,
          };
        }
        if (b.budget.limitTokens !== undefined && tokens >= b.budget.limitTokens) {
          this.stats.rejected++;
          return {
            ok: false,
            scope: b.scope,
            period: b.budget.period,
            kind: 'tokens',
            limit: String(b.budget.limitTokens),
            resetAt: end,
          };
        }
      }
      return {
        ok: true,
        ...(exhausted.length > 0 ? { exhausted } : {}),
        ...(states.length > 0 ? { quotas: states } : {}),
      };
    } catch (error) {
      this.stats.errors++;
      this.options.logger.warn({ err: error }, 'budget check failed (Valkey)');
      if (this.options.failMode() === 'open') return { ok: true };
      const first = budgets[0];
      this.stats.rejected++;
      return {
        ok: false,
        scope: first?.scope ?? 'key',
        period: first?.budget.period ?? 'daily',
        kind: 'usd',
        limit: '',
        resetAt: new Date(now.getTime() + 60_000),
        unavailable: true,
      };
    }
  }

  /**
   * Share of each scope's budget already spent in the current period, in percent (card 32.2): the
   * highest of the dollar and token shares over the scope's budgets, 0 for a scope without one.
   * Read by routing rules (`budget.team > 80`). Values are cached for a second so a busy key does
   * not add a Valkey round trip to every request; without Valkey, or when it fails, every share
   * reads 0 (a rule cannot be fooled into spending more, only into not switching early).
   */
  async usage(budgets: ScopedBudget[]): Promise<BudgetUsage> {
    const out: BudgetUsage = { key: 0, project: 0, team: 0, max: 0 };
    const redis = this.#redis;
    if (!redis || budgets.length === 0) return out;
    const now = this.#now();
    const nowMs = now.getTime();
    const missing = budgets.filter((b) => {
      const hit = this.#usageCache.get(b.budget.id);
      return !hit || hit.expires <= nowMs;
    });
    if (missing.length > 0) {
      try {
        const pipeline = redis.pipeline();
        for (const b of missing)
          pipeline.hmget(
            budgetCounterKey(b.budget.id, budgetPeriodKey(b.budget.period, now)),
            'usd',
            'tokens',
          );
        const results = await withTimeout(pipeline.exec(), this.#timeoutMs);
        if (this.#usageCache.size > 10_000) this.#usageCache.clear();
        for (const [i, b] of missing.entries()) {
          const [error, values] = results?.[i] ?? [null, null];
          if (error) throw error;
          const [usdRaw, tokensRaw] = (values as (string | null)[] | null) ?? [null, null];
          const usdShare =
            b.budget.limitUsd !== undefined && usdToUnits(b.budget.limitUsd) > 0
              ? (Number(usdRaw ?? 0) / usdToUnits(b.budget.limitUsd)) * 100
              : 0;
          const tokenShare =
            b.budget.limitTokens !== undefined
              ? (Number(tokensRaw ?? 0) / b.budget.limitTokens) * 100
              : 0;
          this.#usageCache.set(b.budget.id, {
            percent: Math.max(usdShare, tokenShare),
            expires: nowMs + 1_000,
          });
        }
      } catch (error) {
        this.stats.errors++;
        this.options.logger.warn({ err: error }, 'budget usage lookup failed (Valkey)');
        return out;
      }
    }
    for (const b of budgets) {
      const percent = this.#usageCache.get(b.budget.id)?.percent ?? 0;
      out[b.scope] = Math.max(out[b.scope], percent);
      out.max = Math.max(out.max, percent);
    }
    return out;
  }

  /**
   * Increments the counters after the response; never awaited and never throws. Targeted budgets
   * only count when `served` (the candidate that answered) matches them.
   */
  record(
    scoped: ScopedBudget[],
    costUsd: string,
    tokens: number,
    served?: BudgetTarget,
    quotas: QuotaRef[] = [],
  ): void {
    const redis = this.#redis;
    // Quota windows of the credential that answered count every request it served (card 32.6).
    const windows = served ? quotas.filter((q) => q.credentialId === served.credentialId) : [];
    if (redis && windows.length > 0)
      void redis
        .quotaRecord(
          windows.length,
          ...windows.map((q) => quotaWindowKey(q.credentialId, q.window.id)),
          Math.max(0, usdToUnits(costUsd)),
          Math.max(0, Math.round(tokens)),
          ...windows.map((q) => q.window.hours * 3_600_000),
        )
        .catch(() => {
          this.stats.errors++;
        });
    const budgets = scoped.filter(
      (b) => !b.target || (served !== undefined && matchesTarget(b.target, served)),
    );
    if (!redis || budgets.length === 0) return;
    const usdDelta = usdToUnits(costUsd);
    const tokenDelta = Math.max(0, Math.round(tokens));
    if (usdDelta <= 0 && tokenDelta === 0) return;
    const now = this.#now();
    const keys = budgets.map((b) => counterKey(b, now));
    const expireAt = budgets.map(
      (b) => budgetPeriodRange(b.budget.period, now).end.getTime() + KEEP_AFTER_PERIOD_MS,
    );
    void redis
      .budgetRecord(keys.length, ...keys, usdDelta, tokenDelta, now.getTime(), ...expireAt)
      .then(async (values) => {
        this.stats.recorded++;
        for (const [i, b] of budgets.entries()) {
          const usd = values[i * 2] ?? 0;
          const tok = values[i * 2 + 1] ?? 0;
          await this.#alerts(redis, b, now, 'usd', usd - usdDelta, usd);
          await this.#alerts(redis, b, now, 'tokens', tok - tokenDelta, tok);
        }
      })
      .catch((error: unknown) => {
        this.stats.errors++;
        this.options.logger.warn(
          { err: error },
          'budget record failed (Valkey); reconcile will catch up',
        );
      });
  }

  async #alerts(
    redis: Redis,
    b: ScopedBudget,
    now: Date,
    kind: 'usd' | 'tokens',
    before: number,
    after: number,
  ): Promise<void> {
    const limit =
      kind === 'usd'
        ? b.budget.limitUsd !== undefined
          ? usdToUnits(b.budget.limitUsd)
          : undefined
        : b.budget.limitTokens;
    if (!limit) return;
    const periodKey = budgetPeriodKey(b.budget.period, now);
    for (const threshold of b.budget.alertThresholds) {
      const at = (limit * threshold) / 100;
      if (!(before < at && after >= at)) continue;
      // Only the replica that arrives first creates the event.
      const first = await redis.set(
        `dirouter:budget:alerted:${b.counterId ?? b.budget.id}:${periodKey}:${kind}:${String(threshold)}`,
        '1',
        'PX',
        budgetPeriodRange(b.budget.period, now).end.getTime() -
          now.getTime() +
          KEEP_AFTER_PERIOD_MS,
        'NX',
      );
      if (first !== 'OK') continue;
      const event: BudgetAlertEvent = {
        budgetId: b.budget.id,
        organizationId: b.organizationId,
        scope: b.scope,
        scopeId: b.scopeId,
        period: b.budget.period,
        periodKey,
        threshold,
        kind,
        spent: kind === 'usd' ? unitsToUsd(after) : String(after),
        limit: kind === 'usd' ? (b.budget.limitUsd ?? '') : String(limit),
        at: now.toISOString(),
      };
      await redis.lpush(BUDGET_ALERTS_KEY, JSON.stringify(event));
      this.stats.alerts++;
      this.options.logger.info({ budget: event }, 'budget threshold crossed');
    }
  }
}

/** Rejects when a Valkey command takes longer than the hot path can wait. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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
