/**
 * Invoices and the profit report (card 19.6).
 *
 * Invoice figures come from `@dirouter/db`'s invoices module (the wallet ledger for prepaid
 * organizations); this service lists them, renders the PDF and gives the operator the monthly run,
 * the ledger check of an invoice and the cost-against-revenue report by model.
 */
import {
  computeInvoice,
  fromUnits,
  issueInvoice,
  organizationsToInvoice,
  periodRange,
  toUnits,
  verifyInvoice,
} from '@dirouter/db';
import { DiRouterError } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import { PdfDocument } from './pdf.js';

type InvoiceRow = Awaited<ReturnType<PrismaService['client']['invoice']['findUniqueOrThrow']>>;

/** Exact USD: as many decimals as the amount needs, at least two. */
export function money(amount: string): string {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = amount.replace(/^-/, '').split('.');
  const digits = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}$${whole}.${digits}`;
}

const KIND_LABELS: [string, string][] = [
  ['topup', 'Top-ups'],
  ['gift', 'Gift and recharge codes'],
  ['adjustment', 'Adjustments'],
  ['refund', 'Refunds'],
  ['plan', 'Plan fees'],
  ['usage', 'Usage'],
];

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
    createdAt: i.createdAt.toISOString(),
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
    const invoice = invoiceView(await this.get(id, organizationId));
    const org = await this.db.organization.findUnique({
      where: { id: invoice.organizationId },
      select: { name: true, slug: true },
    });
    // Helvetica covers Latin-1 only; a Persian name is shown by its slug.
    const customer =
      org && /^[\x20-\xff]+$/.test(org.name) ? org.name : (org?.slug ?? invoice.organizationId);
    const doc = new PdfDocument();
    const right = doc.right;
    let y = doc.y;
    doc.text({ x: doc.left, y, text: 'DiRouter', size: 18, bold: true });
    doc.text({
      x: right,
      y,
      text: `Invoice ${invoice.number}`,
      size: 12,
      bold: true,
      alignRight: true,
    });
    y = doc.down(22);
    doc.text({ x: doc.left, y, text: `Customer: ${customer}` });
    doc.text({ x: right, y, text: `Period: ${invoice.period}`, alignRight: true });
    y = doc.down(14);
    doc.text({ x: doc.left, y, text: `Organization ID: ${invoice.organizationId}`, size: 8 });
    doc.text({
      x: right,
      y,
      text: `Issued: ${invoice.createdAt.slice(0, 10)}`,
      size: 8,
      alignRight: true,
    });
    y = doc.down(26);

    const row = (label: string, amount: string, bold = false) => {
      doc.text({ x: doc.left, y, text: label, bold });
      doc.text({ x: right, y, text: money(amount), bold, alignRight: true });
      y = doc.down(16);
    };
    doc.text({ x: doc.left, y, text: 'Summary', size: 12, bold: true });
    y = doc.down(8);
    doc.rule(y);
    y = doc.down(16);
    if (invoice.basis === 'prepaid') row('Opening balance', invoice.openingUsd);
    for (const [kind, label] of KIND_LABELS)
      if (invoice.totals[kind] !== undefined) row(label, invoice.totals[kind] ?? '0');
    doc.rule(y + 10);
    row(invoice.basis === 'prepaid' ? 'Closing balance' : 'Amount due', invoice.closingUsd, true);

    if (invoice.lines.length > 0) {
      y = doc.down(18);
      doc.text({ x: doc.left, y, text: 'Usage by model', size: 12, bold: true });
      y = doc.down(18);
      doc.text({ x: doc.left, y, text: 'Model', size: 9, bold: true });
      doc.text({ x: right - 140, y, text: 'Requests', size: 9, bold: true, alignRight: true });
      doc.text({ x: right, y, text: 'Amount', size: 9, bold: true, alignRight: true });
      y = doc.down(6);
      doc.rule(y);
      y = doc.down(14);
      for (const line of invoice.lines) {
        doc.text({ x: doc.left, y, text: line.model, size: 9 });
        doc.text({ x: right - 140, y, text: String(line.requests), size: 9, alignRight: true });
        doc.text({ x: right, y, text: money(line.amountUsd), size: 9, alignRight: true });
        y = doc.down(13);
      }
      const total = invoice.lines.reduce((s, l) => s + toUnits(l.amountUsd), 0n);
      doc.rule(y + 9);
      doc.text({
        x: right,
        y,
        text: money(fromUnits(total)),
        size: 9,
        bold: true,
        alignRight: true,
      });
    }
    y = doc.down(30);
    doc.text({
      x: doc.left,
      y,
      text:
        invoice.basis === 'prepaid'
          ? 'Prepaid account: figures are taken from the wallet ledger. Amounts in USD.'
          : 'Usage charges for the period. Amounts in USD.',
      size: 8,
    });
    return { filename: `${invoice.number}.pdf`, body: doc.toBuffer() };
  }

  /**
   * Cost of buying from providers against revenue from customers, by model, for [from, to).
   * The platform's own traffic is not a sale and is left out. Ledger totals of the same range
   * (revenue booked, written off, given away, received) are returned alongside.
   */
  async profit(from: string, to: string) {
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    if (!(start < end))
      throw new DiRouterError('validation_failed', { message: 'from must be before to' });
    const rows = await this.db.$queryRaw<
      { model: string; provider: string; requests: bigint; cost: string; revenue: string }[]
    >`
      SELECT d."model_slug" AS "model", d."provider_id" AS "provider", SUM(d."requests")::bigint AS "requests",
             COALESCE(SUM(d."cost_usd"), 0)::text AS "cost", COALESCE(SUM(d."charge_usd"), 0)::text AS "revenue"
        FROM "usage_daily" d JOIN "organizations" o ON o."id" = d."organization_id"
       WHERE d."bucket" >= ${start}::date AND d."bucket" < ${end}::date AND NOT o."is_platform"
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
      models,
      totals: {
        costUsd: fromUnits(cost),
        revenueUsd: fromUnits(revenue),
        profitUsd: fromUnits(revenue - cost),
      },
      // System accounts move opposite to customers: revenue is credited, funding and promo debited.
      ledger: {
        revenueBookedUsd: fromUnits(byCode.revenue ?? 0n),
        writtenOffUsd: fromUnits(-(byCode.writeoff ?? 0n)),
        promoGivenUsd: fromUnits(-(byCode.promo ?? 0n)),
        fundsReceivedUsd: fromUnits(-(byCode.funding ?? 0n)),
      },
    };
  }
}
