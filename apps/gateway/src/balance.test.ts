/** Upstream balance lookups and scheduled channel tests (card 32.9). */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ConfigSnapshot,
  type ModelConfig,
  type ProviderConfig,
  UPSTREAM_BALANCES_KEY,
} from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { HealthRegistry } from '@dirouter/routing';
import { createLogger, encrypt, generateKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BalanceMonitor, lookupBalances } from './balance.js';
import { channelTest, createChannelTester, testModel } from './channel-test.js';
import { HealthProber, type ProbeRedis } from './health-probe.js';
import type { ProbeResult } from './probe.js';
import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const logger = createLogger({ service: 'test', level: 'silent' });
const INTERNAL = 'i'.repeat(32);
const mock = buildMock();
let root = '';

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const address = mock.server.address();
  root = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
});
afterAll(() => mock.close());
beforeEach(async () => {
  await fetch(`${root}/__mock/balance`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 42.5 }),
  });
});

const credential = (id: string, secret: string) => ({
  id,
  name: id,
  secret: encrypt(keyring, secret, id),
  enabled: true,
  weight: 1,
  headers: {},
});
const provider = (
  id: string,
  options: Record<string, unknown>,
  secrets: Record<string, string> = { [`${id}-k`]: 'sk-mock' },
  baseUrl = `${root}/v1`,
): ProviderConfig => ({
  id,
  organizationId: 'org',
  slug: id,
  type: 'openai-compatible',
  name: id,
  baseUrl,
  enabled: true,
  options,
  credentials: Object.entries(secrets).map(([cid, secret]) => credential(cid, secret)),
});
const model = (id: string, providerId: string, input: string, extra = {}): ModelConfig => ({
  id,
  organizationId: 'org',
  slug: id,
  providerId,
  upstreamModel: 'mock-small',
  enabled: true,
  pricing: { inputPerMTok: input, outputPerMTok: input },
  capabilities: {
    streaming: true,
    tools: false,
    vision: false,
    reasoning: false,
    jsonMode: false,
    embeddings: false,
    ...extra,
  },
});

function fakeRedis() {
  const lists = new Map<string, string[]>();
  const redis: ProbeRedis = {
    set: () => Promise.resolve('OK'),
    lpush: (key, ...values) => {
      const list = lists.get(key) ?? [];
      list.unshift(...values);
      lists.set(key, list);
      return Promise.resolve(list.length);
    },
    ltrim: () => Promise.resolve('OK'),
  };
  return { redis, lists };
}

describe('upstream balances', () => {
  it('reads the balance of four provider APIs from their answers', async () => {
    for (const kind of ['openrouter', 'deepseek', 'moonshot', 'siliconflow']) {
      const [sample] = await lookupBalances(provider(kind, { preset: kind }), keyring);
      expect(sample).toMatchObject({
        providerId: kind,
        credentialId: `${kind}-k`,
        kind,
        ok: true,
        amount: '42.5',
        currency: kind === 'siliconflow' ? 'CNY' : 'USD',
      });
    }
  });

  it('reports a refused key, and skips providers without a balance API', async () => {
    const [bad] = await lookupBalances(
      provider('or', { balance: 'openrouter' }, { 'or-bad': 'mock:auth' }),
      keyring,
    );
    expect(bad).toMatchObject({ ok: false, credentialId: 'or-bad' });
    expect(bad?.error).toMatch(/HTTP 401/);
    expect(await lookupBalances(provider('plain', {}), keyring)).toEqual([]);
    expect(
      await lookupBalances(provider('off', { preset: 'openrouter', balance: 'none' }), keyring),
    ).toEqual([]);
  });

  it('the monitor pushes one sample per credential for the worker, and stays quiet when off', async () => {
    const { redis, lists } = fakeRedis();
    const providers = [
      provider('openrouter', { preset: 'openrouter' }, { a: 'sk-1', b: 'sk-2' }),
      provider('plain', {}),
    ];
    let settings: Record<string, unknown> = {};
    const monitor = new BalanceMonitor({
      snapshot: () =>
        ({ providers, settings: { upstreamBalance: settings } }) as unknown as ConfigSnapshot,
      keyring,
      logger,
      instance: 't',
      redis,
    });
    const samples = await monitor.round();
    expect(samples.map((s) => s.credentialId)).toEqual(['a', 'b']);
    expect(lists.get(UPSTREAM_BALANCES_KEY)).toHaveLength(2);
    settings = { enabled: false };
    expect(await monitor.round()).toEqual([]);
  });

  it('answers the control-api on the internal route, behind the internal token', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-balance-'));
    await writeFile(
      join(dataDir, 'snapshot.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: 1,
        generatedAt: new Date().toISOString(),
        providers: [],
        models: [],
        combos: [],
        aliases: [],
        virtualKeys: [],
        settings: {},
      }),
    );
    const gw = buildGateway({
      logger,
      keyring,
      pepper: 'p'.repeat(32),
      dataDir,
      internalToken: INTERNAL,
    });
    await gw.start();
    try {
      const body = { provider: provider('deepseek', { preset: 'deepseek' }) };
      const hidden = await gw.app.inject({
        method: 'POST',
        url: '/internal/providers/balance',
        payload: body,
      });
      expect(hidden.statusCode).toBe(404);
      const res = await gw.app.inject({
        method: 'POST',
        url: '/internal/providers/balance',
        headers: { authorization: `Bearer ${INTERNAL}` },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        kind: 'deepseek',
        balances: [{ ok: true, amount: '42.5', currency: 'USD' }],
      });
    } finally {
      await gw.app.close();
    }
  });
});

