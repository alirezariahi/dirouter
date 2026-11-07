import type {
  CanonicalRequest,
  CanonicalStreamEvent,
  ModelConfig,
  ProviderConfig,
  ProviderType,
} from '@dirouter/contracts';
import { buildServer } from '@dirouter/mock-provider/server';
import { SseParser } from '@dirouter/translator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PRESETS,
  adapterFor,
  classifyHttpError,
  classifyNetworkError,
  presetFor,
  retryAfterFrom,
} from './index.js';

const mock = buildServer();
let base = '';
beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const addr = mock.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => mock.close());

const provider = (type: ProviderType, over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p',
  organizationId: 'o',
  slug: 's',
  type,
  name: 'n',
  baseUrl: `${base}/v1`,
  enabled: true,
  options: {},
  credentials: [],
  ...over,
});
const model: ModelConfig = {
  id: 'm',
  organizationId: 'o',
  slug: 'x/mock',
  providerId: 'p',
  upstreamModel: 'mock-small',
  enabled: true,
  pricing: { inputPerMTok: '1', outputPerMTok: '2' },
  capabilities: { streaming: true, tools: true, vision: false, reasoning: false, jsonMode: false },
};
const request = (over: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  inboundApi: 'openai.chat',
  model: 'x',
  system: [{ type: 'text', text: 'sys' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'سلام' }] }],
  stream: false,
  maxOutputTokens: 100,
  ...over,
});

async function call(p: ProviderConfig, req: CanonicalRequest, apiKey = 'k') {
  const adapter = adapterFor(p.type);
  const up = adapter.buildRequest({ provider: p, model, apiKey, request: req });
  const res = await fetch(up.url, {
    method: up.method,
    headers: up.headers,
    ...(up.body ? { body: up.body } : {}),
  });
  return { adapter, up, res };
}

async function streamEvents(p: ProviderConfig, req: CanonicalRequest) {
  const { adapter, res } = await call(p, { ...req, stream: true });
  const decoder = adapter.createStreamDecoder();
  const parser = new SseParser();
  const out: CanonicalStreamEvent[] = [];
  for (const e of [...parser.feed(await res.text()), ...parser.flush()])
    out.push(...decoder.push(e));
  return out;
}

describe('contract: every OpenAI-compatible preset against the mock', () => {
  it.each(Object.keys(PRESETS))('%s', async (name) => {
    const p = provider('openai-compatible', { options: { preset: name } });
    const { adapter, up, res } = await call(p, request());
    expect(up.url).toBe(`${base}/v1/chat/completions`);
    const body = JSON.parse(up.body ?? '{}') as Record<string, unknown>;
    expect(body[PRESETS[name]!.maxTokensField]).toBe(100);
    expect(res.status).toBe(200);
    const parsed = adapter.parseResponse(await res.json());
    expect(parsed.finishReason).toBe('stop');
    expect(parsed.usage?.inputTokens).toBeGreaterThan(0);

    const events = await streamEvents(p, request());
    const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
    expect(text).toContain('mock');
    expect(events.some((e) => e.type === 'finish')).toBe(true);
    if (PRESETS[name]!.supportsStreamOptions)
      expect(events.some((e) => e.type === 'usage')).toBe(true);
  });

  it('a brand-new compatible provider works with config only', async () => {
    const p = provider('openai-compatible', {
      options: { maxTokensField: 'max_completion_tokens', headers: { 'x-extra': '1' } },
    });
    const { up, res } = await call(p, request());
    expect(up.headers['x-extra']).toBe('1');
    expect(JSON.parse(up.body ?? '{}')).toHaveProperty('max_completion_tokens', 100);
    expect(res.status).toBe(200);
  });

  it('drops stream_options for providers that reject it', async () => {
    const { up } = await call(
      provider('openai-compatible', { options: { preset: 'mistral' } }),
      request({ stream: true }),
    );
    expect(JSON.parse(up.body ?? '{}')).not.toHaveProperty('stream_options');
  });

  it('streams tool calls', async () => {
    const p = provider('openai');
    const adapter = adapterFor('openai');
    const up = adapter.buildRequest({
      provider: p,
      model,
      apiKey: 'k',
      request: request({ stream: true }),
    });
    const res = await fetch(up.url, {
      method: 'POST',
      headers: { ...up.headers, 'x-mock': 'tool=get_weather' },
      body: up.body ?? '',
    });
    const parser = new SseParser();
    const decoder = adapter.createStreamDecoder();
    const events = [...parser.feed(await res.text()), ...parser.flush()].flatMap((e) =>
      decoder.push(e),
    );
    const args = events
      .flatMap((e) => (e.type === 'tool_call_delta' ? [e.argumentsDelta] : []))
      .join('');
    expect(JSON.parse(args)).toEqual({ city: 'Tehran' });
  });
});

describe('contract: Azure OpenAI', () => {
  it('uses the deployment path, api-version and api-key header', async () => {
    const p = provider('azure-openai', { baseUrl: base, options: { apiVersion: '2025-01-01' } });
    const { up, res, adapter } = await call(p, request());
    expect(up.url).toBe(
      `${base}/openai/deployments/mock-small/chat/completions?api-version=2025-01-01`,
    );
    expect(up.headers['api-key']).toBe('k');
    expect(JSON.parse(up.body ?? '{}')).not.toHaveProperty('model');
    expect(adapter.parseResponse(await res.json()).model).toBe('mock-small');
  });
});

