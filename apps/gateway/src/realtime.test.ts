/**
 * Realtime API over WebSocket (card 30.5): the official SDK through DiRouter, metering split into
 * audio and text, client secrets, fallback before the session, limits, a clean close on client
 * disconnect, session expiry and drain. Budget and wallet exhaustion run with
 * INTEGRATION_VALKEY_URL.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';

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
import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { realtimeUsage } from './realtime.js';
import { issueClientSecret, verifyClientSecret } from './realtime-secrets.js';
import { buildGateway, type GatewayOptions } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const keyring = parseKeyring(generateKey());
const KEY = 'dr-realtime-key-0001';
const ONE_KEY = 'dr-realtime-key-one1';
const BUDGET_KEY = 'dr-realtime-key-bud1';
const WALLET_KEY = 'dr-realtime-key-wal1';
const ZDR_KEY = 'dr-realtime-key-zdr1';
const MODEL_BUDGET_KEY = 'dr-realtime-key-mbu1';
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
/** One second of PCM16 at 24 kHz: 10 audio tokens at the mock. */
const SECOND_OF_AUDIO = Buffer.alloc(48_000).toString('base64');

const mock = buildMock();
let mockRoot = '';
const dirs: string[] = [];

const mockStats = async () =>
  (
    (await (await fetch(`${mockRoot}/__mock/stats`)).json()) as {
      realtime: {
        sessions: number;
        open: number;
        events: string[];
        lastModel?: string;
        lastAuthorization?: string;
        lastBeta?: boolean;
        cutMidResponse: number;
      };
    }
  ).realtime;

function snapshot(walletId?: string): ConfigSnapshotInput {
  const provider = (id: string, secret: string, extra = {}) => ({
    id,
    organizationId: 'org',
    slug: id,
    type: 'openai' as const,
    name: id,
    baseUrl: `${mockRoot}/v1`,
    enabled: true,
    options: {},
    ...extra,
    credentials: [
      { id: `${id}-k`, name: id, secret: encrypt(keyring, secret, `${id}-k`), enabled: true },
    ],
  });
  const model = (id: string, providerId: string, capabilities: Record<string, boolean>) => ({
    id,
    organizationId: 'org',
    slug: id,
    providerId,
    upstreamModel: `${id}-upstream`,
    enabled: true,
    pricing: {
      inputPerMTok: '4',
      outputPerMTok: '16',
      cacheReadPerMTok: '0.4',
      audioInputPerMTok: '32',
      audioOutputPerMTok: '64',
    },
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      jsonMode: false,
      embeddings: false,
      ...capabilities,
    },
  });
  const key = (raw: string, id: string, extra = {}) => ({
    id,
    hash: hashApiKey(raw, pepper),
    prefix: id,
    organizationId: 'org',
    teamId: null,
    projectId: 'prj',
    enabled: true,
    expiresAt: null,
    allowedModels: [],
    ipAllowlist: [],
    budgets: [],
    mcpTools: [],
    ...extra,
  });
  return {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      provider('up', 'sk-upstream'),
      provider('down', 'mock:status=503'),
      provider('slow', 'mock:chunks=12,chunk_delay=60'),
      provider('zdr', 'sk-upstream', { dataPolicy: { region: 'eu', zdr: true } }),
    ],
    models: [
      model('rt', 'up', { realtime: true }),
      model('rt-down', 'down', { realtime: true }),
      model('rt-slow', 'slow', { realtime: true }),
      model('chat', 'up', {}),
      model('rt-zdr', 'zdr', { realtime: true }),
      model('rt-capped', 'up', { realtime: true }),
      model('rt-model-budget', 'up', { realtime: true }),
    ],
    combos: [
      {
        id: 'rt-combo',
        organizationId: 'org',
        slug: 'rt-combo',
        strategy: 'priority' as const,
        targets: [
          { modelId: 'rt-down', order: 0 },
          { modelId: 'rt', order: 1 },
        ],
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 },
      },
    ],
    aliases: [],
    virtualKeys: [
      key(KEY, 'vk'),
      key(ONE_KEY, 'vk-one', { rateLimit: { maxConcurrency: 1 } }),
      key(BUDGET_KEY, 'vk-budget', {
        budgets: [{ id: `b-${randomUUID()}`, period: 'daily', limitUsd: '0.001' }],
      }),
      key(WALLET_KEY, 'vk-wallet', walletId ? { walletId } : {}),
      key(ZDR_KEY, 'vk-zdr'),
      key(MODEL_BUDGET_KEY, 'vk-model-budget'),
    ],
    // A "ZDR only" key (card 32.5), and limits beyond the key's own (cards 32.6, 33.1 to 33.4).
    routingPolicies: [
      { organizationId: 'org', scope: 'key', scopeId: 'vk-zdr', dataPolicy: { requireZdr: true } },
    ],
    limits: [
      { organizationId: 'org', scope: 'end_user', scopeId: 'banned', blocked: true, budgets: [] },
      {
        organizationId: 'org',
        scope: 'model',
        scopeId: 'rt-capped',
        rateLimit: { requestsPerMinute: 1 },
        budgets: [],
      },
      {
        organizationId: 'org',
        scope: 'tag',
        scopeId: 'rt-tag',
        rateLimit: { requestsPerMinute: 1 },
        budgets: [],
      },
      {
        organizationId: 'org',
        scope: 'model',
        scopeId: 'rt-model-budget',
        budgets: [{ id: `mb-${randomUUID()}`, period: 'daily', limitUsd: '0.001' }],
      },
    ],
    settings: {},
  };
}

