/**
 * Monthly plans (card 19.4). Each period's fee is posted to the ledger when the period starts
 * (wallet → revenue, idempotent per subscription and period start); the plan's allowance is then
 * consumed by usage before the wallet is (see the worker's charge). A wallet that cannot pay the
 * fee puts the subscription PAST_DUE: no allowance until a later attempt succeeds.
 */
import { Prisma, type PrismaClient } from '../generated/client/index.js';
import {
  fromUnits,
  postInTransaction,
  SYSTEM_WALLETS,
  toUnits,
  type Tx,
  type WalletState,
} from './ledger.js';

// ───────────── Allowance ─────────────

export interface ActiveSubscription {
  id: string;
  period_start: Date;
  used: string;
  included: string;
}

/** The organization's plan subscription covering `at`, optionally row-locked for update. */
export async function activeSubscription(
  tx: Tx | PrismaClient,
  organizationId: string,
  at: Date,
  lock = false,
): Promise<ActiveSubscription | undefined> {
  const [sub] = await tx.$queryRaw<ActiveSubscription[]>`
    SELECT s."id", s."period_start", s."used_usd"::text AS "used", p."included_usd"::text AS "included"
      FROM "subscriptions" s JOIN "plans" p ON p."id" = s."plan_id"
     WHERE s."organization_id" = ${organizationId} AND s."status" = 'active'
       AND s."period_start" <= ${at} AND s."period_end" > ${at}
     ${lock ? Prisma.sql`FOR UPDATE OF s` : Prisma.empty}`;
  return sub;
}

export const leftOf = (sub: ActiveSubscription | undefined) => {
  const left = sub ? toUnits(sub.included) - toUnits(sub.used) : 0n;
  return left > 0n ? left : 0n;
};

/** Plan allowance left for an organization right now, in units (0 without an active plan). */
export async function allowanceLeft(
  tx: Tx | PrismaClient,
  organizationId: string,
  at: Date,
): Promise<bigint> {
  return leftOf(await activeSubscription(tx, organizationId, at));
}

/** Same day next month, clamped to the month's last day (Jan 31 → Feb 28/29). */
export function addMonth(date: Date): Date {
  const next = new Date(date);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next;
}

export interface PeriodResult {
  status: 'active' | 'past_due' | 'cancelled';
  periodStart: Date;
  periodEnd: Date;
  /** Customer wallet after the fee, for the Valkey mirror (absent when nothing was posted). */
  wallet?: WalletState;
}

interface LockedSubscription {
  id: string;
  organization_id: string;
  status: 'active' | 'past_due' | 'cancelled';
  cancel_at_period_end: boolean;
  price: string;
  plan_name: string;
  wallet_id: string | null;
  balance: string | null;
}

/**
 * Starts the period beginning at `periodStart`: charges the fee and resets the allowance, or marks
 * the subscription past due (or cancelled, when cancellation was requested). Safe to repeat.
 */
export async function startSubscriptionPeriod(
  db: PrismaClient,
  subscriptionId: string,
  periodStart: Date,
): Promise<PeriodResult> {
  const periodEnd = addMonth(periodStart);
  return db.$transaction(async (tx: Tx): Promise<PeriodResult> => {
    const [sub] = await tx.$queryRaw<LockedSubscription[]>`
      SELECT s."id", s."organization_id", s."status"::text AS "status", s."cancel_at_period_end",
             p."price_usd"::text AS "price", p."name" AS "plan_name",
             w."id" AS "wallet_id", w."balance_usd"::text AS "balance"
        FROM "subscriptions" s
        JOIN "plans" p ON p."id" = s."plan_id"
        LEFT JOIN "wallets" w ON w."organization_id" = s."organization_id"
       WHERE s."id" = ${subscriptionId}
       FOR UPDATE OF s`;
    if (!sub) throw new Error(`subscription ${subscriptionId} does not exist`);
    if (sub.status === 'cancelled' || sub.cancel_at_period_end) {
      await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELLED', cancelAtPeriodEnd: false },
      });
      return { status: 'cancelled', periodStart, periodEnd };
    }
    const price = toUnits(sub.price);
    if (price > 0n && (!sub.wallet_id || toUnits(sub.balance ?? '0') < price)) {
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE' } });
      return { status: 'past_due', periodStart, periodEnd };
    }
    let wallet: WalletState | undefined;
    if (price > 0n && sub.wallet_id) {
      const posted = await postInTransaction(tx, {
        kind: 'plan',
        idempotencyKey: `plan:${sub.id}:${periodStart.toISOString()}`,
        description: `Plan ${sub.plan_name}, ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`,
        metadata: { subscriptionId: sub.id, periodStart: periodStart.toISOString() },
        legs: [
          { walletId: sub.wallet_id, amountUsd: fromUnits(-price) },
          { walletId: SYSTEM_WALLETS.revenue, amountUsd: fromUnits(price) },
        ],
      });
      wallet = posted.wallets.find((w) => w.walletId === sub.wallet_id);
    }
    await tx.subscription.update({
      where: { id: sub.id },
      data: { status: 'ACTIVE', periodStart, periodEnd, usedUsd: 0 },
    });
    return { status: 'active', periodStart, periodEnd, ...(wallet ? { wallet } : {}) };
  });
}

/**
 * Renews every subscription whose period has ended, and retries past-due ones. A subscription
 * that lagged several periods (worker down) restarts from now instead of billing the gap.
 */
export async function renewSubscriptions(db: PrismaClient, now = new Date()) {
  const due = await db.subscription.findMany({
    where: {
      OR: [{ status: 'ACTIVE', periodEnd: { lte: now } }, { status: 'PAST_DUE' }],
    },
    select: { id: true, status: true, periodEnd: true },
    take: 500,
  });
  const results: (PeriodResult & { subscriptionId: string })[] = [];
  for (const sub of due) {
    const start = sub.status === 'ACTIVE' && addMonth(sub.periodEnd) > now ? sub.periodEnd : now;
    results.push({ subscriptionId: sub.id, ...(await startSubscriptionPeriod(db, sub.id, start)) });
  }
  return results;
}
