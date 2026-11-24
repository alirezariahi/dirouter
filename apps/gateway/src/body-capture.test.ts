/**
 * Request body capture (card 24.1): levels per organization, project and key, redaction before
 * the body leaves the gateway, the size cap, streamed answers, and that bodies never ride on usage
 * events. Runs a real gateway against the mock provider.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CanonicalRequest,
  ConfigSnapshotInput,
  RequestBodyRecord,
  UsageEvent,
} from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { capBytes, replayDraft } from './body-capture.js';
import { buildGateway } from './server.js';

const request = (over: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  inboundApi: 'openai.chat',
  model: 'm',
  system: [{ type: 'text', text: 'be brief' }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ],
  stream: false,
  maxOutputTokens: 100,
  temperature: 0.3,
  ...over,
});

describe('capBytes', () => {
  it('keeps short text and cuts long text on a character boundary', () => {
    expect(capBytes('hello', 10)).toEqual({ text: 'hello', truncated: false });
    const cut = capBytes('سلام دنیا', 5);
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(5);
    expect(cut.text).not.toContain('�');
  });
});

describe('replayDraft', () => {
  it('turns a conversation into system, history and the last user message', () => {
    expect(replayDraft(request())).toEqual({
      system: 'be brief',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
      ],
      prompt: 'second',
      maxTokens: 100,
      temperature: 0.3,
      lossy: false,
    });
  });

  it('marks images, tools and tool turns as lossy and needs a user message', () => {
    const draft = replayDraft(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', source: { kind: 'url', url: 'https://x/y.png' } },
            ],
          },
          { role: 'tool', content: [] },
        ],
      }),
    );
    expect(draft).toMatchObject({ prompt: 'look', lossy: true, history: [] });
    expect(
      replayDraft(
        request({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }] }),
      ),
    ).toBeUndefined();
  });
});

describe('body capture through the gateway', () => {
  const keyring = parseKeyring(generateKey());
  const pepper = 'p'.repeat(32);
  const KEYS = {
    off: 'dr-body-test-key-0off',
    meta: 'dr-body-test-key-meta',
    full: 'dr-body-test-key-full',
    orgFull: 'dr-body-test-key-org2',
  };
  const mock = buildMock();
  const bodies: RequestBodyRecord[] = [];
  const usage: UsageEvent[] = [];
  let gw: ReturnType<typeof buildGateway>;
  let base = '';

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const virtualKey = (id: string, secret: string, projectId: string, organizationId = 'org') => ({
      id,
      hash: hashApiKey(secret, pepper),
      prefix: secret.slice(0, 6),
      organizationId,
      teamId: null,
      projectId,
      enabled: true,
      expiresAt: null,
    });
    const provider = (organizationId: string) => ({
      id: `oa-${organizationId}`,
      organizationId,
      slug: 'oa',
      type: 'openai-compatible' as const,
      name: 'oa',
      baseUrl: `${mockRoot}/v1`,
      enabled: true,
      options: {},
      credentials: [
        {
          id: `oa-k-${organizationId}`,
          name: 'oa',
          secret: encrypt(keyring, 'sk-x', `oa-k-${organizationId}`),
          enabled: true,
        },
      ],
    });
    const model = (organizationId: string) => ({
      id: `gpt-x-${organizationId}`,
      organizationId,
      slug: 'gpt-x',
      providerId: `oa-${organizationId}`,
      upstreamModel: 'mock-small',
      enabled: true,
      contextWindow: 100_000,
      pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
      capabilities: {},
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [provider('org'), provider('org2')],
      models: [model('org'), model('org2')],
      combos: [],
      aliases: [],
      virtualKeys: [
        virtualKey('vk-off', KEYS.off, 'project-off'),
        virtualKey('vk-meta', KEYS.meta, 'project-meta'),
        virtualKey('vk-full', KEYS.full, 'project-meta'),
        virtualKey('vk-org2', KEYS.orgFull, 'project-2', 'org2'),
      ],
      guardrails: [
        {
          id: 'g-email',
          organizationId: 'org',
          name: 'emails',
          enabled: true,
          stage: 'both',
          type: 'pii',
          config: { type: 'email' },
          // Flag in live traffic: the client and provider see the address, storage does not.
          action: 'flag',
        },
        {
          id: 'g-phone',
          organizationId: 'org',
          name: 'mask emails in storage',
          enabled: true,
          stage: 'both',
          type: 'regex',
          config: { pattern: '\\b[\\w.]+@example\\.com\\b', flags: 'g' },
          action: 'redact',
        },
      ],
      bodyCapture: [
        { organizationId: 'org', scope: 'project', scopeId: 'project-meta', level: 'metadata' },
        { organizationId: 'org', scope: 'key', scopeId: 'vk-full', level: 'full' },
        { organizationId: 'org2', scope: 'organization', scopeId: 'org2', level: 'full' },
      ],
      settings: { bodyCapture: { maxBytes: 2_048 } },
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-bodies-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger: createLogger({ service: 'test', level: 'silent' }),
      keyring,
      pepper,
      dataDir,
      emitUsage: (event) => usage.push(event),
      recordBody: (record) => bodies.push(record),
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

  beforeEach(() => {
    bodies.length = 0;
    usage.length = 0;
  });

  const chat = (key: string, content: string, extra: Record<string, unknown> = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-x',
        temperature: 0.5,
        messages: [
          { role: 'system', content: 'you are terse' },
          { role: 'user', content },
        ],
        ...extra,
      }),
    });
  /** Bodies are queued when the response closes, a moment after the client has read it. */
  const settle = async (n: number) => {
    for (let i = 0; i < 100 && bodies.length < n; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
  };

  it('captures nothing by default', async () => {
    const res = await chat(KEYS.off, 'nothing to see');
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bodies).toEqual([]);
    expect(usage).toHaveLength(1);
  });

  it('keeps only the shape at the metadata level (project rule)', async () => {
    const res = await chat(KEYS.meta, 'secret plans for jane@example.com');
    expect(res.status).toBe(200);
    await res.text();
    await settle(1);
    expect(bodies).toHaveLength(1);
    const record = bodies[0];
    expect(record).toMatchObject({
      level: 'metadata',
      apiKeyId: 'vk-meta',
      projectId: 'project-meta',
      inboundApi: 'openai.chat',
      requestId: res.headers.get('x-request-id'),
      metadata: {
        model: 'gpt-x',
        stream: false,
        parameters: ['temperature'],
        messages: 1,
        roles: { system: 1, user: 1 },
        tools: [],
        finishReason: 'stop',
      },
    });
    expect(record?.request).toBeUndefined();
    expect(record?.response).toBeUndefined();
    expect(record?.replay).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('secret plans');
    expect(record?.metadata.requestBytes).toBeGreaterThan(0);
    expect(record?.metadata.responseBytes).toBeGreaterThan(0);
  });

  it('stores the full body at the key level, redacted by the redact policies', async () => {
    const res = await chat(
      KEYS.full,
      'write to jane@example.com about sk-proj-AbCdEfGhIjKlMnOpQrStUvWx123456',
    );
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { choices: { message: { content: string } }[] };
    await settle(1);
    const record = bodies[0];
    expect(record?.level).toBe('full');
    expect(record?.redactions).toBeGreaterThanOrEqual(2);
    expect(record?.request).toBeDefined();
    expect(record?.request).not.toContain('jane@example.com');
    expect(record?.request).not.toContain('sk-proj');
    expect(record?.request).toContain('[REDACTED]');
    expect(JSON.parse(record?.request ?? '{}')).toMatchObject({ model: 'gpt-x', temperature: 0.5 });
    const stored = JSON.parse(record?.response ?? '{}') as typeof answer;
    expect(stored.choices[0]?.message.content).toBe(answer.choices[0]?.message.content);
    expect(record?.replay).toMatchObject({
      system: 'you are terse',
      history: [],
      lossy: false,
      temperature: 0.5,
    });
    expect(record?.replay?.prompt).not.toContain('jane@example.com');
    expect(record?.createdAt).toBe(usage[0]?.occurredAt);
  });

  it('applies an organization-wide level to every key of that organization only', async () => {
    const res = await chat(KEYS.orgFull, 'org-wide capture');
    await res.text();
    await settle(1);
    expect(bodies.map((b) => [b.organizationId, b.level])).toEqual([['org2', 'full']]);
  });

  it('cuts each part at the size cap and marks it', async () => {
    const res = await chat(KEYS.full, 'x'.repeat(5_000));
    await res.text();
    await settle(1);
    const record = bodies[0];
    expect(record?.requestTruncated).toBe(true);
    expect(Buffer.byteLength(record?.request ?? '')).toBeLessThanOrEqual(2_048);
    expect(record?.responseTruncated).toBe(false);
    expect(record?.metadata.requestBytes).toBeGreaterThan(5_000);
  });

  it('stores a streamed answer as the JSON answer it adds up to', async () => {
    const res = await chat(KEYS.full, 'stream please', { stream: true });
    const text = await res.text();
    expect(text).toContain('data: [DONE]');
    await settle(1);
    const record = bodies[0];
    expect(record?.streamed).toBe(true);
    expect(record?.metadata.stream).toBe(true);
    const streamed = text
      .split('\n')
      .filter((l) => l.startsWith('data: {'))
      .map(
        (l) =>
          (JSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]
            ?.delta?.content ?? '',
      )
      .join('');
    const stored = JSON.parse(record?.response ?? '{}') as {
      choices: { message: { content: string } }[];
    };
    expect(stored.choices[0]?.message.content).toBe(streamed);
  });

  it('keeps the error answer of a failed request', async () => {
    const res = await chat(KEYS.full, 'hi', { model: 'no-such-model' });
    expect(res.status).toBe(404);
    await res.text();
    await settle(1);
    expect(bodies[0]?.response).toContain('model_not_found');
  });

  it('never puts bodies on usage events', async () => {
    const res = await chat(KEYS.full, 'a very distinctive prompt 7f3a');
    await res.text();
    await settle(1);
    expect(bodies).toHaveLength(1);
    expect(usage).toHaveLength(1);
    expect(JSON.stringify(usage)).not.toContain('distinctive prompt');
  });
});
