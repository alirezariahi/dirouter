/** Native provider pass-through routes (card 30.7). */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pathAllowed, safePath, upstreamUrl, usageFromAnswer } from './passthrough.js';
import { buildGateway } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY_OPENAI = 'dr-pass-openai-0001';
const KEY_NONE = 'dr-pass-none-00001';
const KEY_ALL = 'dr-pass-all-000001';
const KEY_WALLET = 'dr-pass-wallet-001';
const KEY_RPM = 'dr-pass-rpm-000001';
const UPSTREAM_SECRET = 'upstream-credential-value';

describe('pass-through helpers', () => {
  it('matches the allow-list by method and path, with a trailing * as prefix', () => {
    const list = ['POST /completions', '/files*', 'GET /models/'];
    expect(pathAllowed(list, 'POST', '/completions')).toBe(true);
    expect(pathAllowed(list, 'GET', '/completions')).toBe(false);
    expect(pathAllowed(list, 'DELETE', '/files/abc')).toBe(true);
    expect(pathAllowed(list, 'GET', '/models/')).toBe(true);
    expect(pathAllowed(list, 'GET', '/models/x')).toBe(false);
    expect(pathAllowed([], 'GET', '/anything')).toBe(false);
    expect(pathAllowed(['not a path'], 'GET', '/x')).toBe(false);
  });

  it('refuses paths that could climb out of the base URL', () => {
    expect(safePath('/v1/files/file-abc')).toBe(true);
    for (const bad of ['/../admin', '/a/./b', '/a//b', '/%2e%2e/x', '/a%2Fb', '/a\\b', '/a b', 'x'])
      expect(safePath(bad)).toBe(false);
    expect(upstreamUrl('https://api.example.com/v1', '/files', 'limit=2&key=dr-x')).toBe(
      'https://api.example.com/v1/files?limit=2',
    );
    expect(upstreamUrl('https://api.example.com/v1', '@evil.com/x', '')).toBeUndefined();
  });

  it('reads usage from OpenAI, Anthropic, Gemini and SSE answers', () => {
    expect(
      usageFromAnswer(
        'application/json',
        JSON.stringify({ model: 'm', usage: { prompt_tokens: 3, completion_tokens: 4 } }),
      ),
    ).toEqual({ model: 'm', usage: { inputTokens: 3, outputTokens: 4 } });
    expect(
      usageFromAnswer(
        'application/json',
        JSON.stringify({
          model: 'claude',
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
        }),
      ).usage,
    ).toEqual({ inputTokens: 15, outputTokens: 2, cacheReadTokens: 5 });
    expect(
      usageFromAnswer(
        'application/json',
        JSON.stringify({
          modelVersion: 'gemini-x',
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, thoughtsTokenCount: 2 },
        }),
      ),
    ).toEqual({
      model: 'gemini-x',
      usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 2 },
    });
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude', usage: { input_tokens: 9, output_tokens: 1 } } })}`,
      '',
      `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 6 } })}`,
      '',
      'data: [DONE]',
    ].join('\n');
    expect(usageFromAnswer('text/event-stream', sse)).toEqual({
      model: 'claude',
      usage: { inputTokens: 9, outputTokens: 6 },
    });
    expect(usageFromAnswer('application/octet-stream', 'binary')).toEqual({ usage: {} });
  });
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

