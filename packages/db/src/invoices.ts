/**
 * Monthly invoices (card 19.6).
 *
 * Prepaid organizations: computed only from the wallet ledger. Opening balance = sum of the
 * wallet's entries before the month, closing = opening + the month's entries; the totals per
 * transaction kind and the usage breakdown per model are sums of those same entries, so an invoice
 * always agrees with the ledger (`verifyInvoice` checks it).
 * Postpaid organizations: the month's usage charges (`charge_usd`) by model, from the daily rollup.
 *
 * Invoices are immutable once issued: generating a month twice returns the existing invoice.
 * Numbers are `INV-<year>-<6 digits>`, sequential per year (a transaction-level advisory lock
 * serializes numbering).
 */
import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '../generated/client/index.js';
import { fromUnits, toUnits, type Tx } from './ledger.js';

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;
const NUMBERING_LOCK = 734_115;

export function periodRange(period: string): { start: Date; end: Date } {
  const match = PERIOD.exec(period);
  if (!match) throw new RangeError(`invalid period ${period}`);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
}

/** The month before `now` (the one a monthly run invoices). */
export function previousPeriod(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A type, not an interface: Prisma's JSON input accepts only types with implicit index signatures. */
export type InvoiceLine = {
  model: string;
  requests: number;
  amountUsd: string;
};

export interface InvoiceData {
  basis: 'prepaid' | 'postpaid';
  openingUsd: string;
  closingUsd: string;
  /** Signed sums per transaction kind (credits positive, debits negative). */
  totals: Record<string, string>;
  lines: InvoiceLine[];
}

const sum = (rows: { amount: string }[]) => rows.reduce((s, r) => s + toUnits(r.amount), 0n);

/** Computes an organization's invoice figures for a month without storing anything. */
export async function computeInvoice(
  db: PrismaClient | Tx,
  organizationId: string,
  period: string,
): Promise<InvoiceData> {
  const { start, end } = periodRange(period);
  const wallet = await db.wallet.findUnique({ where: { organizationId }, select: { id: true } });
  if (wallet) {
    const [opening] = await db.$queryRaw<{ amount: string }[]>`
      SELECT COALESCE(SUM("amount_usd"), 0)::text AS "amount"
        FROM "wallet_entries" WHERE "wallet_id" = ${wallet.id} AND "created_at" < ${start}`;
    const byKind = await db.$queryRaw<{ kind: string; amount: string }[]>`
      SELECT t."kind", SUM(e."amount_usd")::text AS "amount"
        FROM "wallet_entries" e JOIN "wallet_transactions" t ON t."id" = e."transaction_id"
       WHERE e."wallet_id" = ${wallet.id} AND e."created_at" >= ${start} AND e."created_at" < ${end}
       GROUP BY t."kind" ORDER BY t."kind"`;
    const byModel = await db.$queryRaw<{ model: string; requests: bigint; amount: string }[]>`
      SELECT COALESCE(t."metadata"->>'model', 'unknown') AS "model", COUNT(*) AS "requests",
             (-SUM(e."amount_usd"))::text AS "amount"
        FROM "wallet_entries" e JOIN "wallet_transactions" t ON t."id" = e."transaction_id"
       WHERE e."wallet_id" = ${wallet.id} AND t."kind" = 'usage'
         AND e."created_at" >= ${start} AND e."created_at" < ${end}
       GROUP BY 1 ORDER BY 3 DESC, 1`;
    const openingUnits = toUnits(opening?.amount ?? '0');
    const movement = sum(byKind);
    return {
      basis: 'prepaid',
      openingUsd: fromUnits(openingUnits),
      closingUsd: fromUnits(openingUnits + movement),
      totals: Object.fromEntries(byKind.map((k) => [k.kind, fromUnits(toUnits(k.amount))])),
      lines: byModel.map((l) => ({
        model: l.model,
        requests: Number(l.requests),
        amountUsd: fromUnits(toUnits(l.amount)),
      })),
    };
  }
  const byModel = await db.$queryRaw<{ model: string; requests: bigint; amount: string }[]>`
    SELECT "model_slug" AS "model", SUM("requests")::bigint AS "requests",
           COALESCE(SUM("charge_usd"), 0)::text AS "amount"
      FROM "usage_daily"
     WHERE "organization_id" = ${organizationId} AND "bucket" >= ${start}::date AND "bucket" < ${end}::date
     GROUP BY 1 HAVING SUM("requests") > 0 ORDER BY 3 DESC, 1`;
  const usage = sum(byModel);
  return {
    basis: 'postpaid',
    openingUsd: '0.00000000',
    closingUsd: fromUnits(usage),
    totals: { usage: fromUnits(usage) },
    lines: byModel.map((l) => ({
      model: l.model,
      requests: Number(l.requests),
      amountUsd: fromUnits(toUnits(l.amount)),
    })),
  };
}

/** Issues the month's invoice once; a second call returns the stored one unchanged. */
export async function issueInvoice(db: PrismaClient, organizationId: string, period: string) {
  const existing = await db.invoice.findUnique({
    where: { organizationId_period: { organizationId, period } },
  });
  if (existing) return { invoice: existing, created: false };
  if (periodRange(period).end > new Date())
    throw new RangeError(`period ${period} has not ended yet`);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${NUMBERING_LOCK})`;
    const again = await tx.invoice.findUnique({
      where: { organizationId_period: { organizationId, period } },
    });
    if (again) return { invoice: again, created: false };
    const data = await computeInvoice(tx, organizationId, period);
    const year = period.slice(0, 4);
    const count = await tx.invoice.count({ where: { number: { startsWith: `INV-${year}-` } } });
    const invoice = await tx.invoice.create({
      data: {
        id: `inv_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`,
        number: `INV-${year}-${String(count + 1).padStart(6, '0')}`,
        organizationId,
        period,
        basis: data.basis,
        openingUsd: data.openingUsd,
        closingUsd: data.closingUsd,
        totals: data.totals,
        lines: data.lines,
      },
    });
    return { invoice, created: true };
  });
}

/** Organizations with anything to invoice in the month: wallet movements or usage. */
export async function organizationsToInvoice(db: PrismaClient, period: string): Promise<string[]> {
  const { start, end } = periodRange(period);
  // The platform's own traffic is not sold, so it is never invoiced.
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT a."id" FROM (
      SELECT w."organization_id" AS "id" FROM "wallet_entries" e JOIN "wallets" w ON w."id" = e."wallet_id"
       WHERE w."organization_id" IS NOT NULL AND e."created_at" >= ${start} AND e."created_at" < ${end}
      UNION
      SELECT "organization_id" FROM "usage_daily"
       WHERE "bucket" >= ${start}::date AND "bucket" < ${end}::date AND "requests" > 0
    ) a JOIN "organizations" o ON o."id" = a."id"
    WHERE NOT o."is_platform" AND o."deleted_at" IS NULL
    ORDER BY 1`;
  return rows.map((r) => r.id);
}

