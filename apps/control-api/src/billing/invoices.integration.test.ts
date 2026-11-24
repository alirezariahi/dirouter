/** Monthly invoices, their ledger check, the PDF and the profit report (card 19.6). */
import {
  chargeUsage,
  ensureWallet,
  postTransaction,
  previousPeriod,
  SYSTEM_WALLETS,
} from '@dirouter/db';
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TokenService } from '../auth/crypto.js';
import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PREPAID = 'org_inv_prepaid';
const POSTPAID = 'org_inv_postpaid';
const OTHER = 'org_inv_other';

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

  const call = (url: string, t: string, method = 'GET') =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url: `/api/v1/${url}`,
        headers: { authorization: `Bearer ${t}` },
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
    await app.close();
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
    });
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

  it('a postpaid invoice bills the usage charges by model', async () => {
    const all = (await call(`orgs/${platform}/billing/invoices?period=${period}`, operator)).json<
      { organizationId: string; basis: string; closingUsd: string; lines: { model: string }[] }[]
    >();
    expect(all.find((i) => i.organizationId === POSTPAID)).toMatchObject({
      basis: 'postpaid',
      closingUsd: '8.00000000',
      lines: [{ model: 'shop/smart' }, { model: 'shop/fast' }],
    });
  });

  it('the PDF is a well-formed document only its organization can download', async () => {
    const [invoice] = (await call(`orgs/${PREPAID}/invoices`, customer)).json<
      { id: string; number: string }[]
    >();
    const res = await call(`orgs/${PREPAID}/invoices/${invoice?.id ?? ''}/pdf`, customer);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const pdf = res.rawPayload.toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain(`Invoice ${invoice?.number ?? ''}`);
    expect(pdf).toContain('Acme Labs');
    expect(pdf).toContain('$17.625');
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
});
