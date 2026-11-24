/**
 * Invoices and the profit report (card 19.6).
 *
 * Invoice figures come from `@dirouter/db`'s invoices module (the wallet ledger for prepaid
 * organizations); this service lists them, renders the Persian PDF (card 26.1), keeps the legal
 * details printed on invoices and gives the operator the monthly run, the ledger check of an
 * invoice and the cost-against-revenue report by model.
 */
import {
  computeInvoice,
  fromUnits,
  invoiceParty,
  type InvoiceParty,
  issueInvoice,
  organizationsToInvoice,
  periodRange,
  Prisma,
  toUnits,
  verifyInvoice,
} from '@dirouter/db';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { renderInvoicePdf } from './pdf/invoice-pdf.js';

type InvoiceRow = Awaited<ReturnType<PrismaService['client']['invoice']['findUniqueOrThrow']>>;

export function invoiceView(i: InvoiceRow) {
  return {
    id: i.id,
    number: i.number,
    organizationId: i.organizationId,
    period: i.period,
    basis: i.basis,
    openingUsd: i.openingUsd.toFixed(8),
    closingUsd: i.closingUsd.toFixed(8),
    totals: i.totals as Record<string, string>,
    lines: i.lines as { model: string; requests: number; amountUsd: string }[],
    /** null on invoices issued before the tax fields (card 26.1). */
    vatPercent: i.vatPercent?.toFixed(2) ?? null,
    grossUsd: i.grossUsd.toFixed(8),
    netUsd: i.netUsd.toFixed(8),
    vatUsd: i.vatUsd.toFixed(8),
    exchangeRateIrr: i.exchangeRateIrr?.toFixed(8) ?? null,
    seller: (i.seller as InvoiceParty | null) ?? null,
    buyer: (i.buyer as InvoiceParty | null) ?? null,
    ledgerTransactionId: i.ledgerTransactionId,
    createdAt: i.createdAt.toISOString(),
  };
}

export interface BillingProfileInput {
  partyType: 'legal' | 'natural';
  legalName: string;
  nationalId?: string | null | undefined;
  economicCode?: string | null | undefined;
  registrationNumber?: string | null | undefined;
  address?: string | null | undefined;
  postalCode?: string | null | undefined;
  phone?: string | null | undefined;
}

type ProfileRow = Awaited<
  ReturnType<PrismaService['client']['billingProfile']['findUniqueOrThrow']>
>;

function profileView(p: ProfileRow) {
  return {
    organizationId: p.organizationId,
    partyType: p.partyType,
    legalName: p.legalName,
    nationalId: p.nationalId,
    economicCode: p.economicCode,
    registrationNumber: p.registrationNumber,
    address: p.address,
    postalCode: p.postalCode,
    phone: p.phone,
    updatedAt: p.updatedAt.toISOString(),
  };
}