describe('scheduled channel tests', () => {
  it('tests with the cheapest chat model of the provider', () => {
    const p = provider('p', {});
    const snapshot = {
      providers: [p],
      models: [
        model('pricey', 'p', '10'),
        model('embed', 'p', '0.01', { embeddings: true }),
        model('cheap', 'p', '0.5'),
        model('other', 'q', '0.1'),
      ],
    } as unknown as ConfigSnapshot;
    expect(testModel(snapshot, p)?.id).toBe('cheap');
  });

  it('sends one small real request and classifies key and credit failures', async () => {
    const p = provider('p', {}, { good: 'sk-mock', bad: 'mock:auth', broke: 'mock:status=402' });
    const m = model('cheap', 'p', '0.5');
    await fetch(`${root}/__mock/reset`, { method: 'POST' });
    expect(await channelTest(p, 'good', m, keyring)).toMatchObject({ ok: true, status: 200 });
    const stats = (await (await fetch(`${root}/__mock/stats`)).json()) as {
      last: { max_tokens?: number; messages: unknown[] }[];
    };
    expect(stats.last.at(-1)).toMatchObject({ max_tokens: 1 });
    expect(await channelTest(p, 'bad', m, keyring)).toMatchObject({
      ok: false,
      error: { class: 'auth' },
    });
    expect(await channelTest(p, 'broke', m, keyring)).toMatchObject({
      ok: false,
      status: 402,
      error: { class: 'quota' },
    });
  });

  it('takes a failing credential out of rotation and brings it back after it passes again', async () => {
    const health = new HealthRegistry({});
    const p = provider('p', {}, { c1: 'sk-mock' });
    const snapshot = {
      providers: [p],
      models: [model('cheap', 'p', '0.5')],
      settings: { channelTest: { enabled: true, failureThreshold: 2 } },
    } as unknown as ConfigSnapshot;
    const results: ProbeResult[] = [
      {
        ok: false,
        status: 402,
        latencyMs: 1,
        error: { class: 'quota', message: 'no credit' },
        models: [],
      },
      {
        ok: false,
        status: 402,
        latencyMs: 1,
        error: { class: 'quota', message: 'no credit' },
        models: [],
      },
      { ok: true, status: 200, latencyMs: 1, models: [] },
    ];
    const tester = createChannelTester({
      snapshot: () => snapshot,
      health,
      keyring,
      logger,
      instance: 't',
      test: () => Promise.resolve(results.shift() ?? { ok: true, latencyMs: 1, models: [] }),
    });
    await tester.round();
    expect(health.credentialDisabledReason('c1')).toBeUndefined();
    await tester.round();
    expect(health.credentialDisabledReason('c1')).toMatch(/^channel_test: no credit/);

    // The model-list probe answers fine without credit, so it must not bring the key back.
    const listProbe = new HealthProber({
      snapshot: () =>
        ({
          ...snapshot,
          settings: { healthProbe: { enabled: true } },
        }) as unknown as ConfigSnapshot,
      health,
      keyring,
      logger,
      instance: 't',
      probe: () => Promise.resolve({ ok: true, status: 200, latencyMs: 1, models: [] }),
    });
    await listProbe.round();
    expect(health.credentialDisabledReason('c1')).toMatch(/^channel_test/);

    await tester.round();
    expect(health.credentialDisabledReason('c1')).toBeUndefined();
  });

  it('does nothing until switched on', async () => {
    let calls = 0;
    const tester = createChannelTester({
      snapshot: () =>
        ({
          providers: [provider('p', {})],
          models: [model('cheap', 'p', '0.5')],
          settings: {},
        }) as unknown as ConfigSnapshot,
      health: new HealthRegistry({}),
      keyring,
      logger,
      instance: 't',
      test: () => {
        calls++;
        return Promise.resolve({ ok: true, latencyMs: 1, models: [] });
      },
    });
    expect(await tester.round()).toEqual([]);
    expect(calls).toBe(0);
  });
});
