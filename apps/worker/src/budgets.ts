/**
 * Budgets in the worker (card 6.3):
 * - `processBudgetAlerts`: threshold-crossing events the gateway left in Valkey are recorded in audit_logs
 *   (action `budget.threshold_crossed`).
 * - `reconcileBudgets`: each budget's Valkey counter is reconciled with the ledger for the current period.
 *   The ledger is the source of truth but lags the counter by a few seconds (usage queue). So:
 *   - a "quiet" counter (no increase in the last `quietMs`) or a missing one is set exactly equal to the ledger,
 *     whether it was higher or lower.
 *   - an active counter is only raised (it never stays below the ledger), so events
 *     in flight are not double-counted.
 *   All of this runs in one atomic Lua script so concurrent gateway increments are not lost.
 */
import {
  BUDGET_ALERTS_KEY,
  type BudgetAlertEvent,
  type BudgetPeriod,
  budgetCounterKey,
  budgetPeriodKey,
  budgetPeriodRange,
  END_USER_DEFAULT,
  endUserCounterId,
  usdToUnits,
} from '@dirouter/contracts';
import { type Logger, prefixedId } from '@dirouter/shared';
import type { Redis } from 'ioredis';

export interface BudgetDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  auditLog: { createMany(args: { data: unknown[] }): Promise<unknown> };
}

/**
 * Ledger condition of each budget scope; `$1` is the scope id. Every query is also limited to the
 * budget's organization, so a scope id can never pick up another tenant's spend.
 */
const SCOPE_FILTER: Record<string, string> = {
  api_key: 'api_key_id = $1',
  project: 'project_id = $1',
  team: 'team_id = $1',
  // Card 33.1: the whole organization, a member's keys, a model and a provider.
  organization: 'organization_id = $1',
  user: 'api_key_id IN (SELECT id FROM api_keys WHERE created_by_id = $1)',
  model: 'model_id = $1',
  provider: 'provider_id = $1',
  // Card 33.2: one end user; the `*` defaults are counted per end user below.
  end_user: 'end_user = $1',
  // Card 33.4: requests carrying the tag, and requests of the cost center.
  tag: '$1 = ANY(tags)',
  cost_center: 'cost_center = $1',
  // Card 33.3: `<key id>|<model>`; the name the client asked for, or the model that served it.
  api_key_model: `api_key_id = split_part($1, '|', 1)
    AND (requested_model = split_part($1, '|', 2)
         OR model_id IN (SELECT id FROM models WHERE slug = split_part($1, '|', 2)))`,
};

/** KEYS[1]: counter; ARGV: ledgerUsd, ledgerTokens, nowMs, quietMs, expireAtMs */
const RECONCILE = `
local cur = redis.call('HMGET', KEYS[1], 'usd', 'tokens', 'ts')
local usd = tonumber(cur[1] or '0')
local tokens = tonumber(cur[2] or '0')
local ts = tonumber(cur[3] or '0')
local lUsd = tonumber(ARGV[1])
local lTok = tonumber(ARGV[2])
local quiet = (tonumber(ARGV[3]) - ts) > tonumber(ARGV[4])
local nUsd, nTok = usd, tokens
if quiet then
  nUsd, nTok = lUsd, lTok
else
  if lUsd > usd then nUsd = lUsd end
  if lTok > tokens then nTok = lTok end
end
if nUsd ~= usd or nTok ~= tokens or cur[1] == false then
  redis.call('HSET', KEYS[1], 'usd', nUsd, 'tokens', nTok)
  if cur[3] == false then redis.call('HSET', KEYS[1], 'ts', '0') end
  redis.call('PEXPIREAT', KEYS[1], ARGV[5])
end
return {usd, tokens, nUsd, nTok}
`;

type RedisWithReconcile = Redis & {
  budgetReconcile(numKeys: number, ...args: (string | number)[]): Promise<number[]>;
};

export interface ReconcileResult {
  budgets: number;
  adjusted: number;
  drift: {
    budgetId: string;
    periodKey: string;
    counterUsd: number;
    ledgerUsd: number;
    counterTokens: number;
    ledgerTokens: number;
  }[];
}

