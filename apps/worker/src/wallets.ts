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
import { chargeUsage, checkLedger, type PrismaClient, toUnits } from '@dirouter/db';
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
  collectedUsd?: string;
  writtenOffUsd?: string;
}

export async function chargeWallet(
  db: PrismaClient,
  redis: Redis,
  event: UsageEvent,
  logger: Logger,
): Promise<WalletChargeOutcome> {
  const walletId = event.walletId;
  if (!walletId) return { charged: false };
  const r = withScripts(redis);
  const amount = chargeOf(event);
  if (toUnits(amount) <= 0n) {
    // Nothing to post; make sure no reservation is left behind for this request.
    await r.walletApply(walletKey(walletId), walletHoldsKey(walletId), event.requestId, 0, -1);
    return { charged: false };
  }
  const result = await chargeUsage(db, {
    requestId: event.requestId,
    walletId,
    amountUsd: amount,
    metadata: {
      organizationId: event.organizationId,
      projectId: event.projectId,
      apiKeyId: event.virtualKeyId,
      model: event.resolvedModelId,
      costUsd: event.costUsd,
    },
  });
  const state = result.wallets.find((w) => w.walletId === walletId);
  await r.walletApply(
    walletKey(walletId),
    walletHoldsKey(walletId),
    event.requestId,
    state ? usdToUnits(state.balanceUsd) : 0,
    state?.version ?? -1,
  );
  if (result.created && result.writtenOffUsd !== '0.00000000')
    logger.warn(
      { requestId: event.requestId, walletId, writtenOffUsd: result.writtenOffUsd },
      'wallet could not cover the charge; shortfall written off',
    );
  return result.created
    ? { charged: true, collectedUsd: result.collectedUsd, writtenOffUsd: result.writtenOffUsd }
    : { charged: false };
}

export async function syncWallets(
  db: PrismaClient,
  redis: Redis,
  now: () => number = Date.now,
): Promise<{ wallets: number; heldUnits: number }> {
  const r = withScripts(redis);
  const wallets = await db.wallet.findMany({
    where: { kind: 'CUSTOMER' },
    select: { id: true, balanceUsd: true, version: true },
  });
  let heldUnits = 0;
  for (const w of wallets)
    heldUnits += await r.walletSync(
      walletKey(w.id),
      walletHoldsKey(w.id),
      usdToUnits(w.balanceUsd.toFixed(8)),
      w.version,
      now(),
    );
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
