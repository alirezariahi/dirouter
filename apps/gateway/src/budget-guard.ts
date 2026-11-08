/**
 * بودجهٔ کلید، پروژه و تیم (کارت ۶.۳).
 *
 * - پیش از درخواست: اگر شمارندهٔ دورهٔ جاری به سقف (دلار یا توکن) رسیده باشد، 429
 *   `budget_exceeded`. هزینهٔ خود درخواست پیش از اجرا معلوم نیست، پس درخواستی که شروع
 *   شده تمام می‌شود و «درخواست بعدی» رد می‌شود.
 * - بعد از درخواست: افزایش اتمیک شمارنده‌ها با هزینه و توکن واقعی. عبور از هر آستانه
 *   (پیش‌فرض ۵۰/۸۰/۱۰۰٪) دقیقاً یک بار رویداد می‌سازد، حتی با چند replica (SET NX).
 * - قطعی Valkey: failMode=open یعنی عبور (کسری با reconcile از ledger جبران می‌شود) و
 *   failMode=closed یعنی 429.
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
      /** شروع دورهٔ بعد (برای Retry-After). */
      resetAt: Date;
      unavailable?: boolean;
    };

/** KEYS: کلید شمارنده‌ها؛ ARGV: usdDelta, tokenDelta, nowMs, سپس expireAt هر کلید */
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

/** شمارنده تا یک هفته بعد از پایان دوره نگه داشته می‌شود (برای گزارش و reconcile). */
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
    // بدون Valkey (تک‌نودی بدون صف) بودجه قابل شمارش نیست.
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

  /** افزایش شمارنده‌ها بعد از پاسخ؛ هرگز await نمی‌شود و خطا نمی‌دهد. */
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
      // فقط replicaای که اول برسد رویداد می‌سازد.
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