export async function reconcileBudgets(
  db: BudgetDb,
  redis: Redis,
  logger: Logger,
  options: { now?: Date; quietMs?: number } = {},
): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const quietMs = options.quietMs ?? 120_000;
  const r = redis as RedisWithReconcile;
  if (typeof r.budgetReconcile !== 'function')
    r.defineCommand('budgetReconcile', { lua: RECONCILE });

  const budgets = await db.$queryRawUnsafe<
    {
      id: string;
      organization_id: string;
      scope: string;
      scope_id: string;
      period: BudgetPeriod;
    }[]
  >(
    'SELECT id, organization_id, scope::text AS scope, scope_id, period::text AS period FROM budgets',
  );
  const result: ReconcileResult = { budgets: budgets.length, adjusted: 0, drift: [] };
  const adjust = async (
    budgetId: string,
    counterId: string,
    periodKey: string,
    usdText: string,
    tokensText: string,
    expireAt: number,
  ) => {
    const ledgerUsd = usdToUnits(usdText);
    const ledgerTokens = Number(tokensText);
    const [counterUsd = 0, counterTokens = 0, nextUsd = 0, nextTokens = 0] =
      await r.budgetReconcile(
        1,
        budgetCounterKey(counterId, periodKey),
        ledgerUsd,
        ledgerTokens,
        now.getTime(),
        quietMs,
        expireAt,
      );
    if (nextUsd !== counterUsd || nextTokens !== counterTokens) {
      result.adjusted++;
      result.drift.push({
        budgetId,
        periodKey,
        counterUsd,
        ledgerUsd,
        counterTokens,
        ledgerTokens,
      });
    }
  };
  for (const b of budgets) {
    if (b.scope === 'end_user' && b.scope_id === END_USER_DEFAULT) {
      // Default end-user budgets count each end user on a counter of its own (card 33.2).
      const { start, end } = budgetPeriodRange(b.period, now);
      const rows = await db.$queryRawUnsafe<{ end_user: string; usd: string; tokens: string }[]>(
        `SELECT end_user, COALESCE(SUM(cost_usd), 0)::text AS usd,
                COALESCE(SUM(tokens), 0)::bigint::text AS tokens
           FROM usage_ledger
          WHERE organization_id = $1 AND end_user IS NOT NULL
            AND occurred_at >= $2 AND occurred_at < $3
          GROUP BY end_user`,
        b.organization_id,
        start,
        end,
      );
      for (const row of rows)
        await adjust(
          b.id,
          endUserCounterId(b.id, row.end_user),
          budgetPeriodKey(b.period, now),
          row.usd,
          row.tokens,
          end.getTime() + 7 * 86_400_000,
        );
      continue;
    }
    const filter = SCOPE_FILTER[b.scope];
    if (!filter) continue;
    const { start, end } = budgetPeriodRange(b.period, now);
    const [sum] = await db.$queryRawUnsafe<{ usd: string; tokens: string }[]>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS usd, COALESCE(SUM(tokens), 0)::bigint::text AS tokens
         FROM usage_ledger
        WHERE ${filter} AND organization_id = $4 AND occurred_at >= $2 AND occurred_at < $3`,
      b.scope_id,
      start,
      end,
      b.organization_id,
    );
    await adjust(
      b.id,
      b.id,
      budgetPeriodKey(b.period, now),
      sum?.usd ?? '0',
      sum?.tokens ?? '0',
      end.getTime() + 7 * 86_400_000,
    );
  }
  if (result.adjusted > 0)
    logger.info({ drift: result.drift }, 'budget counters reconciled with ledger');
  return result;
}

export async function processBudgetAlerts(
  db: BudgetDb,
  redis: Redis,
  logger: Logger,
  batch = 200,
): Promise<number> {
  const raw = await redis.rpop(BUDGET_ALERTS_KEY, batch);
  if (!raw || raw.length === 0) return 0;
  const rows = raw.flatMap((line) => {
    try {
      const e = JSON.parse(line) as BudgetAlertEvent;
      return [
        {
          id: prefixedId('aud'),
          organizationId: e.organizationId,
          actorUserId: null,
          action: 'budget.threshold_crossed',
          targetType: 'budget',
          targetId: e.budgetId,
          diff: {
            threshold: e.threshold,
            kind: e.kind,
            spent: e.spent,
            limit: e.limit,
            scope: e.scope,
            scopeId: e.scopeId,
            period: e.period,
            periodKey: e.periodKey,
            at: e.at,
          },
        },
      ];
    } catch {
      logger.warn({ line: line.slice(0, 200) }, 'invalid budget alert dropped');
      return [];
    }
  });
  try {
    await db.auditLog.createMany({ data: rows });
  } catch (error) {
    // put back on the queue so it is retried on the next tick.
    await redis.rpush(BUDGET_ALERTS_KEY, ...raw);
    throw error;
  }
  return rows.length;
}