@Injectable()
export class InvoicesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  get db() {
    return this.prisma.client;
  }

  async list(organizationId?: string, period?: string) {
    const rows = await this.db.invoice.findMany({
      where: { ...(organizationId ? { organizationId } : {}), ...(period ? { period } : {}) },
      orderBy: [{ period: 'desc' }, { number: 'desc' }],
      take: 500,
    });
    return rows.map(invoiceView);
  }

  async get(id: string, organizationId?: string) {
    const row = await this.db.invoice.findFirst({
      where: { id, ...(organizationId ? { organizationId } : {}) },
    });
    if (!row) throw new DiRouterError('not_found', { message: 'Invoice not found' });
    return row;
  }

  /** Month to date: the current month's figures, computed now and not stored. */
  async preview(organizationId: string, now = new Date()) {
    const period = now.toISOString().slice(0, 7);
    return { period, draft: true, ...(await computeInvoice(this.db, organizationId, period)) };
  }

  /** Issues every organization's invoice for a finished month; safe to run again. */
  async generate(period: string) {
    try {
      periodRange(period);
    } catch {
      throw new DiRouterError('validation_failed', { message: 'period must be YYYY-MM' });
    }
    if (periodRange(period).end > new Date())
      throw new DiRouterError('validation_failed', { message: `${period} has not ended yet` });
    const organizations = await organizationsToInvoice(this.db, period);
    let created = 0;
    for (const organizationId of organizations)
      if ((await issueInvoice(this.db, organizationId, period)).created) created++;
    return { period, organizations: organizations.length, created };
  }

  async verify(id: string) {
    await this.get(id);
    return verifyInvoice(this.db, id);
  }

  async pdf(id: string, organizationId?: string): Promise<{ filename: string; body: Buffer }> {
    const row = await this.get(id, organizationId);
    const invoice = invoiceView(row);
    // Invoices issued before card 26.1 have no snapshot of the parties: today's details are used.
    const buyer = invoice.buyer ?? (await invoiceParty(this.db, invoice.organizationId));
    const body = await renderInvoicePdf({
      ...invoice,
      createdAt: row.createdAt,
      buyer,
      seller: invoice.seller ?? (await this.#platformParty()),
    });
    return { filename: `${invoice.number}.pdf`, body };
  }

  async #platformParty(): Promise<InvoiceParty | null> {
    const platform = await this.db.organization.findFirst({
      where: { isPlatform: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return platform ? invoiceParty(this.db, platform.id) : null;
  }

  // ───────────── Legal details printed on invoices (card 26.1) ─────────────

  async profile(organizationId: string) {
    const row = await this.db.billingProfile.findUnique({ where: { organizationId } });
    return row ? profileView(row) : null;
  }

  async putProfile(ctx: OrgContext, input: BillingProfileInput) {
    const data = {
      partyType: input.partyType,
      legalName: input.legalName,
      nationalId: input.nationalId ?? null,
      economicCode: input.economicCode ?? null,
      registrationNumber: input.registrationNumber ?? null,
      address: input.address ?? null,
      postalCode: input.postalCode ?? null,
      phone: input.phone ?? null,
    };
    const row = await this.db.billingProfile.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...data },
      update: data,
    });
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        action: 'billing.profile_changed',
        targetType: 'billing_profile',
        targetId: ctx.organizationId,
        diff: data,
      },
    });
    return profileView(row);
  }

  /**
   * Cost of buying from providers against revenue from customers, by model, for [from, to).
   * The platform's own traffic is not a sale and is left out. Ledger totals of the same range
   * (revenue booked, written off, given away, received) are returned alongside.
   *
   * `organizationId` and `model` narrow the cost and revenue figures to one customer and/or one
   * model (card 25.2). The ledger totals are system accounts of the whole platform and are never
   * narrowed; `filters` echoes what was applied so a reader knows which figures it affects.
   */
  async profit(
    from: string,
    to: string,
    filters: { organizationId?: string; model?: string } = {},
  ) {
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    if (!(start < end))
      throw new DiRouterError('validation_failed', { message: 'from must be before to' });
    const byOrganization = filters.organizationId
      ? Prisma.sql`AND d."organization_id" = ${filters.organizationId}`
      : Prisma.empty;
    const byModel = filters.model
      ? Prisma.sql`AND d."model_slug" = ${filters.model}`
      : Prisma.empty;
    const rows = await this.db.$queryRaw<
      { model: string; provider: string; requests: bigint; cost: string; revenue: string }[]
    >`
      SELECT d."model_slug" AS "model", d."provider_id" AS "provider", SUM(d."requests")::bigint AS "requests",
             COALESCE(SUM(d."cost_usd"), 0)::text AS "cost", COALESCE(SUM(d."charge_usd"), 0)::text AS "revenue"
        FROM "usage_daily" d JOIN "organizations" o ON o."id" = d."organization_id"
       WHERE d."bucket" >= ${start}::date AND d."bucket" < ${end}::date AND NOT o."is_platform"
             ${byOrganization} ${byModel}
       GROUP BY 1, 2 ORDER BY 5 DESC, 1`;
    const ledger = await this.db.$queryRaw<{ code: string; amount: string }[]>`
      SELECT w."code", COALESCE(SUM(e."amount_usd"), 0)::text AS "amount"
        FROM "wallet_entries" e JOIN "wallets" w ON w."id" = e."wallet_id"
       WHERE w."kind" = 'system' AND e."created_at" >= ${start} AND e."created_at" < ${end}
       GROUP BY 1`;
    const byCode = Object.fromEntries(ledger.map((l) => [l.code, toUnits(l.amount)]));
    let cost = 0n;
    let revenue = 0n;
    const models = rows.map((r) => {
      const c = toUnits(r.cost);
      const v = toUnits(r.revenue);
      cost += c;
      revenue += v;
      return {
        model: r.model,
        providerId: r.provider,
        requests: Number(r.requests),
        costUsd: fromUnits(c),
        revenueUsd: fromUnits(v),
        profitUsd: fromUnits(v - c),
        marginPercent: v > 0n ? Number(((v - c) * 10_000n) / v) / 100 : null,
      };
    });
    return {
      from,
      to,
      filters: {
        organizationId: filters.organizationId ?? null,
        model: filters.model ?? null,
      },
      models,
      totals: {
        costUsd: fromUnits(cost),
        revenueUsd: fromUnits(revenue),
        profitUsd: fromUnits(revenue - cost),
      },
      // System accounts move opposite to customers: revenue is credited, funding and promo debited.
      ledger: {
        revenueBookedUsd: fromUnits(byCode.revenue ?? 0n),
        // Card 26.1: VAT split off sales, and postpaid sales invoiced but not yet settled.
        vatCollectedUsd: fromUnits(byCode.vat ?? 0n),
        receivableUsd: fromUnits(-(byCode.receivable ?? 0n)),
        writtenOffUsd: fromUnits(-(byCode.writeoff ?? 0n)),
        promoGivenUsd: fromUnits(-(byCode.promo ?? 0n)),
        fundsReceivedUsd: fromUnits(-(byCode.funding ?? 0n)),
      },
    };
  }
}
