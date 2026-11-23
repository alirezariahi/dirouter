/**
 * Prepaid wallet debits and the Valkey wallet mirror (card 19.1).
 *
 * After a usage event is written, its charge is posted to the double-entry ledger (idempotent by
 * request id, so BullMQ retries never charge twice) and the gateway's reservation for that request
 * is replaced by the new balance in Valkey. `syncWallets` runs on a schedule: it copies every
 * customer balance to Valkey (only when Postgres is newer) and drops abandoned reservations;
 * `auditLedger` checks the ledger invariants.
 */
import {
  type UsageEvent,
  usdToUnits,
  WALLET_APPLY_LUA,
  WALLET_SYNC_LUA,
  walletHoldsKey,
  walletKey,
} from '@dirouter/contracts';
import {
  activeSubscription,
  allowanceLeft,
  chargeUsageInTransaction,
  checkLedger,
  fromUnits,
  leftOf,
  type PrismaClient,
  renewSubscriptions,
  toUnits,
} from '@dirouter/db';
import type { Logger } from '@dirouter/shared';
import type { Redis } from 'ioredis';

type WalletRedis = Redis & {
  walletApply(...args: (string | number)[]): Promise<number>;
  walletSync(...args: (string | number)[]): Promise<number>;
};

function withScripts(redis: Redis): WalletRedis {
  const r = redis as WalletRedis;
  if (typeof r.walletApply !== 'function') {
    r.defineCommand('walletApply', { numberOfKeys: 2, lua: WALLET_APPLY_LUA });
    r.defineCommand('walletSync', { numberOfKeys: 2, lua: WALLET_SYNC_LUA });
  }
  return r;
}

/** What the customer pays for the event: the sale price when present, otherwise the cost. */
export const chargeOf = (event: UsageEvent) => event.chargeUsd ?? event.costUsd;

export interface WalletChargeOutcome {
  charged: boolean;
  /** Paid from the plan allowance (card 19.4). */
  allowanceUsd?: string;
  collectedUsd?: string;
  writtenOffUsd?: string;
}

/**
 * Charges one request: the plan allowance first, the wallet for the rest. One database
 * transaction, idempotent by request id (`subscription_usage` and `usage:<requestId>`), so a
 * BullMQ retry never consumes allowance or credit twice.
 */