async function startGateway(options: Partial<GatewayOptions> = {}, walletId?: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-realtime-'));
  dirs.push(dataDir);
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot(walletId)));
  const usage: UsageEvent[] = [];
  const gw = buildGateway({
    logger,
    keyring,
    pepper,
    dataDir,
    emitUsage: (e) => usage.push(e),
    ...options,
  });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const address = gw.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    gw,
    usage,
    port,
    ws: `ws://127.0.0.1:${String(port)}`,
    http: `http://127.0.0.1:${String(port)}`,
  };
}

/** Collects every server event of a raw socket and resolves helpers on them. */
function client(url: string, options: { headers?: Record<string, string>; protocols?: string[] }) {
  const socket = new WebSocket(url, options.protocols ?? [], {
    ...(options.headers ? { headers: options.headers } : {}),
  });
  const events: Record<string, unknown>[] = [];
  const waiters: {
    match: (e: Record<string, unknown>) => boolean;
    resolve: (e: Record<string, unknown>) => void;
  }[] = [];
  socket.on('message', (data) => {
    const event = JSON.parse((data as Buffer).toString()) as Record<string, unknown>;
    events.push(event);
    for (const w of [...waiters])
      if (w.match(event)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(event);
      }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
  const status = new Promise<number>((resolve) => {
    socket.on('open', () => {
      resolve(101);
    });
    socket.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    // Refused before any HTTP answer (the server stopped listening).
    socket.on('error', () => {
      resolve(0);
    });
  });
  const next = (type: string, timeoutMs = 5_000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const found = events.find((e) => e.type === type);
      if (found) {
        events.splice(events.indexOf(found), 1);
        resolve(found);
        return;
      }
      const timer = setTimeout(() => {
        reject(
          new Error(
            `no ${type} within ${String(timeoutMs)} ms; got ${events.map((e) => String(e.type)).join(', ')}`,
          ),
        );
      }, timeoutMs);
      waiters.push({
        match: (e) => e.type === type,
        resolve: (e) => {
          clearTimeout(timer);
          events.splice(events.indexOf(e), 1);
          resolve(e);
        },
      });
    });
  const send = (event: Record<string, unknown>) => {
    socket.send(JSON.stringify(event));
  };
  return { socket, events, closed, status, next, send };
}

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const address = mock.server.address();
  mockRoot = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
});
afterAll(async () => {
  await mock.close();
});