describe('contract: Anthropic', () => {
  const anthropic = () =>
    provider('anthropic', {
      baseUrl: base,
      options: { allowedBetas: ['prompt-caching-2024-07-31'], betas: ['fixed-beta'] },
    });

  it('sends version, key and only allowed betas', () => {
    const up = adapterFor('anthropic').buildRequest({
      provider: anthropic(),
      model,
      apiKey: 'sk-ant',
      request: request({ inboundApi: 'anthropic.messages' }),
      clientHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31, evil-beta' },
    });
    expect(up.url).toBe(`${base}/v1/messages`);
    expect(up.headers).toMatchObject({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'fixed-beta,prompt-caching-2024-07-31',
    });
  });

  it('does not forward betas from OpenAI clients', () => {
    const up = adapterFor('anthropic').buildRequest({
      provider: provider('anthropic'),
      model,
      apiKey: 'k',
      request: request(),
      clientHeaders: { 'anthropic-beta': 'x' },
    });
    expect(up.headers).not.toHaveProperty('anthropic-beta');
  });

  it('round-trips non-stream and stream through the mock', async () => {
    const { adapter, res } = await call(anthropic(), request());
    expect(adapter.parseResponse(await res.json())).toMatchObject({ finishReason: 'stop' });
    const events = await streamEvents(anthropic(), request());
    expect(events.find((e) => e.type === 'usage')).toBeDefined();
    expect(events.find((e) => e.type === 'finish')).toMatchObject({ finishReason: 'stop' });
  });

  it('records cache tokens in usage', () => {
    const parsed = adapterFor('anthropic').parseResponse({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'c',
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    });
    expect(parsed.usage).toMatchObject({
      inputTokens: 130,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
    });
  });
});

describe('error classification against the mock', () => {
  const cases: [string, string, boolean, boolean][] = [
    ['rate_limit,retry_after=2', 'rate_limit', true, true],
    ['overloaded', 'overloaded', true, true],
    ['status=500', 'server', true, true],
    ['status=503', 'server', true, true],
    ['auth', 'auth', false, true],
    ['status=404', 'not_found', false, true],
    ['context_length', 'context_length', false, true],
    ['status=400', 'bad_request', false, false],
  ];
  it.each(cases)('%s → %s', async (directives, cls, retryable, fallback) => {
    for (const type of ['openai', 'anthropic'] as const) {
      const p = provider(type, { baseUrl: type === 'openai' ? `${base}/v1` : base });
      const { adapter, res } = await call(p, request(), `mock:${directives}`);
      const result = adapter.classifyError({
        status: res.status,
        headers: res.headers,
        body: await res.text(),
      });
      expect(result).toMatchObject({ class: cls, retryable, fallbackAllowed: fallback });
      if (cls === 'rate_limit') expect(result.retryAfterMs).toBe(2000);
      if (cls === 'auth') expect(result.credentialAction).toBe('disable');
    }
  });

  it('bad_request and content policy never fall back', () => {
    const h = new Headers();
    expect(
      classifyHttpError({
        status: 400,
        headers: h,
        body: '{"error":{"message":"invalid temperature"}}',
      }),
    ).toMatchObject({ class: 'bad_request', fallbackAllowed: false });
    expect(
      classifyHttpError({
        status: 400,
        headers: h,
        body: '{"error":{"code":"content_policy_violation","message":"x"}}',
      }),
    ).toMatchObject({ class: 'content_filter', fallbackAllowed: false });
  });

  it('insufficient_quota disables the credential', () => {
    expect(
      classifyHttpError({
        status: 429,
        headers: new Headers(),
        body: '{"error":{"type":"insufficient_quota","message":"quota"}}',
      }).credentialAction,
    ).toBe('disable');
  });

  it('parses Retry-After variants', () => {
    expect(retryAfterFrom(new Headers({ 'retry-after-ms': '1500' }))).toBe(1500);
    expect(retryAfterFrom(new Headers({ 'x-ratelimit-reset-requests': '1m30s' }))).toBe(90_000);
    expect(
      retryAfterFrom(new Headers({ 'retry-after': new Date(Date.now() + 5000).toUTCString() })),
    ).toBeGreaterThan(3000);
    expect(retryAfterFrom(new Headers())).toBeUndefined();
  });

  it('classifies network failures', () => {
    expect(classifyNetworkError(new Error('x'), true).class).toBe('timeout');
    expect(
      classifyNetworkError(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED', message: 'refused' },
        }),
        false,
      ),
    ).toMatchObject({ class: 'connection', retryable: true });
  });

  it('presetFor applies overrides on a named preset', () => {
    expect(
      presetFor(
        provider('openai-compatible', {
          options: { preset: 'groq', supportsStreamOptions: false },
        }),
      ),
    ).toMatchObject({ name: 'Groq', supportsStreamOptions: false });
  });

  it('parses model lists', async () => {
    const adapter = adapterFor('openai');
    const up = adapter.listModelsRequest(provider('openai'), 'k');
    const res = await fetch(up.url, { headers: up.headers });
    expect(adapter.parseModelList(await res.json())).toEqual([
      'mock-small',
      'mock-large',
      'mock-vision',
    ]);
  });
});
