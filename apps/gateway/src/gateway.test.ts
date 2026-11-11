import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { SseParser } from '@dirouter/translator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const KEY = 'dr-test-0123456789abcdef';
const LIMITED_KEY = 'dr-test-limited';
const INTERNAL = 'i'.repeat(32);
const events: UsageEvent[] = [];
const completed: UsageEvent[] = [];

const mock = buildMock();
let mockUrl = '';
let gw: ReturnType<typeof buildGateway>;
let base = '';

const cred = (id: string, secret: string) => ({
  id,
  name: id,
  secret: encrypt(keyring, secret, id),
  enabled: true,
});
const provider = (
  id: string,
  creds: ReturnType<typeof cred>[],
  timeouts?: Record<string, number>,
) => ({
  id,
  organizationId: 'org',
  slug: id,
  type: 'openai-compatible' as const,
  name: id,
  baseUrl: `${mockUrl}/v1`,
  enabled: true,
  options: {},
  credentials: creds,
  ...(timeouts ? { timeouts } : {}),
});
const model = (id: string, providerId: string) => ({
  id,
  organizationId: 'org',
  slug: id,
  providerId,
  upstreamModel: 'mock-small',
  enabled: true,
  contextWindow: 100_000,
  pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
  capabilities: {},
});
const combo = (id: string, models: string[]) => ({
  id,
  organizationId: 'org',
  slug: id,
  strategy: 'priority' as const,
  targets: models.map((m, i) => ({ modelId: m, order: i })),
  retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
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
      provider('good', [cred('good-k', 'sk-good')]),
      provider('down', [cred('down-k', 'mock:status=503')]),
      provider('slow', [cred('slow-k', 'mock:ttft=2000')], { firstByteMs: 200 }),
      provider('invalid', [cred('invalid-k', 'mock:status=400')]),
      provider('nousage', [cred('nousage-k', 'mock:no_usage')]),
      provider('limited', [
        cred('limited-k1', 'mock:rate_limit,retry_after=30'),
        cred('limited-k2', 'sk-ok'),
      ]),
    ],
    models: [
      model('good-m', 'good'),
      model('down-m', 'down'),
      model('slow-m', 'slow'),
      model('invalid-m', 'invalid'),
      model('nousage-m', 'nousage'),
      model('limited-m', 'limited'),
    ],
    combos: [
      combo('resilient', ['down-m', 'good-m']),
      combo('ttft', ['slow-m', 'good-m']),
      combo('badreq', ['invalid-m', 'good-m']),
    ],
    aliases: [{ organizationId: 'org', slug: 'gpt', target: { kind: 'model', modelId: 'good-m' } }],
    virtualKeys: [
      {
        id: 'vk',
        hash: hashApiKey(KEY, pepper),
        prefix: 'dr-test',
        organizationId: 'org',
        teamId: null,
        projectId: 'prj',
        enabled: true,
        expiresAt: null,
      },
      {
        id: 'vk2',
        hash: hashApiKey(LIMITED_KEY, pepper),
        prefix: 'dr-lim',
        organizationId: 'org',
        teamId: null,
        projectId: 'prj',
        enabled: true,
        expiresAt: null,
        allowedModels: ['gpt'],
        rateLimit: { requestsPerMinute: 2 },
      },
    ],
    settings: { defaultRetry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 } },
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-gw-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
  gw = buildGateway({
    logger: createLogger({ service: 'test', level: 'silent' }),
    keyring,
    pepper,
    dataDir,
    emitUsage: (e) => events.push(e),
    onRequestComplete: (e) => completed.push(e),
    heartbeatMs: 50,
    internalToken: INTERNAL,
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
  completed.length = 0;
});

const chat = (body: Record<string, unknown>, key = KEY) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'سلام' }], ...body }),
  });
const messages = (body: Record<string, unknown>, key = KEY) =>
  fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      max_tokens: 100,
      messages: [{ role: 'user', content: 'سلام' }],
      ...body,
    }),
  });
