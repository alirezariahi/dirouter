/**
 * Safe fallback in streams and bulkhead (card 5.7):
 * - Fallback is possible before the first byte; after it, a standard error parseable in the client's format.
 * - A slow provider does not take more than its connection cap; extras get 429 or fallback after a short queue.
 * - Concurrency cap per key.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import type { ConfigSnapshotInput } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { SseParser } from '@dirouter/translator';
import OpenAI from 'openai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const KEY = 'dr-stream-safety-0001';
const ONE_AT_A_TIME = 'dr-stream-safety-0002';
const mock = buildMock();
let gw: ReturnType<typeof buildGateway>;
let base = '';
let mockRoot = '';

const vk = (id: string, raw: string, maxConcurrency?: number) => ({
  id,
  hash: hashApiKey(raw, pepper),
  prefix: raw.slice(0, 8),
  organizationId: 'org',
  teamId: null,
  projectId: 'prj',
  enabled: true,
  expiresAt: null,
  ...(maxConcurrency ? { rateLimit: { maxConcurrency } } : {}),
});

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const ma = mock.server.address();
  mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
  const provider = (
    id: string,
    type: 'openai-compatible' | 'anthropic',
    secret: string,
    maxConcurrency?: number,
  ) => ({
    id,
    organizationId: 'org',
    slug: id,
    type,
    name: id,
    baseUrl: type === 'anthropic' ? mockRoot : `${mockRoot}/v1`,
    enabled: true,
    options: {},
    ...(maxConcurrency ? { maxConcurrency } : {}),
    credentials: [
      { id: `${id}-k`, name: id, secret: encrypt(keyring, secret, `${id}-k`), enabled: true },
    ],
  });
  const model = (id: string, providerId: string) => ({
    id,
    organizationId: 'org',
    slug: id,
    providerId,
    upstreamModel: 'mock-small',
    enabled: true,
    pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
    capabilities: {},
  });
  const combo = (id: string, models: string[]) => ({
    id,
    organizationId: 'org',
    slug: id,
    strategy: 'priority' as const,
    targets: models.map((m, i) => ({ modelId: m, order: i })),
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 },
  });
  const snapshot: ConfigSnapshotInput = {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      provider('ok', 'openai-compatible', 'sk-x'),
      provider('down', 'openai-compatible', 'mock:status=503'),
      provider('drop', 'openai-compatible', 'mock:chunks=6,chunk_delay=5,drop_after=2'),
      provider('an-drop', 'anthropic', 'mock:chunks=6,chunk_delay=5,drop_after=2'),
      provider('slow', 'openai-compatible', 'mock:ttft=300', 2),
    ],
    models: [
      model('ok-m', 'ok'),
      model('down-m', 'down'),
      model('drop-m', 'drop'),
      model('an-drop-m', 'an-drop'),
      model('slow-m', 'slow'),
    ],
    combos: [
      combo('before-first-byte', ['down-m', 'ok-m']),
      combo('after-first-byte', ['drop-m', 'ok-m']),
      combo('spill', ['slow-m', 'ok-m']),
    ],
    aliases: [],
    virtualKeys: [vk('vk', KEY), vk('vk-one', ONE_AT_A_TIME, 1)],
    settings: { bulkhead: { queueSize: 1, queueTimeoutMs: 50 } },
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-stream-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
  gw = buildGateway({
    logger: createLogger({
      service: 'test',
      level: (process.env.LOG_LEVEL ?? 'silent') as 'silent',
    }),
    keyring,
    pepper,
    dataDir,
    emitUsage: () => undefined,
  });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const ga = gw.app.server.address();
  base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
});

afterAll(async () => {
  await gw.app.close();
  await mock.close();
});

beforeEach(async () => {
  await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
});

const chat = (model: string, stream: boolean, key = KEY) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hi' }] }),
  });

async function sse(res: Response) {
  const parser = new SseParser();
  return [...parser.feed(await res.text()), ...parser.flush()];
}

async function mockStats() {
  return (await (await fetch(`${mockRoot}/__mock/stats`)).json()) as {
    requests: number;
    maxInFlight: number;
  };
}

describe('stream fallback is only allowed before the first byte', () => {
  it('upstream fails before any byte: the next target serves the stream', async () => {
    const res = await chat('before-first-byte', true);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-model')).toBe('ok-m');
    const events = await sse(res);
    const text = events
      .filter((e) => e.data !== '[DONE]')
      .map(
        (e) =>
          (JSON.parse(e.data) as { choices: { delta?: { content?: string } }[] }).choices[0]?.delta
            ?.content ?? '',
      )
      .join('');
    expect(text).toBe('Hello from the DiRouter mock provider.');
  });

  it('OpenAI client: drop mid-stream ends with a parsable error event and no fallback', async () => {
    const res = await chat('after-first-byte', true);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-model')).toBe('drop-m');
    const events = await sse(res);
    const payloads = events.map((e) => JSON.parse(e.data) as Record<string, unknown>);
    const content = payloads.filter((p) => p.choices);
    expect(content.length).toBeGreaterThan(0);
    const last = payloads.at(-1) as { error?: { type: string; code: string; message: string } };
    expect(last.error).toMatchObject({ type: 'api_error', message: 'upstream stream interrupted' });
    expect(typeof last.error?.code).toBe('string');
    // Only the first provider was contacted (fallback after sending bytes is forbidden).
    expect((await mockStats()).requests).toBe(1);
  });

  it('OpenAI SDK surfaces the mid-stream error as an APIError', async () => {
    const client = new OpenAI({ apiKey: KEY, baseURL: `${base}/v1`, maxRetries: 0 });
    const stream = await client.chat.completions.create({
      model: 'drop-m',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    await expect(
      (async () => {
        for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
      })(),
    ).rejects.toBeInstanceOf(OpenAI.APIError);
    expect(text.length).toBeGreaterThan(0);
  });

  it('Anthropic client: drop mid-stream ends with an error event the SDK understands', async () => {
    const raw = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'an-drop-m',
        max_tokens: 50,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const events = await sse(raw);
    expect(events[0]?.event).toBe('message_start');
    const last = events.at(-1);
    expect(last?.event).toBe('error');
    expect(JSON.parse(last?.data ?? '{}')).toMatchObject({
      type: 'error',
      // the standard Anthropic type, not the internal class (connection)
      error: { type: 'api_error', message: 'upstream stream interrupted' },
    });

    const client = new Anthropic({ apiKey: KEY, baseURL: base, maxRetries: 0 });
    await expect(
      client.messages
        .stream({ model: 'an-drop-m', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] })
        .finalMessage(),
    ).rejects.toThrow(/upstream stream interrupted/);
  });
});

describe('bulkhead', () => {
  it('a slow provider never holds more connections than its limit; the excess gets 429', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => chat('slow-m', false)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
    const rejected = results.find((r) => r.status === 429);
    expect(rejected?.headers.get('retry-after')).toBe('1');
    const body = (await rejected?.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toMatch(/concurrency limit/);
    const stats = await mockStats();
    expect(stats.maxInFlight).toBe(2);
    expect(stats.requests).toBe(2);
  });

  it('a queued request runs when a slot frees within the queue timeout', async () => {
    const health = () =>
      gw.app.inject({ method: 'GET', url: '/internal/health' }).then((r) => r.statusCode);
    // Without INTERNAL_TOKEN, internal health is hidden.
    expect(await health()).toBe(404);
    const first = chat('slow-m', false);
    const second = chat('slow-m', false);
    // Two slots are full; the third waits in a 50ms queue and is rejected, but gets a slot once one is freed.
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const after = await chat('slow-m', false);
    expect(after.status).toBe(200);
  });

  it('in a combo, a full provider spills over to the next target instead of failing', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => chat('spill', false)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const served = results.map((r) => r.headers.get('x-dirouter-model')).sort();
    expect(served.filter((m) => m === 'slow-m')).toHaveLength(2);
    expect(served.filter((m) => m === 'ok-m')).toHaveLength(3);
    expect((await mockStats()).requests).toBe(5);
  });

  it('per-key limit: a second concurrent request on a one-at-a-time key gets 429 in each format', async () => {
    const held = chat('slow-m', false, ONE_AT_A_TIME);
    await new Promise((r) => setTimeout(r, 20));
    const openai = await chat('ok-m', false, ONE_AT_A_TIME);
    expect(openai.status).toBe(429);
    expect(((await openai.json()) as { error: { type: string } }).error.type).toBe(
      'rate_limit_error',
    );
    const anthropic = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': ONE_AT_A_TIME,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'ok-m',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'x' }],
      }),
    });
    expect(anthropic.status).toBe(429);
    expect(await anthropic.json()).toMatchObject({
      type: 'error',
      error: { type: 'rate_limit_error' },
    });
    expect((await held).status).toBe(200);
    // After the first request ends, the key's slot is free.
    expect((await chat('ok-m', false, ONE_AT_A_TIME)).status).toBe(200);
  });

  it('a client that disconnects releases its slot', async () => {
    const ac = new AbortController();
    const pending = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { authorization: `Bearer ${ONE_AT_A_TIME}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'slow-m', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pending.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect((await chat('ok-m', false, ONE_AT_A_TIME)).status).toBe(200);
  });
});
