/**
 * Prepaid wallet reservations (card 19.1). The Valkey part runs with INTEGRATION_VALKEY_URL.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ConfigSnapshotInput,
  type UsageEvent,
  usdToUnits,
  walletHoldsKey,
  walletKey,
} from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';
import { DEFAULT_OUTPUT_RESERVATION, WalletGuard, worstCaseChargeUsd } from './wallet-guard.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const model = (inputPerMTok: string, outputPerMTok: string, maxOutputTokens?: number) => ({
  model: { pricing: { inputPerMTok, outputPerMTok }, maxOutputTokens },
});

describe('worst-case charge', () => {
  it('prices the input estimate plus the output cap at the most expensive candidate', () => {
    // 1000 in × $3/M + 500 out × $15/M = 0.003 + 0.0075
    expect(worstCaseChargeUsd([model('3', '15'), model('1', '2')], 1_000, 500)).toBe('0.01050000');
  });

  it('falls back to the model cap, then to the default reservation', () => {
    expect(worstCaseChargeUsd([model('0', '1', 2_000)], 0, undefined)).toBe('0.00200000');
    expect(worstCaseChargeUsd([model('0', '1')], 0, undefined)).toBe(
      (DEFAULT_OUTPUT_RESERVATION / 1_000_000).toFixed(8),
    );
  });

  it('prices at the sale price with the group multiplier', () => {
    const sold = {
      model: {
        pricing: { inputPerMTok: '1', outputPerMTok: '1' },
        sale: { multiplier: '1.5', cacheMultiplier: '0' },
      },
    };
    // 1M tokens × $1/M × 1.5 × 2
    expect(worstCaseChargeUsd([sold], 1_000_000, 0, '2')).toBe('3.00000000');
  });
});

describe('Valkey outage', () => {
  const dead = () =>
    new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => 1_000,
    }).on('error', () => undefined);

  it('fail-open lets the request through, fail-closed rejects as unavailable', async () => {
    const open = new WalletGuard({ redis: dead(), logger, failMode: () => 'open' });
    expect(await open.reserve('w', 'r1', '1')).toEqual({ ok: true, reserved: false });
    const closed = new WalletGuard({ redis: dead(), logger, failMode: () => 'closed' });
    expect(await closed.reserve('w', 'r2', '1')).toMatchObject({ ok: false, unavailable: true });
  });
});

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

describe.skipIf(!VALKEY_URL)('wallet reservations on real Valkey', () => {
  const conns: Redis[] = [];
  const conn = () => {
    const r = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: 1 });
    conns.push(r);
    return r;
  };
  afterAll(() => {
    for (const c of conns) c.disconnect();
  });
  const fund = async (redis: Redis, walletId: string, usd: string) => {
    await redis.del(walletKey(walletId), walletHoldsKey(walletId));
    await redis.hset(walletKey(walletId), 'balance', usdToUnits(usd), 'version', 1, 'held', 0);
  };

  it('concurrent requests from several replicas never reserve more than the balance', async () => {
    const admin = conn();
    const walletId = `w-${randomUUID()}`;
    await fund(admin, walletId, '1');
    const guards = [1, 2, 3].map(
      () => new WalletGuard({ redis: conn(), logger, failMode: () => 'open' }),
    );
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (guards[i % 3] ?? guards[0])!.reserve(walletId, `req-${String(i)}`, '0.1'),
      ),
    );
    expect(results.filter((r) => r.ok).length).toBe(10);
    expect(await admin.hget(walletKey(walletId), 'held')).toBe(String(usdToUnits('1')));
    const rejected = results.find((r) => !r.ok);
    expect(rejected).toMatchObject({ ok: false, availableUsd: '0.00000000', neededUsd: '0.1' });
  });

  it('settle swaps the reservation for the real charge, or drops it when nothing is charged', async () => {
    const redis = conn();
    const walletId = `w-${randomUUID()}`;
    await fund(redis, walletId, '1');
    const guard = new WalletGuard({ redis, logger, failMode: () => 'open' });
    expect((await guard.reserve(walletId, 'a', '0.5')).ok).toBe(true);
    expect((await guard.reserve(walletId, 'b', '0.5')).ok).toBe(true);
    expect((await guard.reserve(walletId, 'c', '0.01')).ok).toBe(false);
    guard.settle(walletId, 'a', '0.02');
    guard.settle(walletId, 'b', '0');
    await new Promise((r) => setTimeout(r, 50));
    expect(await redis.hget(walletKey(walletId), 'held')).toBe(String(usdToUnits('0.02')));
    expect(await redis.hkeys(walletHoldsKey(walletId))).toEqual(['a']);
    expect((await guard.reserve(walletId, 'c', '0.9')).ok).toBe(true);
  });

  it('an unknown wallet has no credit', async () => {
    const guard = new WalletGuard({ redis: conn(), logger, failMode: () => 'open' });
    expect(await guard.reserve(`missing-${randomUUID()}`, 'r', '0.01')).toMatchObject({
      ok: false,
      availableUsd: '0.00000000',
    });
  });

  it('end to end: an empty wallet gets 402 insufficient_credit, a funded one is served', async () => {
    const keyring = parseKeyring(generateKey());
    const pepper = 'p'.repeat(32);
    const KEY = 'dr-wallet-e2e-0001';
    const walletId = `w-${randomUUID()}`;
    const admin = conn();
    await fund(admin, walletId, '0');
    const mock = buildMock();
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        {
          id: 'p',
          organizationId: 'org',
          slug: 'p',
          type: 'openai-compatible',
          name: 'p',
          baseUrl: `${mockRoot}/v1`,
          enabled: true,
          options: {},
          credentials: [
            { id: 'k', name: 'k', secret: encrypt(keyring, 'sk-x', 'k'), enabled: true },
          ],
        },
      ],
      models: [
        {
          id: 'm',
          organizationId: 'org',
          slug: 'm',
          providerId: 'p',
          upstreamModel: 'mock-small',
          enabled: true,
          pricing: { inputPerMTok: '10', outputPerMTok: '10' },
          capabilities: {},
        },
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        {
          id: 'vk',
          hash: hashApiKey(KEY, pepper),
          prefix: 'dr-wall',
          organizationId: 'org',
          teamId: null,
          projectId: 'prj',
          enabled: true,
          expiresAt: null,
          walletId,
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-wallet-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    const events: UsageEvent[] = [];
    const gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: (e) => events.push(e),
      limiterRedis: conn(),
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    const base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
    const ask = () =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
    try {
      const empty = await ask();
      expect(empty.status).toBe(402);
      expect(await empty.json()).toMatchObject({
        error: { type: 'insufficient_quota', code: 'insufficient_credit' },
      });

      await fund(admin, walletId, '1');
      const ok = await ask();
      expect(ok.status).toBe(200);
      await ok.text();
      await new Promise((r) => setTimeout(r, 50));
      const event = events.at(-1);
      expect(event?.walletId).toBe(walletId);
      // The hold now carries the real charge, waiting for the worker to post the debit.
      const holds = await admin.hgetall(walletHoldsKey(walletId));
      expect(Object.keys(holds)).toEqual([event?.requestId]);
      expect(holds[event?.requestId ?? '']?.split(':')[0]).toBe(
        String(usdToUnits(event?.costUsd ?? '0')),
      );
    } finally {
      await gw.app.close();
      await mock.close();
    }
  });
});