const sse = async (res: Response) => {
  const p = new SseParser();
  return [...p.feed(await res.text()), ...p.flush()];
};
const waitForEvent = async () => {
  for (let i = 0; i < 50 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  return events[0];
};

describe('gateway end-to-end against the mock provider', () => {
  it('serves an OpenAI request, correlates it, and exposes bounded metrics', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY}`,
        'x-request-id': 'req_observability_test',
      },
      body: JSON.stringify({
        model: 'gpt',
        messages: [{ role: 'user', content: 'secret prompt' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('req_observability_test');
    const event = await waitForEvent();
    expect(event?.requestId).toBe('req_observability_test');
    expect(completed.map((e) => e.requestId)).toEqual(['req_observability_test']);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain(
      'dirouter_gateway_requests_total{provider="good",model="good-m",status="success"}',
    );
    expect(metrics).toContain('dirouter_gateway_request_duration_seconds_count');
    expect(metrics).toContain('dirouter_gateway_upstream_attempt_duration_seconds_count');
    expect(metrics).toContain('dirouter_gateway_breaker_state');
    expect(metrics).not.toContain('req_observability_test');
    expect(metrics).not.toContain('secret prompt');
  });

  it('counts early validation failures and emits no sensitive metric labels', async () => {
    const invalid = await chat({ model: 'gpt', messages: [] });
    expect(invalid.status).toBe(422);
    expect(completed.map((e) => e.requestId)).toEqual([
      String(invalid.headers.get('x-request-id')),
    ]);
    expect((await chat({ model: 'gpt' }, LIMITED_KEY)).status).toBe(200);
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('provider="none",model="gpt",status="error"');
    expect(text).toContain('dirouter_gateway_admission_rejected_total');
    expect(text).not.toContain('organizationId');
    expect(text).not.toContain('virtualKeyId');
  });

  it('serves an OpenAI request and emits a priced usage event', async () => {
    const res = await chat({ model: 'gpt' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-provider')).toBe('good');
    const body = (await res.json()) as {
      model: string;
      choices: { message: { content: string } }[];
    };
    expect(body.model).toBe('gpt');
    expect(body.choices[0]?.message.content).toContain('mock');
    const event = await waitForEvent();
    expect(event).toMatchObject({
      status: 'success',
      virtualKeyId: 'vk',
      providerId: 'good',
      resolvedModelId: 'good-m',
      inboundApi: 'openai.chat',
    });
    expect(Number(event?.costUsd)).toBeGreaterThan(0);
  });

  it('translates an Anthropic streaming client to an OpenAI-compatible provider', async () => {
    const res = await messages({ model: 'gpt', stream: true });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const evs = await sse(res);
    expect(evs[0]?.event).toBe('message_start');
    expect(evs.at(-1)?.event).toBe('message_stop');
    const text = evs
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (JSON.parse(e.data) as { delta: { text: string } }).delta.text)
      .join('');
    expect(text).toBe('Hello from the DiRouter mock provider.');
  });

  it('estimates usage with the tokenizer when the provider sends none (json)', async () => {
    const res = await chat({ model: 'nousage-m' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    // «Hello from the DiRouter mock provider.» با o200k هشت توکن است.
    expect(body.usage.completion_tokens).toBe(8);
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    const event = await waitForEvent();
    expect(event?.usageEstimated).toBe(true);
    expect(event?.usage.outputTokens).toBe(8);
    expect(event?.usage.inputTokens).toBe(body.usage.prompt_tokens);
    expect(Number(event?.costUsd)).toBeGreaterThan(0);
  }, 30_000); // بارگذاری اول o200k روی CPU شلوغ چند ثانیه طول می‌کشد.

  it('estimates usage when a stream carries no usage chunk', async () => {
    const res = await chat({
      model: 'nousage-m',
      stream: true,
      stream_options: { include_usage: true },
    });
    const evs = await sse(res);
    const usageChunk = evs
      .filter((e) => e.data !== '[DONE]')
      .map((e) => JSON.parse(e.data) as { usage?: { completion_tokens: number } | null })
      .find((c) => c.usage);
    expect(usageChunk?.usage?.completion_tokens).toBe(8);
    const event = await waitForEvent();
    expect(event).toMatchObject({ stream: true, usageEstimated: true });
    expect(event?.usage.outputTokens).toBe(8);
  });

  it('reports real provider usage as not estimated', async () => {
    await chat({ model: 'gpt' });
    const event = await waitForEvent();
    expect(event?.usageEstimated).toBe(false);
  });

  it('falls back from a failing provider to a healthy one and records every attempt', async () => {
    const res = await chat({ model: 'resilient' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-provider')).toBe('good');
    const event = await waitForEvent();
    expect(event?.attempts.map((a) => `${a.providerId}:${a.outcome}`)).toEqual([
      'down:error',
      'down:error',
      'good:success',
    ]);
  });

  it('a TTFT timeout before any byte falls back (stream)', async () => {
    const res = await chat({
      model: 'ttft',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(res.headers.get('x-dirouter-provider')).toBe('good');
    const evs = await sse(res);
    expect(evs.at(-1)?.data).toBe('[DONE]');
    const event = await waitForEvent();
    expect(event?.attempts[0]).toMatchObject({ providerId: 'slow', outcome: 'timeout' });
  });

  it('never sends a bad request to another provider', async () => {
    await fetch(`${mockUrl}/__mock/reset`, { method: 'POST' });
    const res = await chat({ model: 'badreq' });
    expect(res.status).toBe(400);
    const stats = (await (await fetch(`${mockUrl}/__mock/stats`)).json()) as {
      byKey: Record<string, number>;
    };
    expect(stats.byKey['Bearer sk-good']).toBeUndefined();
  });

  it('rejects bad keys and disallowed models in the client format', async () => {
    const r1 = await chat({ model: 'gpt' }, 'dr-wrong');
    expect(r1.status).toBe(401);
    expect(await r1.json()).toMatchObject({
      error: { type: 'authentication_error', code: 'invalid_api_key' },
    });
    const r2 = await messages({ model: 'gpt' }, 'dr-wrong');
    expect(await r2.json()).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    });
    const r3 = await chat({ model: 'resilient' }, LIMITED_KEY);
    expect(r3.status).toBe(403);
    const r4 = await chat({ model: 'nope' });
    expect(r4.status).toBe(404);
  });

  it('validates the request body', async () => {
    const res = await chat({ model: 'gpt', messages: [] });
    expect(res.status).toBe(422);
  });

  it('cools down a rate-limited key and keeps serving with the other one', async () => {
    const ok = await chat({ model: 'limited-m' });
    expect(ok.status).toBe(200);
    // بدون توکن داخلی، مسیر وجود ندارد.
    expect((await fetch(`${base}/internal/health`)).status).toBe(404);
    expect(
      (await fetch(`${base}/internal/health`, { headers: { authorization: 'Bearer wrong' } }))
        .status,
    ).toBe(404);
    const report = (await (
      await fetch(`${base}/internal/health`, { headers: { authorization: `Bearer ${INTERNAL}` } })
    ).json()) as {
      credentials: { credentialId: string; cooldownUntil?: number }[];
    };
    if (report.credentials.length > 0)
      expect(report.credentials[0]).toMatchObject({ credentialId: 'limited-k1' });
  });

  it('lists models for the key', async () => {
    const res = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${LIMITED_KEY}` },
    });
    expect(((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual([
      'gpt',
    ]);
  });

  it('aborts the upstream when the client disconnects', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'gpt',
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
      }),
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    const event = await waitForEvent();
    expect(event).toBeDefined();
  });

  it('reports readiness with the config version', async () => {
    expect(await (await fetch(`${base}/readyz`)).json()).toMatchObject({
      status: 'ok',
      configVersion: 1,
    });
  });
});
