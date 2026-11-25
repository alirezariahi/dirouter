/**
 * Request-level routing through the gateway: provider preferences and fallback models (card 32.1).
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const INTERNAL = 'internal-token-for-tests-000000001';
const OPEN = 'dr-route-open-000001';
const LOCKED = 'dr-route-lock-000001';
const ZDR = 'dr-route-zdr-0000001';

type Snapshot = ConfigSnapshotInput;

function snapshotFor(mockRoot: string, keyring: ReturnType<typeof parseKeyring>): Snapshot {
  const provider = (
    id: string,
    secret: string,
    extra: Partial<Snapshot['providers'][number]> = {},
  ) => ({
    id,
    organizationId: 'org',
    slug: id,
    type: 'openai-compatible' as const,
    name: `Provider ${id}`,
    baseUrl: `${mockRoot}/v1`,
    enabled: true,
    options: {},
    credentials: [
      { id: `${id}-k`, name: 'k', secret: encrypt(keyring, secret, `${id}-k`), enabled: true },
    ],
    ...extra,
  });
  const model = (id: string, providerId: string, input: string, output: string) => ({
    id,
    organizationId: 'org',
    slug: id,
    providerId,
    upstreamModel: `up-${id}`,
    enabled: true,
    pricing: { inputPerMTok: input, outputPerMTok: output },
    capabilities: { tools: true },
  });
  const key = (raw: string, id: string, projectId = 'prj') => ({
    id,
    hash: hashApiKey(raw, pepper),
    prefix: id,
    organizationId: 'org',
    teamId: null,
    projectId,
    enabled: true,
    expiresAt: null,
  });
  return {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      provider('alpha', 'sk-alpha', {
        dataPolicy: { region: 'eu', country: 'DE', zdr: true, trainsOnData: false },
      }),
      provider('beta', 'sk-beta', {
        dataPolicy: { region: 'us', country: 'US', zdr: false, trainsOnData: true },
      }),
      provider('gamma', 'sk-gamma'),
      provider('down', 'mock:status=503', { dataPolicy: { region: 'eu', zdr: true } }),
    ],
    models: [
      model('m-alpha', 'alpha', '3', '12'),
      model('m-beta', 'beta', '1', '4'),
      model('m-gamma', 'gamma', '2', '8'),
      model('m-down', 'down', '1', '1'),
      { ...model('m-embed', 'beta', '1', '0'), capabilities: { embeddings: true } },
    ],
    combos: [
      {
        id: 'cmb',
        organizationId: 'org',
        slug: 'chat',
        strategy: 'priority',
        targets: [
          { modelId: 'm-alpha', order: 0 },
          { modelId: 'm-beta', order: 1 },
          { modelId: 'm-gamma', order: 2 },
        ],
      },
      // A ZDR target that fails, then targets without ZDR (card 32.5).
      {
        id: 'cmb-zdr',
        organizationId: 'org',
        slug: 'zdr-chain',
        strategy: 'priority',
        targets: [
          { modelId: 'm-down', order: 0 },
          { modelId: 'm-beta', order: 1 },
          { modelId: 'm-gamma', order: 2 },
        ],
      },
      {
        id: 'cmb-zdr-hedged',
        organizationId: 'org',
        slug: 'zdr-hedged',
        strategy: 'priority',
        targets: [
          { modelId: 'm-down', order: 0 },
          { modelId: 'm-beta', order: 1 },
        ],
        hedging: { enabled: true, afterMs: 1, maxParallel: 2 },
      },
    ],
    aliases: [],
    virtualKeys: [key(OPEN, 'vk-open'), key(LOCKED, 'vk-locked'), key(ZDR, 'vk-zdr', 'prj-zdr')],
    routingPolicies: [
      // The project requires zero data retention; the key's own rule tries to relax it.
      {
        organizationId: 'org',
        scope: 'project',
        scopeId: 'prj-zdr',
        dataPolicy: { requireZdr: true },
      },
      { organizationId: 'org', scope: 'key', scopeId: 'vk-zdr', dataPolicy: { requireZdr: false } },
      {
        organizationId: 'org',
        scope: 'key',
        scopeId: 'vk-locked',
        provider: { order: ['beta'], ignore: ['alpha'] },
        lockProvider: true,
      },
    ],
    settings: { defaultRetry: { maxAttempts: 1 } },
  };
}

describe('request routing', () => {
  const mock = buildMock();
  const usage: UsageEvent[] = [];
  let base = '';
  let mockRoot = '';
  let close: () => Promise<void> = async () => undefined;

  const chat = (key: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body }),
    });
  const simulate = async (body: Record<string, unknown>) => {
    const res = await fetch(`${base}/internal/routes/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const simulatedProviders = async (body: Record<string, unknown>) =>
    ((await simulate(body)).body.candidates as { provider: string }[]).map((c) => c.provider);
  const lastUpstreamBody = async () => {
    const stats = (await (await fetch(`${mockRoot}/__mock/stats`)).json()) as { last: unknown[] };
    return stats.last.at(-1) as Record<string, unknown>;
  };

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const keyring = parseKeyring(generateKey());
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-routing-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshotFor(mockRoot, keyring)));
    const gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      internalToken: INTERNAL,
      emitUsage: (e) => usage.push(e),
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
    close = async () => {
      await gw.app.close();
      await mock.close();
    };
  });
  afterAll(() => close());
  beforeEach(async () => {
    await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
  });

  describe('provider preferences (card 32.1)', () => {
    it('an OpenRouter-format request works unchanged and no provider sees the routing fields', async () => {
      const res = await chat(OPEN, {
        model: 'chat',
        models: ['m-beta'],
        route: 'fallback',
        provider: {
          order: ['gamma', 'beta'],
          allow_fallbacks: true,
          require_parameters: false,
          data_collection: 'allow',
          quantizations: ['fp16'],
          sort: 'price',
          max_price: { prompt: 5, completion: '20' },
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-dirouter-provider')).toBe('gamma');
      const upstream = await lastUpstreamBody();
      expect(upstream.model).toBe('up-m-gamma');
      expect(upstream).not.toHaveProperty('provider');
      expect(upstream).not.toHaveProperty('models');
      expect(upstream).not.toHaveProperty('route');
    });

    it('each field has the same effect live and in the simulator', async () => {
      const cases: [Record<string, unknown>, string[]][] = [
        [{}, ['alpha', 'beta', 'gamma']],
        [{ order: ['gamma'] }, ['gamma', 'alpha', 'beta']],
        [{ only: ['beta', 'gamma'] }, ['beta', 'gamma']],
        [{ ignore: ['alpha'] }, ['beta', 'gamma']],
        [{ order: ['gamma'], allow_fallbacks: false }, ['gamma']],
        [{ sort: 'price' }, ['beta', 'gamma', 'alpha']],
        [{ max_price: { completion: 8 } }, ['beta', 'gamma']],
      ];
      for (const [provider, expected] of cases) {
        expect(
          await simulatedProviders({ model: 'chat', virtualKeyId: 'vk-open', provider }),
        ).toEqual(expected);
        const res = await chat(OPEN, { model: 'chat', provider });
        expect(res.status).toBe(200);
        expect(res.headers.get('x-dirouter-provider')).toBe(expected[0]);
      }
    });

    it('records live throughput and sorts by it', async () => {
      for (const provider of ['alpha', 'beta', 'gamma'])
        await chat(OPEN, { model: 'chat', provider: { only: [provider] } });
      const sim = await simulate({
        model: 'chat',
        virtualKeyId: 'vk-open',
        provider: { sort: 'throughput' },
      });
      const candidates = sim.body.candidates as {
        provider: string;
        signals: { throughputTps?: number };
      }[];
      for (const c of candidates) expect(c.signals.throughputTps).toBeGreaterThan(0);
      const speeds = candidates.map((c) => c.signals.throughputTps ?? 0);
      expect([...speeds].sort((a, b) => b - a)).toEqual(speeds);
    });

    it('max_price leaves no candidate: a clear 400, live and in the simulator', async () => {
      const res = await chat(OPEN, { model: 'chat', provider: { max_price: { prompt: 0.5 } } });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string; param: string };
      };
      expect(body.error.code).toBe('no_provider_matches_preferences');
      expect(body.error.param).toBe('provider');
      expect(body.error.message).toContain('above_max_price_prompt ×3');
      const sim = await simulate({
        model: 'chat',
        virtualKeyId: 'vk-open',
        provider: { max_price: { prompt: 0.5 } },
      });
      expect(sim.status).toBe(400);
      expect(sim.body.error).toMatchObject({ code: 'no_provider_matches_preferences' });
    });

    it('rejects a malformed provider object or models array', async () => {
      expect((await chat(OPEN, { model: 'chat', provider: { sort: 'fastest' } })).status).toBe(400);
      expect((await chat(OPEN, { model: 'chat', models: 'm-beta' })).status).toBe(400);
    });

    it('the models array falls back to the next model when the first one fails', async () => {
      const res = await chat(OPEN, { model: 'm-down', models: ['m-gamma'] });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-dirouter-provider')).toBe('gamma');
      const event = usage.at(-1);
      expect(event?.attempts.map((a) => a.providerId)).toEqual(['down', 'gamma']);
    });

    it('a locked key ignores the client preferences and says so', async () => {
      const res = await chat(LOCKED, {
        model: 'chat',
        models: ['m-down'],
        provider: { order: ['alpha'], only: ['alpha'] },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-dirouter-provider')).toBe('beta');
      expect(res.headers.get('x-dirouter-preferences')).toBe('locked');
      const sim = await simulate({
        model: 'chat',
        virtualKeyId: 'vk-locked',
        provider: { only: ['alpha'] },
      });
      expect(sim.body).toMatchObject({
        clientPreferencesIgnored: true,
        policy: { lockProvider: true, sources: [{ scope: 'key', scopeId: 'vk-locked' }] },
      });
      expect((sim.body.candidates as { provider: string }[]).map((c) => c.provider)).toEqual([
        'beta',
        'gamma',
      ]);
    });
  });

  describe('data policy and region (card 32.5)', () => {
    const upstreamKeys = async () =>
      Object.keys(
        ((await (await fetch(`${mockRoot}/__mock/stats`)).json()) as { byKey: object }).byKey,
      );

    it('with a ZDR-only policy a failing ZDR target never falls back to a provider without ZDR', async () => {
      for (const model of ['zdr-chain', 'zdr-hedged']) {
        const res = await chat(ZDR, { model });
        // The only allowed target failed: an upstream error, never an answer from beta or gamma.
        expect(res.status).toBeGreaterThanOrEqual(500);
        await res.text();
        expect(await upstreamKeys()).toEqual(['Bearer mock:status=503']);
        const event = usage.at(-1);
        expect(event?.attempts.map((a) => a.providerId)).toEqual(['down']);
        expect(event?.routeDecision?.dataPolicy).toEqual({ requireZdr: true });
        expect(event?.routeDecision?.skipped).toContainEqual({
          modelId: 'm-beta',
          credentialId: 'beta-k',
          reason: 'not_zdr',
        });
        expect(new Set(event?.routeDecision?.skipped?.map((x) => x.reason))).toEqual(
          new Set(['not_zdr']),
        );
      }
    });

    it('the client cannot weaken the policy with request fields', async () => {
      const res = await chat(ZDR, {
        model: 'chat',
        provider: { zdr: false, data_collection: 'allow', order: ['beta'], regions: ['us', 'eu'] },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-dirouter-provider')).toBe('alpha');
      expect(await upstreamKeys()).toEqual(['Bearer sk-alpha']);
      const only = await chat(ZDR, { model: 'chat', provider: { only: ['beta', 'gamma'] } });
      expect(only.status).toBe(400);
      expect(await upstreamKeys()).toEqual(['Bearer sk-alpha']);
    });

    it('no candidate left: a clear 400 that names the data policy', async () => {
      const res = await chat(ZDR, { model: 'm-beta' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('no_provider_matches_data_policy');
      expect(body.error.message).toContain('not_zdr ×1');
      // Embeddings and other metered calls carry the caller's data too.
      const embed = await fetch(`${base}/v1/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ZDR}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm-embed', input: 'secret text' }),
      });
      expect(embed.status).toBe(400);
      expect(((await embed.json()) as { error: { code: string } }).error.code).toBe(
        'no_provider_matches_data_policy',
      );
      expect(await upstreamKeys()).toEqual([]);
    });

    it('a request can make the policy stricter: zdr, data_collection, regions and countries', async () => {
      const cases: [Record<string, unknown>, string[]][] = [
        [{ zdr: true }, ['alpha']],
        [{ data_collection: 'deny' }, ['alpha']],
        [{ regions: ['us'] }, ['beta']],
        [{ countries: ['DE', 'US'] }, ['alpha', 'beta']],
      ];
      for (const [provider, expected] of cases) {
        const sim = await simulate({ model: 'chat', virtualKeyId: 'vk-open', provider });
        expect((sim.body.candidates as { provider: string }[]).map((c) => c.provider)).toEqual(
          expected,
        );
        const res = await chat(OPEN, { model: 'chat', provider });
        expect(res.headers.get('x-dirouter-provider')).toBe(expected[0]);
      }
    });

    it('the simulator shows the effective policy and why each target was removed', async () => {
      const sim = await simulate({ model: 'zdr-chain', virtualKeyId: 'vk-zdr' });
      expect(sim.status).toBe(200);
      expect(sim.body.dataPolicy).toEqual({ requireZdr: true });
      expect(sim.body.skipped).toEqual([
        { modelId: 'm-beta', credentialId: 'beta-k', reason: 'not_zdr' },
        { modelId: 'm-gamma', credentialId: 'gamma-k', reason: 'not_zdr' },
      ]);
      const none = await simulate({ model: 'm-beta', virtualKeyId: 'vk-zdr' });
      expect(none.status).toBe(400);
      expect(none.body).toMatchObject({
        error: { code: 'no_provider_matches_data_policy' },
        dataPolicy: { requireZdr: true },
      });
    });
  });
});