describe('realtime usage and client secrets', () => {
  it('splits response.done usage into text tokens and audio tokens', () => {
    expect(
      realtimeUsage({
        total_tokens: 400,
        input_tokens: 300,
        output_tokens: 100,
        input_token_details: {
          text_tokens: 100,
          audio_tokens: 180,
          image_tokens: 20,
          cached_tokens: 150,
          cached_tokens_details: { text_tokens: 50, audio_tokens: 100, image_tokens: 0 },
        },
        output_token_details: { text_tokens: 30, audio_tokens: 70 },
      }),
    ).toEqual({
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      media: { audioInputTokens: 180, audioOutputTokens: 70, audioCachedTokens: 100 },
      estimated: false,
    });
    // No details: every token is text; no usage at all is flagged.
    expect(realtimeUsage({ input_tokens: 5, output_tokens: 7 }).usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
    });
    expect(realtimeUsage(undefined).estimated).toBe(true);
  });

  it('client secrets are signed, bound to the key and expire', () => {
    const now = Date.now();
    const secret = issueClientSecret(
      { keyId: 'vk', organizationId: 'org', model: 'rt', expiresAt: Math.floor(now / 1000) + 60 },
      pepper,
    );
    expect(secret).toMatch(/^ek_dr_/);
    expect(secret).not.toContain(KEY);
    expect(verifyClientSecret(secret, pepper, now)).toMatchObject({ keyId: 'vk', model: 'rt' });
    expect(verifyClientSecret(secret, 'q'.repeat(32), now)).toBeUndefined();
    expect(verifyClientSecret(`${secret.slice(0, -2)}xx`, pepper, now)).toBeUndefined();
    expect(verifyClientSecret(secret, pepper, now + 61_000)).toBeUndefined();
    expect(verifyClientSecret('ek_dr_bm90IGpzb24.c2ln', pepper, now)).toBeUndefined();
  });
});

