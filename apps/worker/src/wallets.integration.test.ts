/**
 * Double-entry ledger and prepaid debits on real services (card 19.1).
 * Runs with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL set.
 */
import {
  USAGE_EVENT_SCHEMA_VERSION,
  type UsageEvent,
  usdToUnits,
  WALLET_RESERVE_LUA,
  walletHoldsKey,
  walletKey,
} from '@dirouter/contracts';
import {
  chargeUsage,
  checkLedger,
  createPrismaClient,
  ensureWallet,
  fromUnits,
  postTransaction,
  SYSTEM_WALLETS,
  toUnits,
} from '@dirouter/db';
import { createLogger } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { chargeWallet, syncWallets } from './wallets.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const logger = createLogger({ service: 'test', level: 'silent' });
const RUN = Date.now().toString(36);

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('wallet ledger on real services', () => {
  const db = createPrismaClient({ databaseUrl: DATABASE_URL ?? '', maxConnections: 12 });
  const redis = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: null });
  let walletId = '';

  const fund = (amountUsd: string, key: string) =>
    postTransaction(db, {
      kind: 'topup',
      idempotencyKey: `test:${RUN}:${key}`,
      legs: [
        { walletId, amountUsd },
        { walletId: SYSTEM_WALLETS.funding, amountUsd: `-${amountUsd}` },
      ],
    });
  const balance = async () =>
    (await db.wallet.findUniqueOrThrow({ where: { id: walletId } })).balanceUsd.toFixed(8);

  beforeAll(async () => {
    const org = await db.organization.create({
      data: { id: `org_wallet_${RUN}`, name: 'Wallet IT', slug: `wallet-it-${RUN}` },
    });
    walletId = (await ensureWallet(db, org.id)).id;
  });
  afterAll(async () => {
    redis.disconnect();
    await db.$disconnect();
  });

  it('ensureWallet is idempotent', async () => {
    expect((await ensureWallet(db, `org_wallet_${RUN}`)).id).toBe(walletId);
  });

  it('a top-up is posted once, however often it is retried', async () => {
    const results = await Promise.all([1, 2, 3].map(() => fund('10', 'topup-1')));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await balance()).toBe('10.00000000');
  });

  it('concurrent usage never takes the balance below zero; the shortfall is written off', async () => {
    const before = await db.walletEntry.aggregate({
      where: { walletId: SYSTEM_WALLETS.writeoff },
      _sum: { amountUsd: true },
    });
    // 40 requests × $0.50 = $20 against a $10 wallet, all at once.
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        chargeUsage(db, { requestId: `req_${RUN}_${String(i)}`, walletId, amountUsd: '0.5' }),
      ),
    );
    expect(await balance()).toBe('0.00000000');
    const collected = results.reduce((s, r) => s + toUnits(r.collectedUsd), 0n);
    const writtenOff = results.reduce((s, r) => s + toUnits(r.writtenOffUsd), 0n);
    expect(fromUnits(collected)).toBe('10.00000000');
    expect(fromUnits(writtenOff)).toBe('10.00000000');
    const after = await db.walletEntry.aggregate({
      where: { walletId: SYSTEM_WALLETS.writeoff },
      _sum: { amountUsd: true },
    });
    expect(
      toUnits(before._sum.amountUsd?.toFixed(8) ?? '0') -
        toUnits(after._sum.amountUsd?.toFixed(8) ?? '0'),
    ).toBe(writtenOff);
    // Every running balance on the statement stays at or above zero.
    const entries = await db.walletEntry.findMany({ where: { walletId } });
    expect(entries.every((e) => (e.balanceAfter?.toNumber() ?? 0) >= 0)).toBe(true);
  });

  it('the same request is charged once', async () => {
    await fund('1', 'topup-2');
    const twice = await Promise.all(
      [1, 2].map(() =>
        chargeUsage(db, { requestId: `req_${RUN}_dup`, walletId, amountUsd: '0.25' }),
      ),
    );
    expect(twice.filter((r) => r.created)).toHaveLength(1);
    expect(await balance()).toBe('0.75000000');
  });

  it('a direct debit beyond the balance is refused and changes nothing', async () => {
    await expect(
      postTransaction(db, {
        kind: 'adjustment',
        idempotencyKey: `test:${RUN}:overdraw`,
        legs: [
          { walletId, amountUsd: '-5' },
          { walletId: SYSTEM_WALLETS.funding, amountUsd: '5' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await balance()).toBe('0.75000000');
    expect(
      await db.walletTransaction.count({ where: { idempotencyKey: `test:${RUN}:overdraw` } }),
    ).toBe(0);
  });

  it('the database itself refuses unbalanced or edited entries', async () => {
    await expect(
      db.$transaction(async (tx) => {
        // Checked at the statement instead of at COMMIT: the pg adapter does not release a
        // connection whose COMMIT fails, which would hang the pool at shutdown.
        await tx.$executeRaw`SET CONSTRAINTS "wallet_entries_balanced" IMMEDIATE`;
        await tx.$executeRaw`INSERT INTO "wallet_transactions" ("id", "kind", "idempotency_key")
          VALUES (${`wtx_bad_${RUN}`}, 'adjustment', ${`bad:${RUN}`})`;
        await tx.$executeRaw`INSERT INTO "wallet_entries" ("id", "transaction_id", "wallet_id", "amount_usd")
          VALUES (${`wen_bad_${RUN}`}, ${`wtx_bad_${RUN}`}, ${SYSTEM_WALLETS.promo}, 1)`;
      }),
    ).rejects.toThrow(/unbalanced/);
    await expect(
      db.$executeRaw`UPDATE "wallet_entries" SET "amount_usd" = 1 WHERE "wallet_id" = ${walletId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRaw`UPDATE "wallets" SET "balance_usd" = -1 WHERE "id" = ${walletId}`,
    ).rejects.toThrow(/wallets_customer_non_negative/);
  });

  it('the sum of all transactions is always zero', async () => {
    expect(await checkLedger(db)).toEqual({
      totalUsd: '0.00000000',
      unbalancedTransactions: 0,
      driftedWallets: 0,
    });
  });

  it('the worker debit releases the gateway reservation and mirrors the new balance', async () => {
    await syncWallets(db, redis);
    expect(await redis.hget(walletKey(walletId), 'balance')).toBe(String(usdToUnits('0.75')));
    // The gateway reserved $0.40 for the request and settled at $0.30.
    await redis.eval(
      WALLET_RESERVE_LUA,
      2,
      walletKey(walletId),
      walletHoldsKey(walletId),
      `req_${RUN}_w`,
      usdToUnits('0.3'),
      Date.now() + 60_000,
    );
    const event: UsageEvent = {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: '01JCW0000000000000000WALLET',
      idempotencyKey: `req_${RUN}_w`,
      requestId: `req_${RUN}_w`,
      occurredAt: new Date().toISOString(),
      gatewayInstance: 'test',
      configVersion: 1,
      organizationId: `org_wallet_${RUN}`,
      teamId: null,
      projectId: 'prj',
      virtualKeyId: 'vk',
      walletId,
      inboundApi: 'openai.chat',
      requestedModel: 'm',
      resolvedModelId: 'm',
      providerId: 'p',
      credentialId: 'c',
      stream: false,
      status: 'success',
      httpStatus: 200,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: '0.1',
      chargeUsd: '0.3',
      usageEstimated: false,
      latencyMs: 1,
      attempts: [],
    };
    expect(await chargeWallet(db, redis, event, logger)).toMatchObject({ charged: true });
    expect(await chargeWallet(db, redis, event, logger)).toEqual({ charged: false });
    expect(await balance()).toBe('0.45000000');
    expect(await redis.hgetall(walletKey(walletId))).toMatchObject({
      balance: String(usdToUnits('0.45')),
      held: '0',
    });
    expect(await redis.hlen(walletHoldsKey(walletId))).toBe(0);
  });

  it('sync never overwrites a newer balance and drops abandoned reservations', async () => {
    const key = walletKey(walletId);
    const version = Number(await redis.hget(key, 'version'));
    await redis.hset(key, 'version', version + 5, 'balance', 1);
    await redis.hset(walletHoldsKey(walletId), 'stale', `100:${String(Date.now() - 1)}`);
    await redis.hset(key, 'held', 100);
    await syncWallets(db, redis);
    expect(await redis.hgetall(key)).toMatchObject({ balance: '1', held: '0' });
    await redis.hset(key, 'version', 0);
    await syncWallets(db, redis);
    expect(await redis.hget(key, 'balance')).toBe(String(usdToUnits('0.45')));
  });
});