export async function chargeWallet(
  db: PrismaClient,
  redis: Redis,
  event: UsageEvent,
  logger: Logger,
): Promise<WalletChargeOutcome> {
  const walletId = event.walletId;
  if (!walletId) return { charged: false };
  const r = withScripts(redis);
  const amount = toUnits(chargeOf(event));
  const release = (state?: { balanceUsd: string; version: number }, quota = 0n) =>
    r.walletApply(
      walletKey(walletId),
      walletHoldsKey(walletId),
      event.requestId,
      state ? usdToUnits(state.balanceUsd) : 0,
      state?.version ?? -1,
      Number(quota),
    );
  if (amount <= 0n) {
    // Nothing to post; make sure no reservation is left behind for this request.
    await release();
    return { charged: false };
  }
  const at = new Date(event.occurredAt);
  const outcome = await db.$transaction(async (tx) => {
    const [seen] = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT (SELECT count(*) FROM "subscription_usage" WHERE "request_id" = ${event.requestId})
           + (SELECT count(*) FROM "wallet_transactions" WHERE "idempotency_key" = ${`usage:${event.requestId}`}) AS "n"`;
    if (Number(seen?.n ?? 0) > 0) return undefined;

    let covered = 0n;
    const sub = await activeSubscription(tx, event.organizationId, at, true);
    if (sub) {
      const left = leftOf(sub);
      covered = left < amount ? left : amount;
      if (covered > 0n) {
        await tx.$executeRaw`
          INSERT INTO "subscription_usage" ("request_id", "subscription_id", "amount_usd", "period_start")
          VALUES (${event.requestId}, ${sub.id}, ${fromUnits(covered)}::numeric, ${sub.period_start})`;
        await tx.$executeRaw`
          UPDATE "subscriptions" SET "used_usd" = "used_usd" + ${fromUnits(covered)}::numeric,
                 "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${sub.id}`;
      }
    }
    const remainder = amount - covered;
    let charged: Awaited<ReturnType<typeof chargeUsageInTransaction>> | undefined;
    let state: { balanceUsd: string; version: number };
    if (remainder > 0n) {
      charged = await chargeUsageInTransaction(tx, {
        requestId: event.requestId,
        walletId,
        amountUsd: fromUnits(remainder),
        metadata: {
          organizationId: event.organizationId,
          projectId: event.projectId,
          apiKeyId: event.virtualKeyId,
          model: event.resolvedModelId,
          costUsd: event.costUsd,
          chargeUsd: fromUnits(amount),
          ...(covered > 0n ? { allowanceUsd: fromUnits(covered) } : {}),
        },
      });
      const w = charged.wallets.find((x) => x.walletId === walletId);
      state = { balanceUsd: w?.balanceUsd ?? '0', version: w?.version ?? -1 };
    } else {
      // Paid entirely from the allowance: no money moves, but Valkey must see the new allowance.
      const [w] = await tx.$queryRaw<{ balance: string; version: number }[]>`
        UPDATE "wallets" SET "version" = "version" + 1, "updated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${walletId} RETURNING "balance_usd"::text AS "balance", "version"`;
      state = { balanceUsd: w?.balance ?? '0', version: w?.version ?? -1 };
    }
    return {
      state,
      quota: await allowanceLeft(tx, event.organizationId, new Date()),
      covered,
      charged,
    };
  });
  if (!outcome) {
    // Already charged (a retry): only make sure the reservation is gone.
    await release();
    return { charged: false };
  }
  await release(outcome.state, outcome.quota);
  const writtenOff = outcome.charged?.writtenOffUsd ?? '0.00000000';
  if (writtenOff !== '0.00000000')
    logger.warn(
      { requestId: event.requestId, walletId, writtenOffUsd: writtenOff },
      'wallet could not cover the charge; shortfall written off',
    );
  return {
    charged: true,
    allowanceUsd: fromUnits(outcome.covered),
    collectedUsd: outcome.charged?.collectedUsd ?? '0.00000000',
    writtenOffUsd: writtenOff,
  };
}

export async function syncWallets(
  db: PrismaClient,
  redis: Redis,
  now: () => number = Date.now,
): Promise<{ wallets: number; heldUnits: number }> {
  const r = withScripts(redis);
  const wallets = await db.wallet.findMany({
    where: { kind: 'CUSTOMER' },
    select: { id: true, organizationId: true, balanceUsd: true, version: true },
  });
  let heldUnits = 0;
  for (const w of wallets) {
    const quota = w.organizationId
      ? await allowanceLeft(db, w.organizationId, new Date(now()))
      : 0n;
    heldUnits += await r.walletSync(
      walletKey(w.id),
      walletHoldsKey(w.id),
      usdToUnits(w.balanceUsd.toFixed(8)),
      w.version,
      now(),
      Number(quota),
    );
  }
  return { wallets: wallets.length, heldUnits };
}

/** Full ledger audit (a table scan, so it runs hourly rather than with every sync). */
export async function auditLedger(db: PrismaClient, logger: Logger) {
  const check = await checkLedger(db);
  const ok =
    check.totalUsd === '0.00000000' &&
    check.unbalancedTransactions === 0 &&
    check.driftedWallets === 0;
  if (!ok) logger.error({ ledger: check }, 'wallet ledger invariant violated');
  return { ...check, ok };
}

/** Starts due plan periods and mirrors the charged wallets (card 19.4). */
export async function renewPlans(db: PrismaClient, redis: Redis, now = new Date()) {
  const r = withScripts(redis);
  const results = await renewSubscriptions(db, now);
  for (const result of results) {
    if (!result.wallet) continue;
    const wallet = await db.wallet.findUnique({
      where: { id: result.wallet.walletId },
      select: { organizationId: true },
    });
    const quota = wallet?.organizationId ? await allowanceLeft(db, wallet.organizationId, now) : 0n;
    await r.walletApply(
      walletKey(result.wallet.walletId),
      walletHoldsKey(result.wallet.walletId),
      '',
      usdToUnits(result.wallet.balanceUsd),
      result.wallet.version,
      Number(quota),
    );
  }
  const count = (status: string) => results.filter((x) => x.status === status).length;
  return { renewed: count('active'), pastDue: count('past_due'), cancelled: count('cancelled') };
}
