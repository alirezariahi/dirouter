/** Gift and recharge codes against real Postgres and Valkey (card 19.3). */
import { checkLedger } from '@dirouter/db';
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TokenService } from '../auth/crypto.js';
import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { normalizeCode } from './gift-codes.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const ORGS = Array.from({ length: 10 }, (_, i) => `org_gift_${String(i)}`);

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('gift codes over HTTP', () => {
  let app: NestFastifyApplication;
  let operator = '';
  let platform = '';
  let customer = '';

  const call = (method: 'GET' | 'POST', url: string, t: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/${url}`,
        headers: { authorization: `Bearer ${t}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });
  const batch = async (body: Record<string, unknown>) => {
    const res = await call('POST', `orgs/${platform}/billing/gift-batches`, operator, {
      name: 'test',
      kind: 'gift',
      amountUsd: '2',
      count: 1,
      ...body,
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; codes: string[] }>();
  };
  const redeem = (org: string, code: string) =>
    call('POST', `orgs/${org}/wallet/redeem`, customer, { code });
  const balance = async (org: string) =>
    (
      await app.get(PrismaService).client.wallet.findUnique({ where: { organizationId: org } })
    )?.balanceUsd.toFixed(8) ?? '0.00000000';

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
      'TRUNCATE refresh_tokens, memberships, audit_logs, users, gift_code_redemptions, gift_codes, gift_code_batches, payments, wallets, organizations CASCADE',
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const valkey = app.get(ValkeyService).client;
    const stale = await valkey.keys('dirouter:billing:redeem-failures:*');
    if (stale.length > 0) await valkey.del(...stale);
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
            email: 'gift-op@example.com',
            password: 'a-long-enough-password',
          },
        })
    ).json<{ accessToken: string }>().accessToken;
    platform =
      (await call('GET', 'auth/me', operator)).json<{ organizations: { id: string }[] }>()
        .organizations[0]?.id ?? '';
    const user = await db.user.create({
      data: { id: 'usr_gift', email: 'gift@example.com', name: 'G', passwordHash: 'x' },
    });
    for (const id of ORGS)
      await db.organization.create({
        data: {
          id,
          name: id,
          slug: id.replaceAll('_', '-'),
          memberships: { create: { id: `mem_${id}`, userId: user.id, role: 'OWNER' } },
        },
      });
    customer = await new TokenService('j'.repeat(32)).signAccess({
      sub: user.id,
      email: user.email,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows the codes once and stores only their hash', async () => {
    const created = await batch({ count: 5, name: 'launch' });
    expect(created.codes).toHaveLength(5);
    for (const code of created.codes)
      expect(code).toMatch(/^DR-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
    const stored = await app.get(PrismaService).client.giftCode.findMany({
      where: { batchId: created.id },
    });
    const dump = JSON.stringify(stored);
    for (const code of created.codes) expect(dump).not.toContain(code.slice(3));
    const again = await call(
      'GET',
      `orgs/${platform}/billing/gift-batches/${created.id}`,
      operator,
    );
    expect(again.json()).not.toHaveProperty('codes', expect.any(Array));
    expect(again.json()).toMatchObject({ codes: 5, redemptions: 0 });
  });

  it('a single-use code credits one organization once', async () => {
    const [code = ''] = (await batch({ amountUsd: '2.5' })).codes;
    const ok = await redeem(ORGS[0] ?? '', code.toLowerCase().replaceAll('-', ' '));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      amountUsd: '2.50000000',
      wallet: { balanceUsd: '2.50000000' },
    });
    expect((await redeem(ORGS[0] ?? '', code)).statusCode).toBe(409);
    expect((await redeem(ORGS[1] ?? '', code)).statusCode).toBe(422);
    expect(await balance(ORGS[0] ?? '')).toBe('2.50000000');
    expect(await balance(ORGS[1] ?? '')).toBe('0.00000000');
  });

  it('ten organizations at once cannot redeem a three-use code more than three times', async () => {
    const created = await batch({ kind: 'recharge', maxRedemptions: 3, amountUsd: '1' });
    const [code = ''] = created.codes;
    const results = await Promise.all(ORGS.map((org) => redeem(org, code)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(7);
    const report = await call(
      'GET',
      `orgs/${platform}/billing/gift-batches/${created.id}`,
      operator,
    );
    expect(report.json()).toMatchObject({ redemptions: 3, creditedUsd: '3.00000000' });
    const rows = await call(
      'GET',
      `orgs/${platform}/billing/gift-batches/${created.id}/redemptions`,
      operator,
    );
    expect(rows.json<unknown[]>()).toHaveLength(3);
    // Recharge codes are paid for, so the credit comes from the funding account.
    const funding = await app.get(PrismaService).client.walletEntry.aggregate({
      where: { walletId: 'wal_system_funding', transaction: { kind: 'gift' } },
      _sum: { amountUsd: true },
    });
    expect(funding._sum.amountUsd?.toFixed(8)).toBe('-3.00000000');
  });

  it('expired and revoked codes are refused', async () => {
    const [expired = ''] = (await batch({ expiresAt: new Date(Date.now() - 1_000).toISOString() }))
      .codes;
    expect((await redeem(ORGS[5] ?? '', expired)).statusCode).toBe(422);
    const revokable = await batch({});
    const revoked = await call(
      'POST',
      `orgs/${platform}/billing/gift-batches/${revokable.id}/revoke`,
      operator,
    );
    expect(revoked.json()).toMatchObject({ revokedAt: expect.any(String) as unknown });
    expect((await redeem(ORGS[5] ?? '', revokable.codes[0] ?? '')).statusCode).toBe(422);
    expect(await balance(ORGS[5] ?? '')).toBe('0.00000000');
  });

  it('guessing is rate limited per organization', async () => {
    await app.get(ValkeyService).client.del(`dirouter:billing:redeem-failures:${ORGS[9] ?? ''}`);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await redeem(ORGS[9] ?? '', `DR-0000-0000-${String(1000 + i)}`)).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('only the platform manages batches, and the ledger stays balanced', async () => {
    expect(
      (await call('GET', `orgs/${ORGS[0] ?? ''}/billing/gift-batches`, customer)).statusCode,
    ).toBe(404);
    expect(await checkLedger(app.get(PrismaService).client)).toMatchObject({
      totalUsd: '0.00000000',
      unbalancedTransactions: 0,
      driftedWallets: 0,
    });
  });
});

describe('code normalization', () => {
  it('accepts case, spaces and confusable letters', () => {
    expect(normalizeCode('dr-ab1c-0000-zzzz')).toBe('DR-AB1C-0000-ZZZZ');
    expect(normalizeCode(' ABIC 0O00 ZZZZ ')).toBe('DR-AB1C-0000-ZZZZ');
    expect(normalizeCode('DR-SHORT')).toBe('');
  });
});
