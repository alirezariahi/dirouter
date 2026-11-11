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
  budgetCounterKey,
  budgetPeriodKey,
  budgetPeriodRange,
  usdToUnits,
} from '@dirouter/contracts';
import { type Logger, prefixedId } from '@dirouter/shared';
import type { Redis } from 'ioredis';

export interface BudgetDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  auditLog: { createMany(args: { data: unknown[] }): Promise<unknown> };
}

const SCOPE_COLUMN: Record<string, string> = {
  api_key: 'api_key_id',
  project: 'project_id',
  team: 'team_id',
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
    { id: string; scope: string; scope_id: string; period: 'daily' | 'monthly' }[]
  >('SELECT id, scope::text AS scope, scope_id, period::text AS period FROM budgets');
  const result: ReconcileResult = { budgets: budgets.length, adjusted: 0, drift: [] };
  for (const b of budgets) {
    const column = SCOPE_COLUMN[b.scope];
    if (!column) continue;
    const { start, end } = budgetPeriodRange(b.period, now);
    const [sum] = await db.$queryRawUnsafe<{ usd: string; tokens: string }[]>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS usd, COALESCE(SUM(tokens), 0)::bigint::text AS tokens
         FROM usage_ledger WHERE ${column} = $1 AND occurred_at >= $2 AND occurred_at < $3`,
      b.scope_id,
      start,
      end,
    );
    const ledgerUsd = usdToUnits(sum?.usd ?? '0');
    const ledgerTokens = Number(sum?.tokens ?? 0);
    const periodKey = budgetPeriodKey(b.period, now);
    const [counterUsd = 0, counterTokens = 0, nextUsd = 0, nextTokens = 0] =
      await r.budgetReconcile(
        1,
        budgetCounterKey(b.id, periodKey),
        ledgerUsd,
        ledgerTokens,
        now.getTime(),
        quietMs,
        end.getTime() + 7 * 86_400_000,
      );
    if (nextUsd !== counterUsd || nextTokens !== counterTokens) {
      result.adjusted++;
      result.drift.push({
        budgetId: b.id,
        periodKey,
        counterUsd,
        ledgerUsd,
        counterTokens,
        ledgerTokens,
      });
    }
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