describe('realtime sessions', () => {
  let rt: Awaited<ReturnType<typeof startGateway>>;
  let tls: TlsServer;
  let tlsPort = 0;
  let cert = '';

  beforeAll(async () => {
    rt = await startGateway();
    // The SDK always connects with wss:, so a TLS terminator sits in front of the gateway, the way
    // Traefik does in production.
    const dir = await mkdtemp(join(tmpdir(), 'dirouter-realtime-tls-'));
    dirs.push(dir);
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    cert = await readFile(join(dir, 'cert.pem'), 'utf8');
    tls = createTlsServer({ key: await readFile(join(dir, 'key.pem')), cert }, (socket) => {
      const upstream = netConnect(rt.port, '127.0.0.1');
      socket.pipe(upstream).pipe(socket);
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
    });
    await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
    const address = tls.address();
    tlsPort = typeof address === 'object' && address ? address.port : 0;
  });
  afterAll(async () => {
    tls.close();
    await rt.gw.app.close();
  });

  it('the official SDK opens a session through DiRouter; each response is metered as audio and text', async () => {
    await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
    const sdk = new OpenAI({ apiKey: KEY, baseURL: `https://localhost:${String(tlsPort)}/v1` });
    const session = new OpenAIRealtimeWS({ model: 'rt', options: { ca: cert } }, sdk);
    const errors: Error[] = [];
    session.on('error', (error) => errors.push(error));
    const seen: string[] = [];
    session.on('event', (event) => seen.push(event.type));
    const created = await new Promise<{ session: { model?: string } }>((resolve) => {
      session.on('session.created', (event) => {
        resolve(event as unknown as { session: { model?: string } });
      });
    });
    // The client sees DiRouter's model name; the provider got its own name and DiRouter's credential.
    expect(created.session.model).toBe('rt');
    const upstream = await mockStats();
    expect(upstream.lastModel).toBe('rt-upstream');
    expect(upstream.lastAuthorization).toBe('Bearer sk-upstream');
    expect(upstream.lastBeta).toBe(false);

    const updated = new Promise((resolve) => session.on('session.updated', resolve));
    session.send({
      type: 'session.update',
      session: { type: 'realtime', instructions: 'Be brief.' },
    });
    await updated;
    session.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello there' }],
      },
    });
    session.send({ type: 'input_audio_buffer.append', audio: SECOND_OF_AUDIO });
    session.send({ type: 'input_audio_buffer.commit' });
    const done = new Promise<{ response: { status: string; usage?: unknown } }>((resolve) => {
      session.on('response.done', (event) => {
        resolve(event as unknown as { response: { status: string } });
      });
    });
    session.send({ type: 'response.create' });
    expect((await done).response.status).toBe('completed');
    expect(seen).toContain('response.output_audio.delta');
    expect(seen).toContain('response.output_audio_transcript.delta');

    await expect.poll(() => rt.usage.length).toBe(1);
    // Text: 3 in × $4/M + 10 out × $16/M; audio: 10 in × $32/M + 10 out × $64/M.
    expect(rt.usage[0]).toMatchObject({
      inboundApi: 'openai.realtime',
      requestedModel: 'rt',
      resolvedModelId: 'rt',
      stream: true,
      status: 'success',
      usage: { inputTokens: 3, outputTokens: 10 },
      media: {
        audioInputTokens: 10,
        audioOutputTokens: 10,
        textCostUsd: '0.00017200',
        audioCostUsd: '0.00096000',
      },
      costUsd: '0.00113200',
      chargeUsd: '0.00113200',
    });
    const sessionId = rt.usage[0]?.media?.sessionId;
    expect(rt.usage[0]?.requestId).toBe(`${String(sessionId)}_1`);

    // A second response is a second event of the same session.
    const second = new Promise((resolve) => session.on('response.done', resolve));
    session.send({ type: 'response.create' });
    await second;
    await expect.poll(() => rt.usage.length).toBe(2);
    expect(rt.usage[1]?.media?.sessionId).toBe(sessionId);
    expect(rt.usage[1]?.requestId).toBe(`${String(sessionId)}_2`);

    session.close();
    await expect.poll(() => rt.gw.realtime.size).toBe(0);
    expect(errors).toEqual([]);
  });

  it('a browser opens a session with a client secret in the subprotocol; the secret carries the session', async () => {
    await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
    const res = await fetch(`${rt.http}/v1/realtime/client_secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 120 },
        session: { type: 'realtime', model: 'rt', instructions: 'Answer in Persian.' },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      value: string;
      expires_at: number;
      session: { model: string; instructions: string };
    };
    expect(body.value).toMatch(/^ek_/);
    expect(body.expires_at).toBeGreaterThan(Date.now() / 1000 + 100);
    expect(body.session).toMatchObject({ model: 'rt', instructions: 'Answer in Persian.' });

    const browser = client(`${rt.ws}/v1/realtime?model=rt`, {
      protocols: ['realtime', `openai-insecure-api-key.${body.value}`],
    });
    expect(await browser.status).toBe(101);
    // The key is never echoed back as the chosen subprotocol.
    expect(browser.socket.protocol).toBe('realtime');
    await browser.next('session.created');
    const updated = await browser.next('session.updated');
    expect(updated.session).toMatchObject({ instructions: 'Answer in Persian.', model: 'rt' });
    expect((await mockStats()).events[0]).toBe('session.update');
    browser.socket.close();
    await browser.closed;

    // The model is taken from the secret when the URL has none; another model is refused.
    const bound = client(`${rt.ws}/v1/realtime`, {
      protocols: ['realtime', `openai-insecure-api-key.${body.value}`],
    });
    expect(await bound.status).toBe(101);
    bound.socket.close();
    const other = client(`${rt.ws}/v1/realtime?model=rt-slow`, {
      protocols: ['realtime', `openai-insecure-api-key.${body.value}`],
    });
    expect(await other.status).toBe(400);

    // A forged secret, or a secret used to mint another one, is refused.
    const forged = client(`${rt.ws}/v1/realtime?model=rt`, {
      protocols: ['realtime', `openai-insecure-api-key.${body.value.slice(0, -3)}abc`],
    });
    expect(await forged.status).toBe(401);
    const remint = await fetch(`${rt.http}/v1/realtime/client_secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${body.value}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(remint.status).toBe(401);
    const badTtl = await fetch(`${rt.http}/v1/realtime/client_secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expires_after: { seconds: 5 } }),
    });
    expect(badTtl.status).toBe(422);
    const notRealtime = await fetch(`${rt.http}/v1/realtime/client_secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session: { model: 'chat' } }),
    });
    expect(notRealtime.status).toBe(400);
  });

  it('the beta protocol: /v1/realtime/sessions and the OpenAI-Beta header reach the provider', async () => {
    await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
    const res = await fetch(`${rt.http}/v1/realtime/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'rt', modalities: ['text'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      model: string;
      client_secret: { value: string; expires_at: number };
    };
    expect(body).toMatchObject({ object: 'realtime.session', model: 'rt' });
    const browser = client(`${rt.ws}/v1/realtime?model=rt`, {
      protocols: [
        'realtime',
        `openai-insecure-api-key.${body.client_secret.value}`,
        'openai-beta.realtime-v1',
      ],
    });
    expect(await browser.status).toBe(101);
    await browser.next('session.created');
    await browser.next('session.updated');
    expect((await mockStats()).lastBeta).toBe(true);
    browser.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
    });
    await browser.next('conversation.item.created');
    browser.send({ type: 'response.create' });
    await browser.next('response.text.delta');
    await browser.next('response.done');
    browser.socket.close();
    await browser.closed;
  });

  it('refuses the handshake with an HTTP status, like OpenAI', async () => {
    const statusOf = async (path: string, headers: Record<string, string> = {}) =>
      client(`${rt.ws}${path}`, { headers }).status;
    const auth = { authorization: `Bearer ${KEY}` };
    expect(await statusOf('/v1/realtime?model=rt')).toBe(401);
    expect(await statusOf('/v1/realtime?model=rt', { authorization: 'Bearer wrong-key' })).toBe(
      401,
    );
    expect(await statusOf('/v1/realtime', auth)).toBe(400);
    expect(await statusOf('/v1/realtime?model=chat', auth)).toBe(400);
    expect(await statusOf('/v1/realtime?model=nope', auth)).toBe(404);
    expect(await statusOf('/v1/elsewhere?model=rt', auth)).toBe(404);
    // Every target failing before the session: 503 from the provider, nothing billed.
    const before = rt.usage.length;
    expect(await statusOf('/v1/realtime?model=rt-down', auth)).toBe(502);
    await expect.poll(() => rt.usage.length).toBe(before + 1);
    expect(rt.usage.at(-1)).toMatchObject({ status: 'error', costUsd: '0', httpStatus: 502 });
  });

  it('keeps the data policy: a ZDR-only key never reaches a provider without ZDR', async () => {
    const zdr = { authorization: `Bearer ${ZDR_KEY}` };
    await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
    const refused = client(`${rt.ws}/v1/realtime?model=rt`, { headers: zdr });
    expect(await refused.status).toBe(400);
    expect((await mockStats()).sessions).toBe(0);
    // A client secret cannot be minted for it either.
    const secret = await fetch(`${rt.http}/v1/realtime/client_secrets`, {
      method: 'POST',
      headers: { ...zdr, 'content-type': 'application/json' },
      body: JSON.stringify({ session: { type: 'realtime', model: 'rt' } }),
    });
    expect(secret.status).toBe(400);
    expect(((await secret.json()) as { error: { code: string } }).error.code).toBe(
      'no_provider_matches_data_policy',
    );
    // A compliant provider serves it.
    const ok = client(`${rt.ws}/v1/realtime?model=rt-zdr`, { headers: zdr });
    expect(await ok.status).toBe(101);
    await ok.next('session.created');
    ok.socket.close();
    await ok.closed;
  });

  it('admits a session like any request: end-user block, model and tag limits', async () => {
    const auth = { authorization: `Bearer ${KEY}` };
    const statusOf = async (model: string, headers: Record<string, string> = {}) => {
      const session = client(`${rt.ws}/v1/realtime?model=${model}`, {
        headers: { ...auth, ...headers },
      });
      const status = await session.status;
      if (status === 101) {
        session.socket.close();
        await session.closed;
      }
      return status;
    };
    expect(await statusOf('rt', { 'x-dirouter-end-user': 'banned' })).toBe(403);
    // The organization's rate limit on one model (card 33.1).
    expect(await statusOf('rt-capped')).toBe(101);
    expect(await statusOf('rt-capped')).toBe(429);
    // A tag's rate limit (card 33.4).
    expect(await statusOf('rt', { 'x-dirouter-tags': 'rt-tag' })).toBe(101);
    expect(await statusOf('rt', { 'x-dirouter-tags': 'rt-tag' })).toBe(429);
    expect(await statusOf('rt')).toBe(101);
  });

  it('falls back to the next target only before the session is established', async () => {
    const before = rt.usage.length;
    const session = client(`${rt.ws}/v1/realtime?model=rt-combo`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(await session.status).toBe(101);
    await session.next('session.created');
    session.send({ type: 'response.create' });
    await session.next('response.done');
    await expect.poll(() => rt.usage.length).toBe(before + 1);
    const event = rt.usage.at(-1);
    expect(event).toMatchObject({ requestedModel: 'rt-combo', resolvedModelId: 'rt' });
    expect(event?.attempts.map((a) => [a.modelId, a.outcome])).toEqual([
      ['rt-down', 'error'],
      ['rt', 'success'],
    ]);
    session.socket.close();
    await session.closed;
  });

  it("holds a slot of the key's concurrency cap for the whole session", async () => {
    const first = client(`${rt.ws}/v1/realtime?model=rt`, {
      headers: { authorization: `Bearer ${ONE_KEY}` },
    });
    expect(await first.status).toBe(101);
    const second = client(`${rt.ws}/v1/realtime?model=rt`, {
      headers: { authorization: `Bearer ${ONE_KEY}` },
    });
    expect(await second.status).toBe(429);
    first.socket.close();
    await first.closed;
    await expect.poll(() => rt.gw.realtime.size).toBe(0);
    const third = client(`${rt.ws}/v1/realtime?model=rt`, {
      headers: { authorization: `Bearer ${ONE_KEY}` },
    });
    expect(await third.status).toBe(101);
    third.socket.close();
    await third.closed;
  });

  it('a client that leaves mid-response: the response is cancelled upstream and still billed', async () => {
    await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
    const before = rt.usage.length;
    const session = client(`${rt.ws}/v1/realtime?model=rt-slow`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(await session.status).toBe(101);
    await session.next('session.created');
    session.send({ type: 'response.create' });
    await session.next('response.output_audio.delta');
    session.socket.close();
    await expect.poll(() => rt.gw.realtime.size).toBe(0);
    const upstream = await mockStats();
    expect(upstream.events).toContain('response.cancel');
    // The provider finished the response as cancelled before its socket closed: no cut.
    expect(upstream.cutMidResponse).toBe(0);
    expect(upstream.open).toBe(0);
    await expect.poll(() => rt.usage.length).toBe(before + 1);
    const event = rt.usage.at(-1);
    expect(event?.media?.audioOutputTokens).toBeGreaterThan(0);
    expect(event?.media?.audioOutputTokens).toBeLessThan(24);
  });
});

describe('realtime session limits and drain', () => {
  it('a session that reaches its maximum length is closed with a clear error', async () => {
    const short = await startGateway({ realtime: { maxSessionSeconds: 1, closeGraceMs: 500 } });
    try {
      const session = client(`${short.ws}/v1/realtime?model=rt`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(await session.status).toBe(101);
      const error = await session.next('error', 4_000);
      expect(error.error).toMatchObject({ code: 'session_expired' });
      expect(await session.closed).toMatchObject({ code: 1000, reason: 'session expired' });
    } finally {
      await short.gw.app.close();
    }
  });

  it('refuses sessions beyond the per-replica cap', async () => {
    const capped = await startGateway({ realtime: { maxSessions: 1 } });
    try {
      const first = client(`${capped.ws}/v1/realtime?model=rt`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(await first.status).toBe(101);
      const second = client(`${capped.ws}/v1/realtime?model=rt`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(await second.status).toBe(503);
      first.socket.close();
      await first.closed;
    } finally {
      await capped.gw.app.close();
    }
  });

  it(
    'drain does not cut an open session: its response finishes, is billed, then a close frame',
    { timeout: 15_000 },
    async () => {
      await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
      const draining = await startGateway({ realtime: { closeGraceMs: 2_000 } });
      const session = client(`${draining.ws}/v1/realtime?model=rt-slow`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(await session.status).toBe(101);
      await session.next('session.created');
      session.send({ type: 'response.create' });
      await session.next('response.output_audio.delta');

      // The session outlives the 200 ms drain window while its 12-delta response is still running.
      const drained = draining.gw.drain({ readyDelayMs: 0, drainMs: 200 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const late = client(`${draining.ws}/v1/realtime?model=rt`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect([503, 0]).toContain(await late.status);

      const done = await session.next('response.done', 5_000);
      expect(done.response).toMatchObject({ status: 'completed' });
      const error = await session.next('error', 5_000);
      expect(error.error).toMatchObject({ code: 'gateway_shutting_down' });
      expect(await session.closed).toMatchObject({ code: 1001 });
      expect((await drained).forced).toBe(1);
      expect(draining.usage.at(-1)).toMatchObject({
        status: 'success',
        media: { audioOutputTokens: 24 },
      });
      const upstream = await mockStats();
      expect(upstream.cutMidResponse).toBe(0);
      expect(upstream.events).not.toContain('response.cancel');
    },
  );
});

describe.skipIf(!VALKEY_URL)('realtime budgets and wallets on real Valkey', () => {
  const conns: Redis[] = [];
  const conn = () => {
    const r = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: 1 });
    conns.push(r);
    return r;
  };
  afterAll(() => {
    for (const c of conns) c.disconnect();
  });

  it('a session whose budget runs out is closed with budget_exceeded, and new ones are refused', async () => {
    const gw = await startGateway({ limiterRedis: conn() });
    try {
      const session = client(`${gw.ws}/v1/realtime?model=rt`, {
        headers: { authorization: `Bearer ${BUDGET_KEY}` },
      });
      expect(await session.status).toBe(101);
      await session.next('session.created');
      session.send({ type: 'input_audio_buffer.append', audio: SECOND_OF_AUDIO });
      session.send({ type: 'input_audio_buffer.commit' });
      session.send({ type: 'response.create' });
      await session.next('response.done');
      // $0.00113 spent against a $0.001 daily budget.
      const error = await session.next('error');
      expect(error.error).toMatchObject({ code: 'budget_exceeded', type: 'insufficient_quota' });
      expect((error.error as { message: string }).message).toMatch(/Daily key budget exceeded/);
      expect(await session.closed).toMatchObject({ code: 1008, reason: 'budget exceeded' });
      const again = client(`${gw.ws}/v1/realtime?model=rt`, {
        headers: { authorization: `Bearer ${BUDGET_KEY}` },
      });
      expect(await again.status).toBe(429);
    } finally {
      await gw.gw.app.close();
    }
  });

  it("a model budget counts the session's responses and closes it once used up", async () => {
    const gw = await startGateway({ limiterRedis: conn() });
    try {
      const session = client(`${gw.ws}/v1/realtime?model=rt-model-budget`, {
        headers: { authorization: `Bearer ${MODEL_BUDGET_KEY}` },
      });
      expect(await session.status).toBe(101);
      await session.next('session.created');
      session.send({ type: 'input_audio_buffer.append', audio: SECOND_OF_AUDIO });
      session.send({ type: 'input_audio_buffer.commit' });
      session.send({ type: 'response.create' });
      await session.next('response.done');
      const error = await session.next('error');
      expect(error.error).toMatchObject({ code: 'budget_exceeded' });
      expect((error.error as { message: string }).message).toMatch(/model budget/);
      expect(await session.closed).toMatchObject({ code: 1008, reason: 'budget exceeded' });
      const again = client(`${gw.ws}/v1/realtime?model=rt-model-budget`, {
        headers: { authorization: `Bearer ${MODEL_BUDGET_KEY}` },
      });
      expect(await again.status).toBe(429);
    } finally {
      await gw.gw.app.close();
    }
  });

  it('a prepaid session is charged per response and closed when it cannot afford another', async () => {
    const admin = conn();
    const walletId = `w-${randomUUID()}`;
    // The session holds 8,192 + 4,096 audio tokens' worth ($0.524288) as headroom.
    await admin.hset(walletKey(walletId), 'balance', usdToUnits('0.525'), 'version', 1, 'held', 0);
    const gw = await startGateway({ limiterRedis: conn() }, walletId);
    try {
      const session = client(`${gw.ws}/v1/realtime?model=rt`, {
        headers: { authorization: `Bearer ${WALLET_KEY}` },
      });
      expect(await session.status).toBe(101);
      await session.next('session.created');
      expect(await admin.hget(walletKey(walletId), 'held')).toBe(String(usdToUnits('0.524288')));
      session.send({ type: 'input_audio_buffer.append', audio: SECOND_OF_AUDIO });
      session.send({ type: 'input_audio_buffer.commit' });
      session.send({ type: 'response.create' });
      await session.next('response.done');
      const error = await session.next('error');
      expect(error.error).toMatchObject({ code: 'insufficient_credit' });
      expect(await session.closed).toMatchObject({ code: 1008 });
      await expect.poll(() => gw.gw.realtime.size).toBe(0);
      // Only the response's charge stays held until the worker posts it; the headroom is gone.
      const event = gw.usage.at(-1);
      await expect
        .poll(() => admin.hget(walletKey(walletId), 'held'))
        .toBe(String(usdToUnits(event?.chargeUsd ?? '0')));
      expect(await admin.hkeys(walletHoldsKey(walletId))).toEqual([event?.requestId]);
      // A new session cannot get its headroom.
      const again = client(`${gw.ws}/v1/realtime?model=rt`, {
        headers: { authorization: `Bearer ${WALLET_KEY}` },
      });
      expect(await again.status).toBe(402);
    } finally {
      await gw.gw.app.close();
    }
  });
});
