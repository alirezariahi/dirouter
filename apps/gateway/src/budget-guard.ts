/**
 * Budget for key, project and team (card 6.3).
 *
 * - Before the request: if the current period's counter has reached the cap (dollars or tokens), 429
 *   `budget_exceeded`. The request's own cost is unknown before it runs, so a request that has started
 *   finishes, and the "next request" is rejected.
 * - After the request: atomically increment the counters with the real cost and tokens. Crossing each threshold
 *   (default 50/80/100%) creates exactly one event, even with multiple replicas (SET NX).
 * - Valkey outage: failMode=open means pass through (the shortfall is corrected by reconciling from the ledger), and
 *   failMode=closed means 429.
 */
import {
  BUDGET_ALERTS_KEY,
  type BudgetAlertEvent,
  type BudgetConfig,
  budgetCounterKey,
  budgetPeriodKey,
  budgetPeriodRange,
  unitsToUsd,
  usdToUnits,
} from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';
import type { Redis } from 'ioredis';

export interface ScopedBudget {
  budget: BudgetConfig;
  scope: 'key' | 'project' | 'team';
  scopeId: string;
  organizationId: string;
}

export type BudgetCheck =
  | { ok: true }
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

type RedisWithBudget = Redis & {
  budgetRecord(numKeys: number, ...args: (string | number)[]): Promise<number[]>;
};

/** Counters are kept for one week after the period ends (for reporting and reconciliation). */
const KEEP_AFTER_PERIOD_MS = 7 * 86_400_000;

export class BudgetGuard {
  readonly #redis: RedisWithBudget | undefined;
  readonly #timeoutMs: number;
  readonly stats = { checks: 0, rejected: 0, recorded: 0, alerts: 0, errors: 0 };

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
      this.#redis = redis;
    }
  }

  #now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  async check(budgets: ScopedBudget[]): Promise<BudgetCheck> {
    if (budgets.length === 0) return { ok: true };
    const redis = this.#redis;
    // Without Valkey (single node, no queue) the budget cannot be counted.
    if (!redis) return { ok: true };
    this.stats.checks++;
    const now = this.#now();
    try {
      const pipeline = redis.pipeline();
      for (const b of budgets)
        pipeline.hmget(
          budgetCounterKey(b.budget.id, budgetPeriodKey(b.budget.period, now)),
          'usd',
          'tokens',
        );
      const results = await withTimeout(pipeline.exec(), this.#timeoutMs);
      for (const [i, b] of budgets.entries()) {
        const [error, values] = results?.[i] ?? [null, null];
        if (error) throw error;
        const [usdRaw, tokensRaw] = (values as (string | null)[] | null) ?? [null, null];
        const usd = Number(usdRaw ?? 0);
        const tokens = Number(tokensRaw ?? 0);
        const { end } = budgetPeriodRange(b.budget.period, now);
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
      return { ok: true };
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

  /** Increments the counters after the response; never awaited and never throws. */
  record(budgets: ScopedBudget[], costUsd: string, tokens: number): void {
    const redis = this.#redis;
    if (!redis || budgets.length === 0) return;
    const usdDelta = usdToUnits(costUsd);
    const tokenDelta = Math.max(0, Math.round(tokens));
    if (usdDelta <= 0 && tokenDelta === 0) return;
    const now = this.#now();
    const keys = budgets.map((b) =>
      budgetCounterKey(b.budget.id, budgetPeriodKey(b.budget.period, now)),
    );
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
        `dirouter:budget:alerted:${b.budget.id}:${periodKey}:${kind}:${String(threshold)}`,
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