describe('pass-through routes', () => {
  const mock = buildMock();
  const usage: UsageEvent[] = [];
  const seen: Seen[] = [];
  let echo: Server;
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  let mockRoot = '';

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    echo = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (req.url?.startsWith('/base/stream')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({ model: 'echo-model', choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ model: 'echo-model', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } })}\n\n`,
          );
          res.end('data: [DONE]\n\n');
          return;
        }
        if (req.url?.startsWith('/base/fail')) {
          res.writeHead(418, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'teapot' } }));
          return;
        }
        if (req.url?.startsWith('/base/leak')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ note: 'the code is SECRET-42' }));
          return;
        }
        res.writeHead(201, {
          'content-type': 'application/json',
          'set-cookie': 'session=upstream',
          'x-ratelimit-remaining-requests': '99',
        });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const ea = echo.address();
    const echoRoot = `http://127.0.0.1:${String(typeof ea === 'object' && ea ? ea.port : 0)}`;

    const keyring = parseKeyring(generateKey());
    const credential = (id: string, headers: Record<string, string> = {}) => ({
      id,
      name: id,
      secret: encrypt(keyring, UPSTREAM_SECRET, id),
      enabled: true,
      headers,
    });
    const key = (raw: string, id: string, extra: Record<string, unknown> = {}) => ({
      id,
      hash: hashApiKey(raw, pepper),
      prefix: id,
      organizationId: 'org',
      teamId: null,
      projectId: 'prj',
      enabled: true,
      expiresAt: null,
      allowedModels: [],
      ...extra,
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        {
          id: 'p-openai',
          organizationId: 'org',
          slug: 'openai',
          type: 'openai',
          name: 'OpenAI',
          baseUrl: `${mockRoot}/v1`,
          enabled: true,
          options: { passthroughPaths: ['POST /completions'] },
          credentials: [credential('c-openai')],
        },
        {
          id: 'p-echo',
          organizationId: 'org',
          slug: 'echo',
          type: 'openai-compatible',
          name: 'Echo',
          baseUrl: `${echoRoot}/base`,
          enabled: true,
          options: { passthroughPaths: ['/things*', 'GET /stream', '/fail', '/leak'] },
          credentials: [credential('c-echo', { 'x-cred': 'c1' })],
        },
        {
          id: 'p-anth',
          organizationId: 'org',
          slug: 'anth',
          type: 'anthropic',
          name: 'Anthropic',
          baseUrl: echoRoot,
          enabled: true,
          options: { passthroughPaths: ['/v1/messages/batches*'] },
          credentials: [credential('c-anth')],
        },
        {
          id: 'p-other-org',
          organizationId: 'other',
          slug: 'foreign',
          type: 'openai',
          name: 'Foreign',
          baseUrl: echoRoot,
          enabled: true,
          options: { passthroughPaths: ['/*'] },
          credentials: [credential('c-foreign')],
        },
        {
          id: 'p-bedrock',
          organizationId: 'org',
          slug: 'bed',
          type: 'bedrock',
          name: 'Bedrock',
          baseUrl: echoRoot,
          enabled: true,
          options: { passthroughPaths: ['/*'] },
          credentials: [credential('c-bed')],
        },
      ],
      models: [
        {
          id: 'm-instruct',
          organizationId: 'org',
          slug: 'instruct',
          providerId: 'p-openai',
          upstreamModel: 'gpt-3.5-turbo-instruct',
          enabled: true,
          pricing: { inputPerMTok: '1.5', outputPerMTok: '2' },
          capabilities: {
            streaming: true,
            tools: false,
            vision: false,
            reasoning: false,
            jsonMode: false,
            embeddings: false,
          },
        },
        {
          id: 'm-echo',
          organizationId: 'org',
          slug: 'echo-model',
          providerId: 'p-echo',
          upstreamModel: 'echo-model',
          enabled: true,
          pricing: { inputPerMTok: '1', outputPerMTok: '2' },
          capabilities: {
            streaming: true,
            tools: false,
            vision: false,
            reasoning: false,
            jsonMode: false,
            embeddings: false,
          },
        },
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        key(KEY_OPENAI, 'vk-openai', { passthroughProviders: ['openai'] }),
        key(KEY_NONE, 'vk-none'),
        key(KEY_ALL, 'vk-all', { passthroughProviders: ['*'] }),
        key(KEY_WALLET, 'vk-wallet', { passthroughProviders: ['*'], walletId: 'w1' }),
        key(KEY_RPM, 'vk-rpm', {
          passthroughProviders: ['*'],
          rateLimit: { requestsPerMinute: 1 },
        }),
      ],
      guardrails: [
        {
          id: 'g-block',
          organizationId: 'org',
          virtualKeyId: 'vk-all',
          name: 'no forbidden',
          enabled: true,
          stage: 'both',
          type: 'regex',
          config: { pattern: 'forbidden' },
          action: 'block',
        },
        {
          id: 'g-redact',
          organizationId: 'org',
          virtualKeyId: 'vk-all',
          name: 'secret codes',
          enabled: true,
          stage: 'both',
          type: 'regex',
          config: { pattern: 'SECRET-\\d+' },
          action: 'redact',
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-passthrough-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({ logger, keyring, pepper, dataDir, emitUsage: (e) => usage.push(e) });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  });
  afterAll(async () => {
    await gw.app.close();
    await mock.close();
    await new Promise((resolve) => echo.close(resolve));
  });
  beforeEach(() => {
    usage.length = 0;
    seen.length = 0;
  });

  const call = (key: string, method: string, path: string, body?: unknown, headers = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const lastEvent = async () => {
    for (let i = 0; i < 50 && usage.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return usage.at(-1);
  };

  it('serves an untranslated endpoint (legacy completions), prices its usage and logs it', async () => {
    await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
    const res = await call(KEY_OPENAI, 'POST', '/passthrough/openai/completions', {
      model: 'gpt-3.5-turbo-instruct',
      prompt: 'Say hello',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-provider')).toBe('openai');
    const body = (await res.json()) as {
      object: string;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(body.object).toBe('text_completion');
    const event = await lastEvent();
    expect(event).toMatchObject({
      inboundApi: 'passthrough',
      requestedModel: 'gpt-3.5-turbo-instruct',
      resolvedModelId: 'm-instruct',
      providerId: 'p-openai',
      credentialId: 'c-openai',
      virtualKeyId: 'vk-openai',
      status: 'success',
      httpStatus: 200,
      usage: {
        inputTokens: body.usage.prompt_tokens,
        outputTokens: body.usage.completion_tokens,
      },
    });
    const expected =
      (body.usage.prompt_tokens * 1.5 + body.usage.completion_tokens * 2) / 1_000_000;
    expect(Number(event?.costUsd)).toBeCloseTo(expected, 8);
    // The provider saw the credential, never the client's DiRouter key.
    const stats = (await (await fetch(`${mockRoot}/__mock/stats`)).json()) as {
      byKey: Record<string, number>;
    };
    expect(Object.keys(stats.byKey)).toEqual([`Bearer ${UPSTREAM_SECRET}`]);
  });

  it('refuses a key without the pass-through grant, and another organization', async () => {
    const none = await call(KEY_NONE, 'POST', '/passthrough/openai/completions', { prompt: 'x' });
    expect(none.status).toBe(403);
    expect(((await none.json()) as { error: { message: string } }).error.message).toMatch(
      /may not use pass-through/,
    );
    // A grant for another provider does not cover this one.
    const other = await call(KEY_OPENAI, 'POST', '/passthrough/echo/things', {});
    expect(other.status).toBe(403);
    const foreign = await call(KEY_ALL, 'GET', '/passthrough/foreign/x');
    expect(foreign.status).toBe(404);
    const unauth = await fetch(`${base}/passthrough/openai/completions`, { method: 'POST' });
    expect(unauth.status).toBe(401);
    expect(seen).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it('refuses a path outside the allow-list and paths that try to escape', async () => {
    const outside = await call(KEY_OPENAI, 'POST', '/passthrough/openai/chat/completions', {});
    expect(outside.status).toBe(403);
    expect(((await outside.json()) as { error: { message: string } }).error.message).toMatch(
      /allow-list/,
    );
    // Method restriction: only POST /completions is listed.
    expect((await call(KEY_OPENAI, 'GET', '/passthrough/openai/completions')).status).toBe(403);
    expect((await call(KEY_ALL, 'GET', '/passthrough/echo/things/a%2F..%2Fadmin')).status).toBe(
      400,
    );
    expect((await call(KEY_ALL, 'GET', '/passthrough/bed/x')).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('injects the credential and forwards only safe headers both ways', async () => {
    const res = await call(
      KEY_ALL,
      'POST',
      '/passthrough/echo/things/42?limit=3&key=dr-should-not-leak',
      { name: 'x' },
      {
        'x-api-key': KEY_ALL,
        cookie: 'sid=1',
        'openai-beta': 'assistants=v2',
        'x-dirouter-session': 's1',
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-ratelimit-remaining-requests')).toBe('99');
    const got = seen[0];
    expect(got?.url).toBe('/base/things/42?limit=3');
    expect(got?.headers.authorization).toBe(`Bearer ${UPSTREAM_SECRET}`);
    expect(got?.headers['x-cred']).toBe('c1');
    expect(got?.headers['openai-beta']).toBe('assistants=v2');
    expect(got?.headers['x-api-key']).toBeUndefined();
    expect(got?.headers.cookie).toBeUndefined();
    expect(got?.headers['x-dirouter-session']).toBeUndefined();
    expect(JSON.stringify(got?.headers)).not.toContain('dr-pass');
    expect(JSON.parse(got?.body ?? '{}')).toEqual({ name: 'x' });
    const event = await lastEvent();
    expect(event).toMatchObject({
      requestedModel: 'echo/things/42',
      costUsd: '0',
      status: 'success',
    });
  });

  it('uses the Anthropic credential headers and keeps the client anthropic-beta', async () => {
    const res = await call(
      KEY_ALL,
      'POST',
      '/passthrough/anth/v1/messages/batches',
      { requests: [] },
      { 'anthropic-beta': 'message-batches-2024-09-24' },
    );
    expect(res.status).toBe(201);
    expect(seen[0]?.headers['x-api-key']).toBe(UPSTREAM_SECRET);
    expect(seen[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen[0]?.headers['anthropic-beta']).toBe('message-batches-2024-09-24');
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it('streams an SSE answer through and prices the usage it reports', async () => {
    const res = await call(KEY_ALL, 'GET', '/passthrough/echo/stream', undefined, {
      accept: 'text/event-stream',
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: [DONE]');
    const event = await lastEvent();
    expect(event).toMatchObject({
      stream: true,
      resolvedModelId: 'm-echo',
      usage: { inputTokens: 1000, outputTokens: 500 },
      costUsd: '0.00200000',
    });
  });

  it('records an upstream error with its status', async () => {
    const res = await call(KEY_ALL, 'POST', '/passthrough/echo/fail', {});
    expect(res.status).toBe(418);
    const event = await lastEvent();
    expect(event).toMatchObject({ status: 'error', httpStatus: 418, errorCode: 'http_418' });
  });

  it('applies request guardrails (block and redact) and response guardrails on JSON', async () => {
    const blocked = await call(KEY_ALL, 'POST', '/passthrough/echo/things', {
      input: 'this is forbidden',
    });
    expect(blocked.status).toBe(400);
    expect(seen).toHaveLength(0);
    const redacted = await call(KEY_ALL, 'POST', '/passthrough/echo/things', {
      input: { text: 'my code is SECRET-123' },
      model: 'SECRET-1',
    });
    expect(redacted.status).toBe(201);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      input: { text: 'my code is [REDACTED]' },
      model: 'SECRET-1',
    });
    const answer = await call(KEY_ALL, 'POST', '/passthrough/echo/leak', {});
    expect(await answer.json()).toEqual({ note: 'the code is [REDACTED]' });
  });

  it('keeps rate limits and refuses prepaid keys', async () => {
    expect((await call(KEY_RPM, 'POST', '/passthrough/echo/things', {})).status).toBe(201);
    const limited = await call(KEY_RPM, 'POST', '/passthrough/echo/things', {});
    expect(limited.status).toBe(429);
    const wallet = await call(KEY_WALLET, 'POST', '/passthrough/echo/things', {});
    expect(wallet.status).toBe(403);
    expect(seen).toHaveLength(1);
  });
});
