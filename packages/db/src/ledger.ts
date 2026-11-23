/**
 * Double-entry wallet ledger (card 19.1).
 *
 * Every money movement is one `wallet_transactions` row with two or more `wallet_entries` legs that
 * sum to zero. The database enforces the invariant too (deferred constraint trigger), so a bug here
 * fails the commit instead of creating or destroying money. Customer wallets cannot go below zero
 * (CHECK constraint); system wallets are the counter-accounts and may.
 *
 * Postings are idempotent: the transaction's `idempotency_key` is unique, and posting the same key
 * twice returns the first result without touching any balance.
 *
 * System wallet balances are not cached: every usage charge credits `revenue`, so locking that row
 * would serialize all postings of all customers. Their balance is the sum of their entries.
 */
import { randomBytes } from 'node:crypto';

import type { PrismaClient, Wallet } from '../generated/client/index.js';

export const SYSTEM_WALLETS = {
  /** Usage sold to customers. */
  revenue: 'wal_system_revenue',
  /** Money received from payment providers (card 19.2). */
  funding: 'wal_system_funding',
  /** Credit given away by gift codes (card 19.3). */
  promo: 'wal_system_promo',
  /** Usage that was served but could not be collected from the wallet. */
  writeoff: 'wal_system_writeoff',
} as const;
export type SystemWallet = keyof typeof SYSTEM_WALLETS;

export type TransactionKind = 'usage' | 'topup' | 'gift' | 'adjustment' | 'refund' | 'plan';

export type LedgerErrorCode =
  'invalid_amount' | 'unbalanced' | 'wallet_not_found' | 'insufficient_funds';

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

// ───────────── Fixed-point money (8 decimals, same as Decimal(18,8)) ─────────────

const SCALE = 8;
const FACTOR = 10n ** BigInt(SCALE);
const AMOUNT = /^(-)?(\d{1,10})(?:\.(\d{1,8}))?$/;

/** Decimal string to integer units (1 USD = 10^8). Throws on anything else. */
export function toUnits(amount: string): bigint {
  const match = AMOUNT.exec(amount.trim());
  if (!match) throw new LedgerError('invalid_amount', `invalid amount: ${amount}`);
  const [, sign, whole = '0', fraction = ''] = match;
  const units = BigInt(whole) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
  return sign ? -units : units;
}

export function fromUnits(units: bigint): string {
  const abs = units < 0n ? -units : units;
  const text = `${(abs / FACTOR).toString()}.${(abs % FACTOR).toString().padStart(SCALE, '0')}`;
  return units < 0n ? `-${text}` : text;
}

export interface LedgerLeg {
  walletId: string;
  /** Signed decimal: positive credits the wallet, negative debits it. */
  amountUsd: string;
}

/**
 * Validates legs: at least two, none zero, summing to zero. Pure, so the invariant is unit-tested
 * without a database; the trigger is the second line of defence.
 */
export function assertBalanced(legs: readonly LedgerLeg[]): bigint[] {
  if (legs.length < 2) throw new LedgerError('unbalanced', 'a transaction needs at least two legs');
  const units = legs.map((leg) => toUnits(leg.amountUsd));
  if (units.some((u) => u === 0n)) throw new LedgerError('invalid_amount', 'a leg cannot be zero');
  const total = units.reduce((sum, u) => sum + u, 0n);
  if (total !== 0n)
    throw new LedgerError('unbalanced', `legs sum to ${fromUnits(total)}, expected 0`);
  return units;
}

// ───────────── Posting ─────────────

export interface PostInput {
  kind: TransactionKind;
  idempotencyKey: string;
  legs: LedgerLeg[];
  description?: string;
  metadata?: Record<string, unknown>;
  createdById?: string;
}

export interface WalletState {
  walletId: string;
  balanceUsd: string;
  version: number;
}

export interface PostResult {
  transactionId: string;
  /** false when the idempotency key was already posted (nothing changed). */
  created: boolean;
  /** Customer wallets touched by this posting, after it (empty when `created` is false). */
  wallets: WalletState[];
}

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

interface LockedWallet {
  id: string;
  kind: 'customer' | 'system';
  balance: string;
  version: number;
}

