/**
 * Limits of a key on one model, and input and output TPM apart (card 33.3). The local limiter runs
 * without Valkey; the distributed limiter and the request path run with INTEGRATION_VALKEY_URL.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalLimiter, RateLimiter } from './rate-limiter.js';
import { buildGateway } from './server.js';

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const logger = createLogger({ service: 'test', level: 'silent' });
const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('input and output TPM in the local limiter', () => {
  it('counts each side on its own window, and settles each side', () => {
    const l = new LocalLimiter(60_000, 1_000, () => 1_000_000);
    const scope = [
      { name: 'key:io', limit: { inputTokensPerMinute: 1_000, outputTokensPerMinute: 500 } },
    ];
    const first = l.acquire(scope, { input: 800, output: 400 }, 1);
    expect(first.ok).toBe(true);
    // Input is nearly used up; output still has room, and the reverse.
    expect(l.acquire(scope, { input: 300, output: 0 }, 1)).toMatchObject({
      ok: false,
      kind: 'input_tokens',
    });
    expect(l.acquire(scope, { input: 0, output: 200 }, 1)).toMatchObject({
      ok: false,
      kind: 'output_tokens',
    });
    // The request read less and wrote less than reserved.
    if (first.ok) first.settle({ input: 200, output: 50 });
    expect(l.acquire(scope, { input: 300, output: 200 }, 1).ok).toBe(true);
  });
});

describe.skipIf(!VALKEY_URL)('input and output TPM on Valkey', () => {
  let redis: Redis;
  beforeAll(async () => {
    redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false, lazyConnect: true });
    await redis.connect();
  }, 60_000);
  afterAll(() => {
    redis.disconnect();
  });

  it('rejects on the side that is full and settles each side with the actual usage', async () => {
    const limiter = new RateLimiter({ redis, logger, failMode: () => 'open' });
    const name = `key:io-${randomUUID()}`;
    const scope = [
      {
        name,
        limit: {
          inputTokensPerMinute: 1_000,
          outputTokensPerMinute: 500,
          tokensPerMinute: 10_000,
        },
      },
    ];
    const first = await limiter.acquire(scope, { input: 800, output: 400 }, 'r1');
    expect(first.ok).toBe(true);
    expect(await limiter.acquire(scope, { input: 300, output: 0 }, 'r2')).toMatchObject({
      ok: false,
      kind: 'input_tokens',
      scope: name,
    });
    expect(await limiter.acquire(scope, { input: 0, output: 200 }, 'r3')).toMatchObject({
      ok: false,
      kind: 'output_tokens',
    });
    if (first.ok) first.settle({ input: 200, output: 50 });
    await settle();
    expect((await limiter.acquire(scope, { input: 300, output: 200 }, 'r4')).ok).toBe(true);
  });
});

describe.skipIf(!VALKEY_URL)('limits of a key on one model, on the request path', () => {
  const mock = buildMock();
  let redis: Redis;
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  const run = randomUUID().slice(0, 8);
  const KEYS = {
    rpm: 'dr-modellimit-rpm-01',
    budget: 'dr-modellimit-bud-01',
    combo: 'dr-modellimit-cmb-01',
    free: 'dr-modellimit-free-1',
  };

  beforeAll(async () => {
    redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false, lazyConnect: true });
    await redis.connect();
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const upstream = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}/v1`;
    const model = (id: string) => ({
      id: `${id}-${run}`,
      organizationId: 'org',
      slug: id,
      providerId: 'p',
      upstreamModel: 'mock-small',
      enabled: true,
      // About $0.01 per request.
      pricing: { inputPerMTok: '1000', outputPerMTok: '1000' },
      capabilities: {},
    });
    const key = (
      raw: string,
      id: string,
      modelLimits: NonNullable<ConfigSnapshotInput['virtualKeys'][number]['modelLimits']>,
    ) => ({
      id: `${id}-${run}`,
      hash: hashApiKey(raw, pepper),
      prefix: id,
      organizationId: 'org',
      teamId: null,
      projectId: 'prj',
      enabled: true,
      expiresAt: null,
      modelLimits,
    });
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
          baseUrl: upstream,
          enabled: true,
          options: {},
          credentials: [
            { id: 'c', name: 'c', secret: encrypt(keyring, 'sk-x', 'c'), enabled: true },
          ],
        },
      ],
      models: [model('pricey'), model('cheap')],
      combos: [
        {
          id: `combo-${run}`,
          organizationId: 'org',
          slug: 'smart',
          strategy: 'priority',
          targets: [
            { modelId: `pricey-${run}`, order: 0 },
            { modelId: `cheap-${run}`, order: 1 },
          ],
        },
      ],
      aliases: [],
      virtualKeys: [
        key(KEYS.rpm, 'vk-rpm', [{ model: 'pricey', rateLimit: { requestsPerMinute: 1 } }]),
        key(KEYS.budget, 'vk-budget', [
          {
            model: 'pricey',
            budgets: [{ id: `kmb-${run}`, period: 'daily', limitUsd: '0.03', alertThresholds: [] }],
          },
        ]),
        key(KEYS.combo, 'vk-combo', [{ model: 'smart', rateLimit: { requestsPerMinute: 1 } }]),
        key(KEYS.free, 'vk-free', []),
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-model-limits-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: () => undefined,
      limiterRedis: redis,
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  }, 60_000);

  afterAll(async () => {
    await gw.app.close();
    await mock.close();
    redis.disconnect();
  });

  const chat = async (raw: string, modelName: string) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    await settle();
    return { status: res.status, body, model: res.headers.get('x-dirouter-model') };
  };

  it('a key has its own cap on the expensive model and none on the cheap one', async () => {
    expect((await chat(KEYS.rpm, 'pricey')).status).toBe(200);
    const second = await chat(KEYS.rpm, 'pricey');
    expect(second.status).toBe(429);
    expect(second.body.error?.message).toBe(
      'Rate limit exceeded for this key on this model (requests)',
    );
    for (let i = 0; i < 5; i++) expect((await chat(KEYS.rpm, 'cheap')).status).toBe(200);
    // Another key on the same model is not limited by it.
    for (let i = 0; i < 3; i++) expect((await chat(KEYS.free, 'pricey')).status).toBe(200);
  });

  it("a key's budget on one model stops that model and leaves the others free", async () => {
    let last = await chat(KEYS.budget, 'pricey');
    for (let i = 0; i < 10 && last.status === 200; i++) last = await chat(KEYS.budget, 'pricey');
    expect(last.status).toBe(429);
    expect(last.body.error).toMatchObject({
      code: 'budget_exceeded',
      message: "Daily key model budget exceeded for every target of 'pricey'",
    });
    // A combo that starts with the expensive model falls back to the cheap one.
    const viaCombo = await chat(KEYS.budget, 'smart');
    expect(viaCombo).toMatchObject({ status: 200, model: 'cheap' });
    for (let i = 0; i < 3; i++) expect((await chat(KEYS.budget, 'cheap')).status).toBe(200);
  });

  it('an entry naming a combo covers the requests for that name', async () => {
    expect((await chat(KEYS.combo, 'smart')).status).toBe(200);
    expect((await chat(KEYS.combo, 'smart')).status).toBe(429);
    expect((await chat(KEYS.combo, 'pricey')).status).toBe(200);
  });
});