/**
 * Recomputes a stored prepaid invoice from the ledger and compares every figure, plus the closing
 * balance against the running balance of the wallet's last entry of the month.
 */
export async function verifyInvoice(db: PrismaClient, invoiceId: string) {
  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const fresh = await computeInvoice(db, invoice.organizationId, invoice.period);
  const problems: string[] = [];
  if (fresh.openingUsd !== invoice.openingUsd.toFixed(8)) problems.push('opening balance');
  if (fresh.closingUsd !== invoice.closingUsd.toFixed(8)) problems.push('closing balance');
  // JSONB does not keep key order, so totals are compared key by key.
  const stored = invoice.totals as Record<string, string>;
  const kinds = new Set([...Object.keys(stored), ...Object.keys(fresh.totals)]);
  if ([...kinds].some((kind) => stored[kind] !== fresh.totals[kind])) problems.push('totals');
  const line = (l: InvoiceLine) => `${l.model}|${String(l.requests)}|${l.amountUsd}`;
  if (fresh.lines.map(line).join('\n') !== (invoice.lines as InvoiceLine[]).map(line).join('\n'))
    problems.push('lines');
  const lineSum = fresh.lines.reduce((s, l) => s + toUnits(l.amountUsd), 0n);
  if (fresh.basis === 'prepaid' && -lineSum !== toUnits(fresh.totals.usage ?? '0'))
    problems.push('usage lines do not add up to the usage total');
  if (fresh.basis === 'prepaid') {
    const { end } = periodRange(invoice.period);
    const wallet = await db.wallet.findUnique({
      where: { organizationId: invoice.organizationId },
    });
    const last = wallet
      ? await db.walletEntry.findFirst({
          where: { walletId: wallet.id, createdAt: { lt: end } },
          orderBy: [{ sequence: { sort: 'desc', nulls: 'last' } }],
        })
      : null;
    if (last && last.balanceAfter?.toFixed(8) !== fresh.closingUsd)
      problems.push('closing balance differs from the wallet running balance');
  }
  return { ok: problems.length === 0, problems };
}