const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${randomBytes(10).toString('hex')}`;

async function lockWallets(tx: Tx, ids: string[]): Promise<Map<string, LockedWallet>> {
  // A fixed lock order (by id) prevents deadlocks between concurrent postings.
  const sorted = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<LockedWallet[]>`
    SELECT "id", "kind"::text AS "kind", "balance_usd"::text AS "balance", "version"
      FROM "wallets" WHERE "id" = ANY(${sorted}) ORDER BY "id" FOR UPDATE`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of sorted)
    if (!byId.has(id)) throw new LedgerError('wallet_not_found', `wallet ${id} does not exist`);
  return byId;
}

/** Posts inside an open transaction; the caller owns commit and rollback. */
export async function postInTransaction(tx: Tx, input: PostInput): Promise<PostResult> {
  const units = assertBalanced(input.legs);
  const transactionId = newId('wtx');
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "wallet_transactions"
      ("id", "kind", "idempotency_key", "description", "metadata", "created_by_id")
    VALUES (${transactionId}, ${input.kind}, ${input.idempotencyKey}, ${input.description ?? null},
            ${JSON.stringify(input.metadata ?? {})}::jsonb, ${input.createdById ?? null})
    ON CONFLICT ("idempotency_key") DO NOTHING
    RETURNING "id"`;
  if (inserted.length === 0) {
    const existing = await tx.walletTransaction.findUniqueOrThrow({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    return { transactionId: existing.id, created: false, wallets: [] };
  }

  const locked = await lockWallets(
    tx,
    input.legs.map((l) => l.walletId),
  );
  const running = new Map<string, bigint>();
  const sequence = new Map<string, number>();
  for (const [id, w] of locked)
    if (w.kind === 'customer') {
      running.set(id, toUnits(w.balance));
      sequence.set(id, w.version + 1);
    }

  for (const [i, leg] of input.legs.entries()) {
    const amount = units[i] ?? 0n;
    const before = running.get(leg.walletId);
    let balanceAfter: string | null = null;
    if (before !== undefined) {
      const after = before + amount;
      if (after < 0n)
        throw new LedgerError(
          'insufficient_funds',
          `wallet ${leg.walletId} has ${fromUnits(before)}, needs ${fromUnits(-amount)}`,
        );
      running.set(leg.walletId, after);
      balanceAfter = fromUnits(after);
    }
    await tx.$executeRaw`
      INSERT INTO "wallet_entries"
        ("id", "transaction_id", "wallet_id", "amount_usd", "balance_after", "sequence")
      VALUES (${newId('wen')}, ${transactionId}, ${leg.walletId}, ${leg.amountUsd}::numeric,
              ${balanceAfter}::numeric, ${sequence.get(leg.walletId) ?? null}::int)`;
  }

  const wallets: WalletState[] = [];
  for (const [walletId, balance] of running) {
    const [row] = await tx.$queryRaw<{ version: number }[]>`
      UPDATE "wallets" SET "balance_usd" = ${fromUnits(balance)}::numeric,
             "version" = "version" + 1, "updated_at" = CURRENT_TIMESTAMP
       WHERE "id" = ${walletId} RETURNING "version"`;
    wallets.push({ walletId, balanceUsd: fromUnits(balance), version: row?.version ?? 0 });
  }
  return { transactionId, created: true, wallets };
}

export async function postTransaction(db: PrismaClient, input: PostInput): Promise<PostResult> {
  return db.$transaction((tx) => postInTransaction(tx, input));
}

export interface UsageCharge {
  requestId: string;
  walletId: string;
  amountUsd: string;
  metadata?: Record<string, unknown>;
}

export interface UsageChargeResult extends PostResult {
  /** Taken from the wallet. */
  collectedUsd: string;
  /** Served but not collectable (the wallet ran dry); booked to the write-off account. */
  writtenOffUsd: string;
}

/**
 * Debits one request's charge. The gateway reserves credit before the request, so the wallet
 * normally covers it; if it does not (Valkey was down with fail-open, or the request cost more than
 * its reservation), the wallet goes to exactly zero and the rest is written off. The ledger stays
 * balanced either way and the customer balance never goes negative.
 */
export async function chargeUsage(
  db: PrismaClient,
  charge: UsageCharge,
): Promise<UsageChargeResult> {
  return db.$transaction((tx) => chargeUsageInTransaction(tx, charge));
}

/** `chargeUsage` inside an open transaction (the worker combines it with plan allowance). */
export async function chargeUsageInTransaction(
  tx: Tx,
  charge: UsageCharge,
): Promise<UsageChargeResult> {
  const amount = toUnits(charge.amountUsd);
  if (amount <= 0n) throw new LedgerError('invalid_amount', 'usage charge must be positive');
  const locked = await lockWallets(tx, [charge.walletId]);
  const wallet = locked.get(charge.walletId);
  if (wallet?.kind !== 'customer')
    throw new LedgerError('wallet_not_found', `${charge.walletId} is not a customer wallet`);
  const balance = toUnits(wallet.balance);
  const collected = balance < amount ? (balance > 0n ? balance : 0n) : amount;
  const writtenOff = amount - collected;
  const legs: LedgerLeg[] = [{ walletId: SYSTEM_WALLETS.revenue, amountUsd: fromUnits(amount) }];
  if (collected > 0n) legs.push({ walletId: charge.walletId, amountUsd: fromUnits(-collected) });
  if (writtenOff > 0n)
    legs.push({ walletId: SYSTEM_WALLETS.writeoff, amountUsd: fromUnits(-writtenOff) });
  const result = await postInTransaction(tx, {
    kind: 'usage',
    idempotencyKey: `usage:${charge.requestId}`,
    legs,
    metadata: { requestId: charge.requestId, ...charge.metadata },
  });
  return { ...result, collectedUsd: fromUnits(collected), writtenOffUsd: fromUnits(writtenOff) };
}

/** Creates any missing system wallet (the migration seeds them; this heals a truncated table). */
export async function ensureSystemWallets(db: PrismaClient): Promise<void> {
  for (const [code, id] of Object.entries(SYSTEM_WALLETS))
    await db.$executeRaw`
      INSERT INTO "wallets" ("id", "kind", "code", "updated_at")
      VALUES (${id}, 'system', ${code}, CURRENT_TIMESTAMP)
      ON CONFLICT DO NOTHING`;
}

/** The organization's customer wallet, created on first use. */
export async function ensureWallet(db: PrismaClient, organizationId: string): Promise<Wallet> {
  const existing = await db.wallet.findUnique({ where: { organizationId } });
  if (existing) return existing;
  await db.$executeRaw`
    INSERT INTO "wallets" ("id", "kind", "organization_id", "updated_at")
    VALUES (${newId('wal')}, 'customer', ${organizationId}, CURRENT_TIMESTAMP)
    ON CONFLICT ("organization_id") DO NOTHING`;
  return db.wallet.findUniqueOrThrow({ where: { organizationId } });
}

export interface LedgerCheck {
  /** Sum of every entry ever posted; must be exactly 0. */
  totalUsd: string;
  unbalancedTransactions: number;
  /** Customer wallets whose cached balance differs from the sum of their entries. */
  driftedWallets: number;
}

/** Full audit of the invariants (used by tests, the worker's reconcile and the admin API). */
export async function checkLedger(db: PrismaClient | Tx): Promise<LedgerCheck> {
  const [row] = await db.$queryRaw<{ total: string; unbalanced: bigint; drifted: bigint }[]>`
    SELECT
      (SELECT COALESCE(SUM("amount_usd"), 0)::text FROM "wallet_entries") AS "total",
      (SELECT COUNT(*) FROM (
         SELECT 1 FROM "wallet_entries" GROUP BY "transaction_id"
         HAVING SUM("amount_usd") <> 0 OR COUNT(*) < 2) t) AS "unbalanced",
      (SELECT COUNT(*) FROM "wallets" w
        WHERE w."kind" = 'customer' AND w."balance_usd" <> COALESCE(
          (SELECT SUM(e."amount_usd") FROM "wallet_entries" e WHERE e."wallet_id" = w."id"), 0)
      ) AS "drifted"`;
  return {
    totalUsd: fromUnits(toUnits(row?.total ?? '0')),
    unbalancedTransactions: Number(row?.unbalanced ?? 0),
    driftedWallets: Number(row?.drifted ?? 0),
  };
}
