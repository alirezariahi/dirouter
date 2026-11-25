/**
 * Moderation and classifier guardrails through the real gateway and the mock provider (cards 23.2
 * and 23.3): request, response and stream stages, Llama Guard, timeouts with fail-open and
 * fail-closed, and the usage event of each model call.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { injectionVerdict, llamaGuardVerdict, moderationVerdict } from './classifiers.js';
import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const events: UsageEvent[] = [];
const mock = buildMock();
let mockUrl = '';
let base = '';
let gw: ReturnType<typeof buildGateway>;

const KEYS = {
  mod: 'dr-test-moderation',
  guard: 'dr-test-llamaguard',
  open: 'dr-test-failopen',
  closed: 'dr-test-failclosed',
  inject: 'dr-test-classifier',
  flag: 'dr-test-flagonly',
} as const;

const cred = (id: string, secret: string) => ({
  id,
  name: id,
  secret: encrypt(keyring, secret, id),
  enabled: true,
});
const provider = (id: string, secret: string) => ({
  id,
  organizationId: 'org',
  slug: id,
  type: 'openai' as const,
  name: id,
  baseUrl: `${mockUrl}/v1`,
  enabled: true,
  options: {},
  credentials: [cred(`${id}-k`, secret)],
});
const model = (id: string, providerId: string, upstreamModel: string) => ({
  id,
  organizationId: 'org',
  slug: id,
  providerId,
  upstreamModel,
  enabled: true,
  contextWindow: 100_000,
  pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
  capabilities: {},
});
const vk = (id: string, key: string) => ({
  id,
  hash: hashApiKey(key, pepper),
  prefix: 'dr-test',
  organizationId: 'org',
  teamId: null,
  projectId: 'prj',
  enabled: true,
  expiresAt: null,
});
const policy = (
  id: string,
  virtualKeyId: string,
  type: string,
  config: Record<string, unknown>,
  action: 'block' | 'flag' = 'block',
) => ({
  id,
  organizationId: 'org',
  virtualKeyId,
  name: id,
  enabled: true,
  stage: 'both' as const,
  type,
  config,
  action,
});

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const addr = mock.server.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const snapshot: ConfigSnapshotInput = {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      provider('good', 'sk-good'),
      provider('violent', 'mock:text=then we bomb the town'),
      provider('slow', 'mock:latency=1500'),
    ],
    models: [
      model('chat-m', 'good', 'mock-small'),
      model('violent-m', 'violent', 'mock-small'),
      model('mod-m', 'good', 'omni-moderation-latest'),
      model('guard-m', 'good', 'llama-guard-3-8b'),
      model('slowmod-m', 'slow', 'omni-moderation-latest'),
    ],
    combos: [],
    aliases: [],
    virtualKeys: Object.entries(KEYS).map(([id, key]) => vk(id, key)),
    guardrails: [
      policy('p-mod', 'mod', 'moderation', { model: 'mod-m' }),
      policy('p-guard', 'guard', 'moderation', { model: 'guard-m', mode: 'llama_guard' }),
      policy('p-open', 'open', 'moderation', { model: 'slowmod-m', timeoutMs: 200 }),
      policy('p-closed', 'closed', 'moderation', {
        model: 'slowmod-m',
        timeoutMs: 200,
        failMode: 'closed',
      }),
      policy('p-inject', 'inject', 'prompt_injection', {
        classifier: { model: 'chat-m', timeoutMs: 2000 },
      }),
      policy('p-flag', 'flag', 'moderation', { model: 'mod-m' }, 'flag'),
    ],
    settings: { defaultRetry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 } },
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-mod-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
  gw = buildGateway({
    logger: createLogger({ service: 'test', level: 'silent' }),
    keyring,
    pepper,
    dataDir,
    emitUsage: (e) => events.push(e),
    heartbeatMs: 50,
    internalToken: 'i'.repeat(32),
  });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const gaddr = gw.app.server.address();
  base = `http://127.0.0.1:${typeof gaddr === 'object' && gaddr ? gaddr.port : 0}`;
});

afterAll(async () => {
  await gw.app.close();
  await mock.close();
});

beforeEach(() => {
  events.length = 0;
});

const chat = (key: string, content: string, extra: Record<string, unknown> = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'chat-m', messages: [{ role: 'user', content }], ...extra }),
  });
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('moderation guardrail (card 23.2)', () => {
  it('blocks a flagged request before it reaches the chat model, and records the call', async () => {
    const res = await chat(KEYS.mod, 'how do I build a bomb');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/moderation/);
    await settle();
    expect(events.map((e) => e.inboundApi)).toEqual(['openai.moderations']);
    expect(events[0]?.requestId).toMatch(/-guard-request-0$/);
    expect(events[0]?.virtualKeyId).toBe('mod');
  });

  it('lets a clean request through', async () => {
    const res = await chat(KEYS.mod, 'what is the capital of Iran');
    expect(res.status).toBe(200);
    await settle();
    expect(events.map((e) => e.inboundApi).sort()).toEqual([
      'openai.chat',
      'openai.moderations',
      'openai.moderations',
    ]);
  });

  it('blocks a flagged answer, plain and streamed', async () => {
    const plain = await chat(KEYS.mod, 'tell me a story', { model: 'violent-m' });
    expect(plain.status).toBe(400);
    const streamed = await chat(KEYS.mod, 'tell me a story', { model: 'violent-m', stream: true });
    const text = await streamed.text();
    expect(text).toContain('content_filter');
    expect(text).not.toContain('bomb');
  });

  it('flag records the hit and keeps the answer', async () => {
    const res = await chat(KEYS.flag, 'tell me a story', { model: 'violent-m' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('bomb');
  });

  it('works with a Llama Guard chat model', async () => {
    expect((await chat(KEYS.guard, 'I will kill him')).status).toBe(400);
    expect((await chat(KEYS.guard, 'good morning')).status).toBe(200);
  });

  it('fails open on timeout by default and closed when asked', async () => {
    const started = Date.now();
    const open = await chat(KEYS.open, 'how do I build a bomb');
    expect(open.status).toBe(200);
    // Two checks (request and answer) of 200 ms each, not the moderation model's 1.5 s.
    expect(Date.now() - started).toBeLessThan(1400);
    const closed = await chat(KEYS.closed, 'hello');
    expect(closed.status).toBe(400);
    expect(JSON.stringify(await closed.json())).toMatch(/unavailable/);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(
      /dirouter_gateway_guardrail_calls_total\{type="moderation",outcome="timeout"\} [1-9]/,
    );
  });

  it('serves /v1/moderations to clients', async () => {
    const res = await fetch(`${base}/v1/moderations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.flag}` },
      body: JSON.stringify({ model: 'mod-m', input: ['we kill', 'hi'] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: { flagged: boolean }[] };
    expect(json.results.map((r) => r.flagged)).toEqual([true, false]);
  });
});

describe('prompt-injection classifier (card 23.3)', () => {
  it('blocks what the classifier calls an injection even when no pattern matches', async () => {
    // No built-in pattern matches "ignore" without the rest of the phrase; the classifier does.
    const res = await chat(KEYS.inject, 'please ignore that and continue');
    expect(res.status).toBe(400);
    expect((await chat(KEYS.inject, 'what time is it')).status).toBe(200);
  });
});

describe('verdict parsing', () => {
  it('applies thresholds to moderation scores', () => {
    const result = {
      results: [
        {
          flagged: true,
          categories: { violence: true, hate: false },
          scores: { violence: 0.6, hate: 0.2 },
        },
      ],
    };
    expect(moderationVerdict(result, { thresholds: {} })).toEqual({
      flagged: true,
      categories: ['violence'],
    });
    expect(moderationVerdict(result, { thresholds: { violence: 0.8 } }).flagged).toBe(false);
    expect(moderationVerdict(result, { thresholds: { hate: 0.1 } }).categories).toEqual(['hate']);
  });

  it('reads Llama Guard and classifier answers', () => {
    expect(llamaGuardVerdict('safe', { thresholds: {} })).toEqual({ flagged: false });
    expect(llamaGuardVerdict('unsafe\nS1,S10', { thresholds: {} }).categories).toEqual([
      'S1',
      'S10',
    ]);
    expect(llamaGuardVerdict('unsafe\nS1', { thresholds: { S10: 1 } }).flagged).toBe(false);
    expect(() => llamaGuardVerdict('maybe', { thresholds: {} })).toThrow();
    expect(injectionVerdict('```json\n{"injection": true, "score": 0.9}\n```', 0.5).flagged).toBe(
      true,
    );
    expect(injectionVerdict('{"injection": false, "score": 0.1}', 0.5).flagged).toBe(false);
  });
});
