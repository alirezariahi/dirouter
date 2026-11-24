/**
 * Monthly invoices, their ledger check, the PDF and the profit report (card 19.6); VAT booked in
 * the ledger, legal details, the Persian PDF and gap-free numbering (card 26.1).
 */
import {
  chargeUsage,
  ensureWallet,
  issueInvoice,
  postTransaction,
  previousPeriod,
  type Prisma,
  SYSTEM_WALLETS,
} from '@dirouter/db';
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TokenService } from '../auth/crypto.js';
import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { readPdf, rtlReading, visualText } from './pdf/pdf-reader.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PREPAID = 'org_inv_prepaid';
const POSTPAID = 'org_inv_postpaid';
const OTHER = 'org_inv_other';
const BUYER = 'شرکت نمونهٔ پارسیان';

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('invoices over HTTP', () => {
  let app: NestFastifyApplication;
  let operator = '';
  let platform = '';
  let customer = '';
  let stranger = '';
  const period = previousPeriod();
  const [year = '', month = ''] = period.split('-');
  /** A moment inside last month. */
  const lastMonth = new Date(Date.UTC(Number(year), Number(month) - 1, 10, 12));

  let savedSettings: Prisma.InputJsonValue | null = null;

  const call = (url: string, t: string, method = 'GET', payload?: object) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url: `/api/v1/${url}`,
        headers: { authorization: `Bearer ${t}` },
        ...(payload ? { payload } : {}),
      });

  beforeAll(async () => {
    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        VALKEY_URL,
        MASTER_KEY: generateKey(),
        KEY_PEPPER: 'q'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
      }),
    );
    const db = app.get(PrismaService).client;
    await db.$executeRawUnsafe(
      'TRUNCATE refresh_tokens, memberships, audit_logs, users, invoices, usage_daily, wallet_transactions, wallets, organizations CASCADE',
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    operator = (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            organizationName: 'Operator',
            name: 'O',
            email: 'inv-op@example.com',
            password: 'a-long-enough-password',
          },
        })
    ).json<{ accessToken: string }>().accessToken;
    platform =
      (await call('auth/me', operator)).json<{ organizations: { id: string }[] }>().organizations[0]
        ?.id ?? '';
    const tokens = new TokenService('j'.repeat(32));
    for (const [org, user] of [
      [PREPAID, 'usr_inv_a'],
      [POSTPAID, 'usr_inv_b'],
      [OTHER, 'usr_inv_c'],
    ] as const) {
      await db.user.create({
        data: { id: user, email: `${user}@example.com`, name: user, passwordHash: 'x' },
      });
      await db.organization.create({
        data: {
          id: org,
          name: org === PREPAID ? 'Acme Labs' : 'شرکت نمونه',
          slug: org.replaceAll('_', '-'),
          memberships: { create: { id: `mem_${org}`, userId: user, role: 'OWNER' } },
        },
      });
    }
    customer = await tokens.signAccess({ sub: 'usr_inv_a', email: 'a@example.com' });
    stranger = await tokens.signAccess({ sub: 'usr_inv_c', email: 'c@example.com' });

    // Card 26.1: 10% VAT and a rial rate in the operator's settings, and both parties' details.
    const settings = await db.billingSetting.findUnique({ where: { id: 'global' } });
    savedSettings = (settings?.settings as Prisma.InputJsonValue | undefined) ?? null;
    const terms = { exchangeRates: { IRR: '1050000' }, tax: { vatPercent: '10' } };
    await db.billingSetting.upsert({
      where: { id: 'global' },
      create: { id: 'global', settings: terms },
      update: { settings: terms },
    });
    expect(
      (
        await call(`orgs/${platform}/billing-profile`, operator, 'PUT', {
          partyType: 'legal',
          legalName: 'دی‌روتر',
          nationalId: '14000000001',
          economicCode: '411111111111',
          address: 'تهران، خیابان آزادی',
          postalCode: '1234567890',
        })
      ).statusCode,
    ).toBe(200);

    // Last month's activity of the prepaid customer, posted through the real ledger.
    const wallet = (await ensureWallet(db, PREPAID)).id;
    const post = (kind: 'topup' | 'gift' | 'adjustment' | 'plan', key: string, amount: string) =>
      postTransaction(db, {
        kind,
        idempotencyKey: `inv-test:${key}`,
        legs: [
          { walletId: wallet, amountUsd: amount },
          {
            walletId: kind === 'plan' ? SYSTEM_WALLETS.revenue : SYSTEM_WALLETS.funding,
            amountUsd: amount.startsWith('-') ? amount.slice(1) : `-${amount}`,
          },
        ],
      });
    await post('topup', 'topup', '20');
    await post('gift', 'gift', '5');
    await post('plan', 'plan', '-2');
    await post('adjustment', 'adjust', '-1');
    for (const [i, model, amount] of [
      [1, 'shop/fast', '0.75'],
      [2, 'shop/fast', '0.5'],
      [3, 'shop/smart', '3.125'],
    ] as const)
      await chargeUsage(db, {
        requestId: `inv_req_${String(i)}`,
        walletId: wallet,
        amountUsd: amount,
        metadata: { model },
      });
    // Move it into last month. The ledger is append-only, so its triggers are suspended for this
    // test-only rewrite of timestamps.
    await db.$transaction([
      db.$executeRawUnsafe(
        'ALTER TABLE wallet_entries DISABLE TRIGGER wallet_entries_no_update_delete',
      ),
      db.$executeRawUnsafe('ALTER TABLE wallet_entries DISABLE TRIGGER wallet_entries_balanced'),
      db.$executeRaw`UPDATE wallet_entries SET created_at = ${lastMonth}`,
      db.$executeRawUnsafe('ALTER TABLE wallet_entries ENABLE TRIGGER wallet_entries_balanced'),
      db.$executeRawUnsafe(
        'ALTER TABLE wallet_entries ENABLE TRIGGER wallet_entries_no_update_delete',
      ),
    ]);
    // Postpaid customer and the platform's own traffic, in the daily rollup.
    const day = lastMonth.toISOString().slice(0, 10);
    for (const [org, model, requests, cost, charge] of [
      [POSTPAID, 'shop/fast', 40, '2', '3'],
      [POSTPAID, 'shop/smart', 10, '4', '5'],
      [platform, 'shop/fast', 100, '9', '9'],
    ] as const)
      await db.$executeRaw`
        INSERT INTO usage_daily (bucket, organization_id, project_id, api_key_id, model_slug, provider_id, requests, cost_usd, charge_usd)
        VALUES (${day}::date, ${org}, 'prj', 'key', ${model}, 'prv', ${requests}, ${cost}::numeric, ${charge}::numeric)`;
  });

  afterAll(async () => {
    const db = app.get(PrismaService).client;
    await (savedSettings === null
      ? db.billingSetting.deleteMany({ where: { id: 'global' } })
      : db.billingSetting.update({ where: { id: 'global' }, data: { settings: savedSettings } }));
    await app.close();
  });

  it('keeps legal details per organization, with Persian digits accepted and checked', async () => {
    const res = await call(`orgs/${PREPAID}/billing-profile`, customer, 'PUT', {
      partyType: 'legal',
      legalName: BUYER,
      nationalId: '۱۰۱۰۱۰۱۰۱۰۱',
      economicCode: '422222222222',
      address: 'اصفهان، میدان نقش جهان',
      postalCode: '۸۱۰۰۰۰۰۰۰۰',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      legalName: BUYER,
      nationalId: '10101010101',
      postalCode: '8100000000',
    });
    expect((await call(`orgs/${PREPAID}/billing-profile`, customer)).json()).toMatchObject({
      economicCode: '422222222222',
    });
    for (const bad of [
      { legalName: 'x y', postalCode: '123' },
      { legalName: 'شخص', partyType: 'natural', nationalId: '10101010101' },
    ])
      expect((await call(`orgs/${OTHER}/billing-profile`, stranger, 'PUT', bad)).statusCode).toBe(
        422,
      );
    // Another organization's member cannot read or write it.
    expect((await call(`orgs/${PREPAID}/billing-profile`, stranger)).statusCode).toBe(404);
  });

  it('the monthly run issues each invoice once', async () => {
    const first = await call(
      `orgs/${platform}/billing/invoices/generate?period=${period}`,
      operator,
      'POST',
    );
    expect(first.json()).toEqual({ period, organizations: 2, created: 2 });
    const again = await call(
      `orgs/${platform}/billing/invoices/generate?period=${period}`,
      operator,
      'POST',
    );
    expect(again.json()).toMatchObject({ created: 0 });
    const open = new Date().toISOString().slice(0, 7);
    expect(
      (await call(`orgs/${platform}/billing/invoices/generate?period=${open}`, operator, 'POST'))
        .statusCode,
    ).toBe(422);
  });

  it('a prepaid invoice equals the ledger, line by line', async () => {
    const [invoice] = (await call(`orgs/${PREPAID}/invoices`, customer)).json<
      {
        id: string;
        number: string;
        basis: string;
        openingUsd: string;
        closingUsd: string;
        totals: Record<string, string>;
        lines: unknown[];
      }[]
    >();
    expect(invoice?.number).toMatch(new RegExp(`^INV-${year}-\\d{6}$`));
    expect(invoice).toMatchObject({
      basis: 'prepaid',
      openingUsd: '0.00000000',
      // 20 + 5 - 2 - 1 - (0.75 + 0.5 + 3.125)
      closingUsd: '17.62500000',
      totals: {
        topup: '20.00000000',
        gift: '5.00000000',
        plan: '-2.00000000',
        adjustment: '-1.00000000',
        usage: '-4.37500000',
      },
      lines: [
        { model: 'shop/smart', requests: 1, amountUsd: '3.12500000' },
        { model: 'shop/fast', requests: 2, amountUsd: '1.25000000' },
      ],
      // Card 26.1: usage 4.375 + plan 2 charged, VAT 10% included in it.
      vatPercent: '10.00',
      grossUsd: '6.37500000',
      netUsd: '5.79545455',
      vatUsd: '0.57954545',
      exchangeRateIrr: '1050000.00000000',
      seller: { legalName: 'دی‌روتر', economicCode: '411111111111' },
      buyer: { legalName: BUYER, nationalId: '10101010101' },
    });
    // The VAT is its own ledger line: moved from revenue to the VAT account, wallet untouched.
    const db = app.get(PrismaService).client;
    const entries = await db.walletEntry.findMany({
      where: {
        transactionId: (invoice as { ledgerTransactionId?: string }).ledgerTransactionId ?? '',
      },
      include: { transaction: true },
    });
    expect(entries.map((e) => [e.walletId, e.amountUsd.toFixed(8)]).sort()).toEqual([
      [SYSTEM_WALLETS.revenue, '-0.57954545'],
      [SYSTEM_WALLETS.vat, '0.57954545'],
    ]);
    expect(entries[0]?.transaction.kind).toBe('invoice');
    const wallet = await app
      .get(PrismaService)
      .client.wallet.findUniqueOrThrow({ where: { organizationId: PREPAID } });
    expect(wallet.balanceUsd.toFixed(8)).toBe('17.62500000');
    const check = await call(
      `orgs/${platform}/billing/invoices/${invoice?.id ?? ''}/verify`,
      operator,
    );
    expect(check.json()).toEqual({ ok: true, problems: [] });
  });

  it('a postpaid invoice bills the usage charges by model and books the sale with its VAT', async () => {
    const all = (await call(`orgs/${platform}/billing/invoices?period=${period}`, operator)).json<
      {
        id: string;
        organizationId: string;
        basis: string;
        closingUsd: string;
        lines: { model: string }[];
        ledgerTransactionId: string;
      }[]
    >();
    const invoice = all.find((i) => i.organizationId === POSTPAID);
    expect(invoice).toMatchObject({
      basis: 'postpaid',
      closingUsd: '8.00000000',
      lines: [{ model: 'shop/smart' }, { model: 'shop/fast' }],
      grossUsd: '8.00000000',
      netUsd: '7.27272727',
      vatUsd: '0.72727273',
      // No billing profile: the organization's name stands in.
      buyer: { legalName: 'شرکت نمونه', nationalId: null },
    });
    const entries = await app.get(PrismaService).client.walletEntry.findMany({
      where: { transactionId: invoice?.ledgerTransactionId ?? '' },
    });
    expect(entries.map((e) => [e.walletId, e.amountUsd.toFixed(8)]).sort()).toEqual([
      [SYSTEM_WALLETS.receivable, '-8.00000000'],
      [SYSTEM_WALLETS.revenue, '7.27272727'],
      [SYSTEM_WALLETS.vat, '0.72727273'],
    ]);
    expect(
      (
        await call(`orgs/${platform}/billing/invoices/${invoice?.id ?? ''}/verify`, operator)
      ).json(),
    ).toEqual({ ok: true, problems: [] });
  });

  it('the PDF is a Persian document only its organization can download', async () => {
    const [invoice] = (await call(`orgs/${PREPAID}/invoices`, customer)).json<
      { id: string; number: string }[]
    >();
    const res = await call(`orgs/${PREPAID}/invoices/${invoice?.id ?? ''}/pdf`, customer);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const pdf = res.rawPayload.toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    // What a viewer shows: the Persian buyer name read right to left, the number left to right,
    // the closing balance and the VAT total in Persian digits.
    const { lines } = readPdf(res.rawPayload);
    const has = (read: (l: (typeof lines)[number]) => string, text: string) =>
      lines.some((l) => read(l).includes(text.replace(/\s/g, '')));
    expect(has(rtlReading, BUYER)).toBe(true);
    expect(has(rtlReading, 'مالیات بر ارزش افزوده')).toBe(true);
    expect(has(visualText, invoice?.number ?? '-')).toBe(true);
    expect(has(visualText, '۱۷٫۶۲۵')).toBe(true);
    expect(has(visualText, '۶٬۶۹۳٬۷۵۰')).toBe(true);
    // The cross-reference offset really points at the xref table.
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
    expect(
      (await call(`orgs/${OTHER}/invoices/${invoice?.id ?? ''}/pdf`, stranger)).statusCode,
    ).toBe(404);
    expect(
      (await call(`orgs/${PREPAID}/invoices/${invoice?.id ?? ''}/pdf`, stranger)).statusCode,
    ).toBe(404);
  });

  it('the profit report sets provider cost against sales by model, without the platform', async () => {
    const from = `${period}-01`;
    const to = new Date(Date.UTC(Number(year), Number(month), 1)).toISOString().slice(0, 10);
    const report = (
      await call(`orgs/${platform}/billing/reports/profit?from=${from}&to=${to}`, operator)
    ).json<{
      models: {
        model: string;
        costUsd: string;
        revenueUsd: string;
        profitUsd: string;
        marginPercent: number;
      }[];
      totals: Record<string, string>;
      ledger: Record<string, string>;
    }>();
    expect(report.models).toEqual([
      expect.objectContaining({
        model: 'shop/smart',
        costUsd: '4.00000000',
        revenueUsd: '5.00000000',
        profitUsd: '1.00000000',
        marginPercent: 20,
      }),
      expect.objectContaining({
        model: 'shop/fast',
        costUsd: '2.00000000',
        revenueUsd: '3.00000000',
        marginPercent: 33.33,
      }),
    ]);
    expect(report.totals).toEqual({
      costUsd: '6.00000000',
      revenueUsd: '8.00000000',
      profitUsd: '2.00000000',
    });
    expect(report.ledger).toMatchObject({
      // usage 4.375 + plan 2
      revenueBookedUsd: '6.37500000',
      // top-up 20 + gift 5 (funded here) - adjustment 1
      fundsReceivedUsd: '24.00000000',
    });
  });

  it('the profit report narrows to one customer and one model (card 25.2)', async () => {
    const from = `${period}-01`;
    const to = new Date(Date.UTC(Number(year), Number(month), 1)).toISOString().slice(0, 10);
    const profit = async (extra: string) =>
      (
        await call(
          `orgs/${platform}/billing/reports/profit?from=${from}&to=${to}${extra}`,
          operator,
        )
      ).json<{
        filters: { organizationId: string | null; model: string | null };
        models: { model: string }[];
        totals: Record<string, string>;
        ledger: Record<string, string>;
      }>();
    const all = await profit('');
    expect(all.filters).toEqual({ organizationId: null, model: null });

    const fast = await profit('&model=shop%2Ffast');
    expect(fast.filters).toEqual({ organizationId: null, model: 'shop/fast' });
    expect(fast.models.map((m) => m.model)).toEqual(['shop/fast']);
    expect(fast.totals).toEqual({
      costUsd: '2.00000000',
      revenueUsd: '3.00000000',
      profitUsd: '1.00000000',
    });
    // The ledger figures are the platform's system accounts and are not narrowed.
    expect(fast.ledger).toEqual(all.ledger);

    const postpaid = await profit(`&organizationId=${POSTPAID}`);
    expect(postpaid.totals).toEqual(all.totals);
    const both = await profit(`&organizationId=${POSTPAID}&model=shop%2Fsmart`);
    expect(both.totals).toEqual({
      costUsd: '4.00000000',
      revenueUsd: '5.00000000',
      profitUsd: '1.00000000',
    });
    // A customer without usage, and the platform itself (never a sale), give empty reports.
    for (const org of [OTHER, platform]) {
      const none = await profit(`&organizationId=${org}`);
      expect(none.models).toEqual([]);
      expect(none.totals).toEqual({
        costUsd: '0.00000000',
        revenueUsd: '0.00000000',
        profitUsd: '0.00000000',
      });
    }
  });

  it('numbers invoices without gaps and never lets one change or disappear', async () => {
    const db = app.get(PrismaService).client;
    const numbers = async () =>
      (await db.invoice.findMany({ where: { number: { startsWith: `INV-${year}-` } } }))
        .map((i) => Number(i.number.slice(9)))
        .sort((a, b) => a - b);
    expect(await numbers()).toEqual([1, 2]);
    // Last, so the extra usage below stays out of the profit report above.
    // Five organizations invoiced at the same time still get the next five numbers.
    const orgs = ['a', 'b', 'c', 'd', 'e'].map((x) => `org_inv_gap_${x}`);
    const day = lastMonth.toISOString().slice(0, 10);
    for (const org of orgs) {
      await db.organization.create({
        data: { id: org, name: org, slug: org.replaceAll('_', '-') },
      });
      await db.$executeRaw`
        INSERT INTO usage_daily (bucket, organization_id, project_id, api_key_id, model_slug, provider_id, requests, cost_usd, charge_usd)
        VALUES (${day}::date, ${org}, 'prj', 'key', 'shop/fast', 'prv', 1, 0.5, 1.1)`;
    }
    const issued = await Promise.all(orgs.map((org) => issueInvoice(db, org, period)));
    expect(issued.every((r) => r.created)).toBe(true);
    expect(await numbers()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // The database refuses a skipped number, an edit and a deletion.
    const sample = issued[0]?.invoice;
    await expect(
      db.$executeRaw`
        INSERT INTO invoices (id, number, organization_id, period, basis, opening_usd, closing_usd, totals, lines)
        VALUES ('inv_gap', ${`INV-${year}-000009`}, ${OTHER}, '2000-01', 'postpaid', 0, 0, '{}', '[]')`,
    ).rejects.toThrow(/breaks the sequence/);
    await expect(
      db.$executeRaw`UPDATE invoices SET closing_usd = 0 WHERE id = ${sample?.id ?? ''}`,
    ).rejects.toThrow(/cannot be changed or deleted/);
    await expect(
      db.$executeRaw`DELETE FROM invoices WHERE id = ${sample?.id ?? ''}`,
    ).rejects.toThrow(/cannot be changed or deleted/);
    expect(await numbers()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
