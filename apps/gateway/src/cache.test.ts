/**
 * Exact cache (card 13.1): key isolation per project, stream assembly, and replay of a cached
 * response in the client's own stream format through a real gateway + mock provider.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CanonicalRequest,
  CanonicalStreamEvent,
  ConfigSnapshotInput,
} from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cacheKeyFor, ExactCache, isCacheable, StreamAssembler } from './cache.js';
import { buildGateway } from './server.js';

const request = (over: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  inboundApi: 'openai.chat',
  model: 'm',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  stream: false,
  ...over,
});
const exact = (over: Record<string, unknown> = {}) => ({
  exact: { enabled: true, ttlSeconds: 300, maxOutputTokens: 4_096, maxTemperature: 0.2, ...over },
});

describe('cacheKeyFor', () => {
  const scope = { organizationId: 'org', projectId: 'p1' };

  it('isolates projects and organizations for identical prompts', () => {
    const base = cacheKeyFor(scope, request(), 'm1');
    expect(cacheKeyFor(scope, request(), 'm1')).toBe(base);
    expect(cacheKeyFor({ ...scope, projectId: 'p2' }, request(), 'm1')).not.toBe(base);
    expect(cacheKeyFor({ ...scope, organizationId: 'other' }, request(), 'm1')).not.toBe(base);
    expect(cacheKeyFor(scope, request(), 'm2')).not.toBe(base);
  });

  it('shares an entry between streaming and non-streaming requests', () => {
    expect(cacheKeyFor(scope, request({ stream: true }), 'm1')).toBe(
      cacheKeyFor(scope, request({ stream: false }), 'm1'),
    );
  });

  it('changes with anything that changes the answer', () => {
    const base = cacheKeyFor(scope, request(), 'm1');
    expect(cacheKeyFor(scope, request({ temperature: 0.1 }), 'm1')).not.toBe(base);
    expect(cacheKeyFor(scope, request({ maxOutputTokens: 10 }), 'm1')).not.toBe(base);
    expect(
      cacheKeyFor(scope, request({ system: [{ type: 'text', text: 'be brief' }] }), 'm1'),
    ).not.toBe(base);
  });
});

describe('isCacheable', () => {
  it('is off unless enabled and respects temperature and output limits', () => {
    expect(isCacheable(request(), undefined)).toBe(false);
    expect(isCacheable(request(), exact({ enabled: false }))).toBe(false);
    expect(isCacheable(request(), exact())).toBe(true);
    expect(isCacheable(request({ stream: true }), exact())).toBe(true);
    expect(isCacheable(request({ temperature: 0.9 }), exact())).toBe(false);
    expect(isCacheable(request({ maxOutputTokens: 10_000 }), exact())).toBe(false);
  });
});

describe('StreamAssembler', () => {
  const run = (events: CanonicalStreamEvent[]) => {
    const assembler = new StreamAssembler();
    for (const event of events) assembler.push(event);
    return assembler.result();
  };
  const start: CanonicalStreamEvent = { type: 'start', id: 'r1', model: 'm', created: 1 };
  const finish: CanonicalStreamEvent = { type: 'finish', finishReason: 'stop' };

  it('joins text, reasoning and tool calls in index order', () => {
    const response = run([
      start,
      { type: 'reasoning_delta', index: 0, text: 'think' },
      { type: 'text_delta', index: 1, text: 'Hel' },
      { type: 'text_delta', index: 1, text: 'lo' },
      { type: 'tool_call_start', index: 2, id: 'call_1', name: 'get_weather' },
      { type: 'tool_call_delta', index: 2, argumentsDelta: '{"city":' },
      { type: 'tool_call_delta', index: 2, argumentsDelta: '"Tehran"}' },
      { type: 'content_end', index: 2 },
      {
        type: 'usage',
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      },
      { type: 'finish', finishReason: 'tool_calls' },
    ]);
    expect(response).toMatchObject({
      id: 'r1',
      model: 'm',
      finishReason: 'tool_calls',
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'Hello' },
        { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Tehran"}' },
      ],
      usage: { inputTokens: 3, outputTokens: 5 },
    });
  });

  it('refuses incomplete, failed and filtered streams', () => {
    const text: CanonicalStreamEvent = { type: 'text_delta', index: 0, text: 'x' };
    expect(run([start, text])).toBeUndefined();
    expect(run([text, finish])).toBeUndefined();
    expect(run([start, finish])).toBeUndefined();
    expect(
      run([start, text, { type: 'error', code: 'server', message: 'cut' }, finish]),
    ).toBeUndefined();
    expect(run([start, text, { type: 'finish', finishReason: 'content_filter' }])).toBeUndefined();
  });
});

describe('ExactCache', () => {
  it('expires entries and evicts the least recently used', async () => {
    let now = 0;
    const cache = new ExactCache({ maxEntries: 2, now: () => now });
    const response = (id: string) => ({
      id,
      model: 'm',
      content: [{ type: 'text' as const, text: id }],
      finishReason: 'stop' as const,
      created: 1,
    });
    await cache.set('a', response('a'), 10);
    await cache.set('b', response('b'), 10);
    expect((await cache.get('a'))?.id).toBe('a');
    await cache.set('c', response('c'), 10);
    expect(await cache.get('b')).toBeUndefined();
    expect((await cache.get('a'))?.id).toBe('a');
    now = 11_000;
    expect(await cache.get('a')).toBeUndefined();
  });
});

describe('exact cache through the gateway', () => {
  const keyring = parseKeyring(generateKey());
  const pepper = 'p'.repeat(32);
  const KEY_A = 'dr-cache-test-key-000a';
  const KEY_B = 'dr-cache-test-key-000b';
  const mock = buildMock();
  let gw: ReturnType<typeof buildGateway>;
  let base = '';

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const virtualKey = (id: string, secret: string, projectId: string) => ({
      id,
      hash: hashApiKey(secret, pepper),
      prefix: secret.slice(0, 6),
      organizationId: 'org',
      teamId: null,
      projectId,
      enabled: true,
      expiresAt: null,
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        {
          id: 'oa',
          organizationId: 'org',
          slug: 'oa',
          type: 'openai-compatible',
          name: 'oa',
          baseUrl: `${mockRoot}/v1`,
          enabled: true,
          options: {},
          credentials: [
            { id: 'oa-k', name: 'oa', secret: encrypt(keyring, 'sk-x', 'oa-k'), enabled: true },
          ],
        },
      ],
      models: [
        {
          id: 'gpt-x',
          organizationId: 'org',
          slug: 'gpt-x',
          providerId: 'oa',
          upstreamModel: 'mock-small',
          enabled: true,
          contextWindow: 100_000,
          pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
          capabilities: {},
        },
      ],
      combos: [],
      aliases: [],
      virtualKeys: [virtualKey('vk-a', KEY_A, 'project-a'), virtualKey('vk-b', KEY_B, 'project-b')],
      settings: { cache: { exact: { enabled: true, ttlSeconds: 60 } } },
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-cache-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger: createLogger({ service: 'test', level: 'silent' }),
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

  const chat = (key: string, content: string, extra: Record<string, unknown> = {}, headers = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
      body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content }], ...extra }),
    });
  /** Concatenated `delta.content` of an OpenAI SSE body. */
  const streamedText = (body: string) =>
    body
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => {
        const chunk = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] };
        return chunk.choices?.[0]?.delta?.content ?? '';
      })
      .join('');

  it('replays a cached JSON response as an OpenAI stream', async () => {
    const first = await chat(KEY_A, 'cache me once');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-dirouter-cache')).toBeNull();
    const json = (await first.json()) as { choices: { message: { content: string } }[] };

    const again = await chat(KEY_A, 'cache me once');
    expect(again.headers.get('x-dirouter-cache')).toBe('exact');
    expect(((await again.json()) as typeof json).choices[0]?.message.content).toBe(
      json.choices[0]?.message.content,
    );

    const stream = await chat(KEY_A, 'cache me once', { stream: true });
    expect(stream.headers.get('x-dirouter-cache')).toBe('exact');
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const body = await stream.text();
    expect(streamedText(body)).toBe(json.choices[0]?.message.content);
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('replays the same entry in Anthropic stream format', async () => {
    const seed = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY_A },
      body: JSON.stringify({
        model: 'gpt-x',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'anthropic cache' }],
      }),
    });
    expect(seed.status).toBe(200);
    const stream = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY_A },
      body: JSON.stringify({
        model: 'gpt-x',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'anthropic cache' }],
      }),
    });
    expect(stream.headers.get('x-dirouter-cache')).toBe('exact');
    const body = await stream.text();
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('event: message_stop');
  });

  it('a streamed response populates the cache for later requests', async () => {
    const stream = await chat(KEY_A, 'stream first', { stream: true });
    expect(stream.headers.get('x-dirouter-cache')).toBeNull();
    const text = streamedText(await stream.text());
    expect(text.length).toBeGreaterThan(0);

    const json = await chat(KEY_A, 'stream first');
    expect(json.headers.get('x-dirouter-cache')).toBe('exact');
    const body = (await json.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe(text);
  });

  it('does not leak between projects', async () => {
    expect((await chat(KEY_A, 'project secret')).headers.get('x-dirouter-cache')).toBeNull();
    expect((await chat(KEY_A, 'project secret')).headers.get('x-dirouter-cache')).toBe('exact');
    // Same organization, same prompt, different project: must go upstream.
    expect((await chat(KEY_B, 'project secret')).headers.get('x-dirouter-cache')).toBeNull();
  });

  it('honours the per-request bypass header', async () => {
    await chat(KEY_A, 'bypass me');
    const bypass = await chat(KEY_A, 'bypass me', {}, { 'x-dirouter-cache': 'bypass' });
    expect(bypass.headers.get('x-dirouter-cache')).toBeNull();
  });
});
