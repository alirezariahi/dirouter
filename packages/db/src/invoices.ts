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
 * serializes numbering; a database trigger refuses any skipped number and any edit or deletion).
 *
 * Tax (card 26.1): charges include VAT. Issuing an invoice splits what the customer was charged
 * for services in the month (usage and plan fees, the gross) into net + VAT at the rate in the
 * billing settings, and books it in the same database transaction as the invoice:
 * - prepaid: `revenue` -> `vat` for the VAT (the customer's wallet is not touched);
 * - postpaid: `receivable` is debited the gross, `revenue` credited the net and `vat` the VAT.
 * The seller's and buyer's legal details and the rial exchange rate are recorded on the invoice.
 */
import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '../generated/client/index.js';
import {
  fromUnits,
  type LedgerLeg,
  postInTransaction,
  SYSTEM_WALLETS,
  toUnits,
  type Tx,
} from './ledger.js';
import { percentToBasisPoints, splitVat } from './tax.js';

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

/** Legal details of a party, as printed on the invoice. */
export type InvoiceParty = {
  partyType: 'legal' | 'natural';
  legalName: string;
  nationalId: string | null;
  economicCode: string | null;
  registrationNumber: string | null;
  address: string | null;
  postalCode: string | null;
  phone: string | null;
};

export interface InvoiceTerms {
  /** VAT percent, e.g. `"10"`; `"0"` when none is configured. */
  vatPercent: string;
  /** Rials per USD, or null when the operator has not set one. */
  exchangeRateIrr: string | null;
}

const DECIMAL = /^\d{1,10}(\.\d{1,8})?$/;

/**
 * The terms an invoice is issued under, from the operator's billing settings (`tax.vatPercent`,
 * `exchangeRates.IRR`). Read here so the worker's monthly run and the API issue alike.
 */
export async function invoiceTerms(db: PrismaClient | Tx): Promise<InvoiceTerms> {
  const row = await db.billingSetting.findUnique({ where: { id: 'global' } });
  const settings = (row?.settings ?? {}) as {
    tax?: { vatPercent?: unknown };
    exchangeRates?: Record<string, unknown>;
  };
  let vatPercent = '0';
  const percent = settings.tax?.vatPercent;
  if (typeof percent === 'string') {
    try {
      percentToBasisPoints(percent);
      vatPercent = percent.trim();
    } catch {
      // An invalid stored value never reaches an invoice; the settings API validates it anyway.
    }
  }
  const rate = settings.exchangeRates?.IRR;
  const exchangeRateIrr =
    typeof rate === 'string' && DECIMAL.test(rate.trim()) && toUnits(rate) > 0n
      ? rate.trim()
      : null;
  return { vatPercent, exchangeRateIrr };
}

/** An organization's legal details; falls back to its name when it has no billing profile. */
export async function invoiceParty(
  db: PrismaClient | Tx,
  organizationId: string,
): Promise<InvoiceParty> {
  const profile = await db.billingProfile.findUnique({ where: { organizationId } });
  if (profile)
    return {
      partyType: profile.partyType === 'natural' ? 'natural' : 'legal',
      legalName: profile.legalName,
      nationalId: profile.nationalId,
      economicCode: profile.economicCode,
      registrationNumber: profile.registrationNumber,
      address: profile.address,
      postalCode: profile.postalCode,
      phone: profile.phone,
    };
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  return {
    partyType: 'legal',
    legalName: org?.name ?? organizationId,
    nationalId: null,
    economicCode: null,
    registrationNumber: null,
    address: null,
    postalCode: null,
    phone: null,
  };
}

/**
 * The taxable amount of an invoice: what the customer was charged for services in the month.
 * Prepaid: usage and plan fees taken from the wallet (both are debits, so negated). Postpaid: the
 * usage charges, which are the amount due.
 */
export function taxableUsd(data: Pick<InvoiceData, 'basis' | 'totals' | 'closingUsd'>): string {
  if (data.basis === 'postpaid') return fromUnits(toUnits(data.closingUsd));
  return fromUnits(-(toUnits(data.totals.usage ?? '0') + toUnits(data.totals.plan ?? '0')));
}

/** The VAT split of a taxable amount; nothing is split off a zero or negative amount. */
export function taxSplit(grossUsd: string, vatPercent: string) {
  return toUnits(grossUsd) > 0n
    ? splitVat(grossUsd, vatPercent)
    : { grossUsd, netUsd: grossUsd, vatUsd: fromUnits(0n) };
}

/** The ledger legs that book an invoice's tax (none when there is nothing to book). */
export function invoiceLegs(
  basis: 'prepaid' | 'postpaid',
  split: { grossUsd: string; netUsd: string; vatUsd: string },
): LedgerLeg[] {
  const gross = toUnits(split.grossUsd);
  const vat = toUnits(split.vatUsd);
  const net = toUnits(split.netUsd);
  if (gross <= 0n) return [];
  if (basis === 'prepaid')
    return vat > 0n
      ? [
          { walletId: SYSTEM_WALLETS.revenue, amountUsd: fromUnits(-vat) },
          { walletId: SYSTEM_WALLETS.vat, amountUsd: fromUnits(vat) },
        ]
      : [];
  const legs: LedgerLeg[] = [{ walletId: SYSTEM_WALLETS.receivable, amountUsd: fromUnits(-gross) }];
  if (net > 0n) legs.push({ walletId: SYSTEM_WALLETS.revenue, amountUsd: fromUnits(net) });
  if (vat > 0n) legs.push({ walletId: SYSTEM_WALLETS.vat, amountUsd: fromUnits(vat) });
  return legs;
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
    const terms = await invoiceTerms(tx);
    const split = taxSplit(taxableUsd(data), terms.vatPercent);
    const platform = await tx.organization.findFirst({
      where: { isPlatform: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const seller = platform ? await invoiceParty(tx, platform.id) : null;
    const buyer = await invoiceParty(tx, organizationId);
    const year = period.slice(0, 4);
    const count = await tx.invoice.count({ where: { number: { startsWith: `INV-${year}-` } } });
    const id = `inv_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
    const number = `INV-${year}-${String(count + 1).padStart(6, '0')}`;
    // Booked before the invoice row (which can never be updated) so the row can name it. Both
    // commit or roll back together, so a failure leaves neither a posting nor a used number.
    const legs = invoiceLegs(data.basis, split);
    const posting =
      legs.length > 0
        ? await postInTransaction(tx, {
            kind: 'invoice',
            idempotencyKey: `invoice:${id}`,
            legs,
            description: `Invoice ${number}`,
            metadata: {
              invoiceId: id,
              number,
              organizationId,
              period,
              basis: data.basis,
              vatPercent: terms.vatPercent,
              ...split,
            },
          })
        : null;
    const invoice = await tx.invoice.create({
      data: {
        id,
        number,
        organizationId,
        period,
        basis: data.basis,
        openingUsd: data.openingUsd,
        closingUsd: data.closingUsd,
        totals: data.totals,
        lines: data.lines,
        vatPercent: terms.vatPercent,
        grossUsd: split.grossUsd,
        netUsd: split.netUsd,
        vatUsd: split.vatUsd,
        exchangeRateIrr: terms.exchangeRateIrr,
        ...(seller ? { seller } : {}),
        buyer,
        ledgerTransactionId: posting?.transactionId ?? null,
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
  // Tax (card 26.1); invoices issued before it have no VAT rate and nothing booked.
  if (invoice.vatPercent !== null) {
    const gross = taxableUsd(fresh);
    if (gross !== invoice.grossUsd.toFixed(8)) problems.push('taxable amount');
    const expected = taxSplit(gross, invoice.vatPercent.toFixed(2));
    if (
      expected.netUsd !== invoice.netUsd.toFixed(8) ||
      expected.vatUsd !== invoice.vatUsd.toFixed(8)
    )
      problems.push('VAT split');
    const legs = invoiceLegs(fresh.basis, expected);
    const booked = invoice.ledgerTransactionId
      ? await db.walletEntry.findMany({
          where: { transactionId: invoice.ledgerTransactionId },
          select: { walletId: true, amountUsd: true },
        })
      : [];
    const bookedBy = new Map(booked.map((b) => [b.walletId, b.amountUsd.toFixed(8)]));
    if (
      legs.length !== booked.length ||
      legs.some((leg) => bookedBy.get(leg.walletId) !== fromUnits(toUnits(leg.amountUsd)))
    )
      problems.push('ledger posting of the VAT');
  }
  return { ok: problems.length === 0, problems };
}
