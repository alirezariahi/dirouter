/**
 * A2A 1.0 streaming and push notifications (card 28.2).
 *
 * The official A2A SDKs cannot be installed offline here, so `A2aClient` below is a faithful
 * client written from the A2A 1.0 specification (JSON-RPC binding): it discovers the agent through
 * its Agent Card, insists on `capabilities.streaming`, sends `A2A-Version`, reads the SSE stream,
 * and checks the rules a reference client relies on: every event is a JSON-RPC response with the
 * request id and exactly one `StreamResponse` member, the first is the Task, artifact chunks follow
 * `append`/`lastChunk`, and the stream ends at a terminal state.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- loosely typed protocol payloads */
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import {
  createLogger,
  encrypt,
  generateKey,
  hashApiKey,
  type Keyring,
  parseKeyring,
} from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from '../server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-a2a-stream-0001';
const OTHER_PROJECT = 'dr-a2a-stream-0002';
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

// Protocol payloads are checked by value here, not by type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const STREAM_MEMBERS = ['task', 'message', 'statusUpdate', 'artifactUpdate'] as const;
const TERMINAL_V1 = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/** A2A 1.0 JSON-RPC client, from the specification (see the file comment). */
class A2aClient {
  #url = '';
  #nextId = 1;

  constructor(
    private readonly base: string,
    private readonly key: string,
  ) {}

  async connect(): Promise<Json> {
    const card = (await (await fetch(`${this.base}/.well-known/agent-card.json`)).json()) as Json;
    const iface = (card.supportedInterfaces as Json[]).find(
      (i) => i.protocolBinding === 'JSONRPC' && i.protocolVersion === '1.0',
    );
    if (!iface) throw new Error('agent has no JSON-RPC 1.0 interface');
    this.#url = iface.url as string;
    return card;
  }

  #headers(accept: string) {
    return {
      authorization: `Bearer ${this.key}`,
      'content-type': 'application/json',
      accept,
      'a2a-version': '1.0',
    };
  }

  async call(method: string, params: unknown): Promise<Json> {
    const res = await fetch(this.#url, {
      method: 'POST',
      headers: this.#headers('application/json'),
      body: JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params }),
    });
    return (await res.json()) as Json;
  }

  /** Streams a method; returns every `StreamResponse` and the aggregated answer. */
  async stream(method: string, params: unknown) {
    const id = this.#nextId++;
    const res = await fetch(this.#url, {
      method: 'POST',
      headers: this.#headers('text/event-stream'),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream'))
      return { error: ((await res.json()) as Json).error as Json, events: [], text: '' };
    expect(res.headers.get('a2a-version')).toBe('1.0');
    const events: Json[] = [];
    const artifacts = new Map<string, string>();
    let ended = false;
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data) continue; // keep-alive comment
        expect(ended, 'no event after the terminal state').toBe(false);
        const rpc = JSON.parse(data) as Json;
        expect(rpc).toMatchObject({ jsonrpc: '2.0', id });
        const result = rpc.result as Json;
        expect(STREAM_MEMBERS.filter((m) => m in result)).toHaveLength(1);
        if (events.length === 0) expect(result.task, 'the first event is the Task').toBeDefined();
        events.push(result);
        if (result.artifactUpdate) {
          const update = result.artifactUpdate as Json;
          const artifactId = update.artifact.artifactId as string;
          const text = (update.artifact.parts as Json[]).map((p) => p.text as string).join('');
          if (!update.append) expect(artifacts.has(artifactId)).toBe(false);
          artifacts.set(
            artifactId,
            (update.append ? (artifacts.get(artifactId) ?? '') : '') + text,
          );
        }
        const state = (result.task ?? result.statusUpdate)?.status?.state as string | undefined;
        if (state && TERMINAL_V1.has(state)) ended = true;
      }
    }
    expect(ended, 'the stream ends at a terminal state').toBe(true);
    return { events, text: [...artifacts.values()].join(''), error: undefined };
  }
}

interface Hook {
  headers: IncomingHttpHeaders;
  body: string;
}

/** A webhook receiver on localhost recording what it gets; `fail` answers 500 that many times. */
async function startWebhook(options: { fail?: number } = {}) {
  const received: Hook[] = [];
  let failures = options.fail ?? 0;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (failures > 0) {
        failures--;
        res.writeHead(500).end();
        return;
      }
      received.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}/hook`;
  return { url, received, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Checks an ES256 compact JWS against a JWKS, as a webhook receiver would. */
function verifySignature(jws: string, jwks: { keys: Json[] }, body: string) {
  const [h, p, s] = jws.split('.') as [string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as Json;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Json;
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'ES256') return { valid: false, header, claims };
  const key = createPublicKey({ key: jwk as never, format: 'jwk' });
  const signed = verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  const bodyMatches =
    claims.request_body_sha256 === createHash('sha256').update(body).digest('hex');
  return { valid: signed && bodyMatches, header, claims };
}

const waitUntil = async (check: () => boolean, ms = 5_000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('A2A streaming and push notifications', { timeout: 30_000 }, () => {
  const mock = buildMock();
  let mockRoot = '';
  const keyring: Keyring = parseKeyring(generateKey());
  const usage: UsageEvent[] = [];
  const gateways: ReturnType<typeof buildGateway>[] = [];
  const redis: Redis[] = [];
  const hooks: { close: () => Promise<unknown> }[] = [];
  let base = '';
  let gw: ReturnType<typeof buildGateway>;
  let client: A2aClient;

  const mockSays = (directives: string) =>
    fetch(`${mockRoot}/__mock/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directives }),
    });
  const message = (text: string) => ({
    message: {
      messageId: `m-${randomBytes(4).toString('hex')}`,
      role: 'ROLE_USER',
      parts: [{ text }],
    },
    metadata: { model: 'small' },
  });
  const rpc = async (key: string, method: string, params: unknown, headers = {}, path = '/a2a') => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { headers: res.headers, body: (await res.json()) as Json };
  };

  async function startGateway(
    options: { stateRedis?: Redis; blockPrivateUpstreams?: boolean } = {},
  ) {
    const key = (raw: string, id: string, projectId: string) => ({
      id,
      hash: hashApiKey(raw, pepper),
      prefix: id,
      organizationId: 'org',
      teamId: null,
      projectId,
      enabled: true,
      expiresAt: null,
      mcpTools: [],
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        {
          id: 'p',
          organizationId: 'org',
          slug: 'p',
          type: 'openai-compatible',
          name: 'p',
          baseUrl: `${mockRoot}/v1`,
          enabled: true,
          options: {},
          credentials: [
            { id: 'k', name: 'k', secret: encrypt(keyring, 'sk-x', 'k'), enabled: true },
          ],
        },
      ],
      models: [
        {
          id: 'm',
          organizationId: 'org',
          slug: 'small',
          providerId: 'p',
          upstreamModel: 'mock-small',
          enabled: true,
          pricing: { inputPerMTok: '1', outputPerMTok: '1' },
          capabilities: {},
        },
      ],
      combos: [],
      aliases: [],
      virtualKeys: [key(KEY, 'vk', 'prj'), key(OTHER_PROJECT, 'vk-2', 'prj-2')],
      mcpServers: [
        {
          id: 'agent-echo',
          organizationId: 'org',
          slug: 'echo',
          transport: 'a2a',
          url: `${mockRoot}/a2a-agent`,
          enabled: true,
          headers: encrypt(
            keyring,
            JSON.stringify({ 'x-agent-key': 'agent-secret' }),
            'mcp:agent-echo',
          ),
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-a2a-stream-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    const instance = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: (e) => usage.push(e),
      a2aPushRetryDelaysMs: [20, 20, 20],
      ...(options.stateRedis ? { stateRedis: options.stateRedis } : {}),
      ...(options.blockPrivateUpstreams ? { blockPrivateUpstreams: true } : {}),
    });
    await instance.start();
    await instance.app.listen({ port: 0, host: '127.0.0.1' });
    gateways.push(instance);
    const address = instance.app.server.address();
    return {
      instance,
      base: `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`,
    };
  }

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const address = mock.server.address();
    mockRoot = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
    ({ instance: gw, base } = await startGateway());
    client = new A2aClient(base, KEY);
  });

  afterAll(async () => {
    for (const g of gateways) await g.app.close();
    for (const r of redis) r.disconnect();
    for (const h of hooks) await h.close();
    await mock.close();
  });

  it('the Agent Card advertises streaming and push notifications', async () => {
    const card = await client.connect();
    expect(card.capabilities).toMatchObject({ streaming: true, pushNotifications: true });
  });

  it('SendStreamingMessage: the client receives the task as a stream, the answer chunk by chunk', async () => {
    await mockSays('text=one two three four five six,chunks=6');
    const { events, text } = await client.stream('SendStreamingMessage', message('stream it'));
    expect(events[0]?.task.status.state).toBe('TASK_STATE_SUBMITTED');
    expect(events[1]?.statusUpdate.status.state).toBe('TASK_STATE_WORKING');
    const chunks = events.filter((e) => e.artifactUpdate).map((e) => e.artifactUpdate as Json);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]?.append).toBe(false);
    expect(chunks.slice(1).every((c) => c.append === true)).toBe(true);
    expect(chunks.map((c) => c.lastChunk)).toEqual([...chunks.slice(1).map(() => false), true]);
    expect(text).toBe('one two three four five six');
    expect(events.at(-1)?.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
    // The finished task is stored, and the stream was billed like any streamed request.
    const taskId = events[0]?.task.id as string;
    const got = await client.call('GetTask', { id: taskId });
    expect(got.result.artifacts[0].parts[0].text).toBe('one two three four five six');
    expect(usage.at(-1)).toMatchObject({
      virtualKeyId: 'vk',
      requestedModel: 'small',
      status: 'success',
    });
  });

  it('v0.3 message/stream uses kind-tagged events and final', async () => {
    await mockSays('text=old style stream,chunks=3');
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'a2a-version': '0.3',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'x',
        method: 'message/stream',
        params: {
          message: {
            kind: 'message',
            messageId: 'o1',
            role: 'user',
            parts: [{ kind: 'text', text: 'hi' }],
          },
          metadata: { model: 'small' },
        },
      }),
    });
    const events = (await res.text())
      .split('\n\n')
      .filter((f) => f.startsWith('data:'))
      .map((f) => (JSON.parse(f.slice(5)) as Json).result as Json);
    expect(events[0]).toMatchObject({ kind: 'task', status: { state: 'submitted' } });
    expect(events.filter((e) => e.kind === 'artifact-update').at(-1)).toMatchObject({
      lastChunk: true,
      artifact: { parts: [{ kind: 'text' }] },
    });
    expect(events.at(-1)).toMatchObject({
      kind: 'status-update',
      final: true,
      status: { state: 'completed' },
    });
  });

  it('SubscribeToTask streams a running task; a finished one is refused', async () => {
    await mockSays('text=slow answer here,chunks=3,latency=400');
    const sent = await client.call('SendMessage', {
      ...message('take your time'),
      configuration: { returnImmediately: true },
    });
    const task = sent.result.task as Json;
    expect(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']).toContain(task.status.state);
    const { events } = await client.stream('SubscribeToTask', { id: task.id });
    expect(events[0]?.task.id).toBe(task.id);
    expect(events.at(-1)?.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
    const again = await client.stream('SubscribeToTask', { id: task.id });
    expect(again.error?.code).toBe(-32004);
    expect((await rpc(OTHER_PROJECT, 'SubscribeToTask', { id: task.id })).body.error.code).toBe(
      -32001,
    );
  });

  it('CancelTask cancels a running task, and the cancellation stands', async () => {
    await mockSays('text=never seen,latency=600');
    const sent = await client.call('SendMessage', {
      ...message('cancel me'),
      configuration: { returnImmediately: true },
    });
    const id = sent.result.task.id as string;
    const canceled = await client.call('CancelTask', { id });
    expect(canceled.result.status.state).toBe('TASK_STATE_CANCELED');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect((await client.call('GetTask', { id })).result.status.state).toBe('TASK_STATE_CANCELED');
    expect((await client.call('CancelTask', { id })).error.code).toBe(-32002);
  });

  it('a push notification arrives signed at the webhook', async () => {
    await mockSays('text=pushed answer,latency=100');
    const hook = await startWebhook();
    hooks.push(hook);
    const credentials = randomBytes(16).toString('hex');
    const token = randomBytes(8).toString('hex');
    const sent = await client.call('SendMessage', {
      ...message('notify me'),
      configuration: {
        returnImmediately: true,
        taskPushNotificationConfig: {
          url: hook.url,
          token,
          authentication: { scheme: 'Bearer', credentials },
        },
      },
    });
    const taskId = sent.result.task.id as string;
    await waitUntil(() => hook.received.some((r) => r.body.includes('TASK_STATE_COMPLETED')));
    const jwks = (await (await fetch(`${base}/.well-known/jwks.json`)).json()) as { keys: Json[] };
    // Every status change, in order: working, then the finished task.
    const bodies = hook.received.map((r) => JSON.parse(r.body) as Json);
    expect(bodies.map((b) => b.statusUpdate?.status.state ?? b.task?.status.state)).toEqual([
      'TASK_STATE_WORKING',
      'TASK_STATE_COMPLETED',
    ]);
    expect(bodies[1]?.task.artifacts[0].parts[0].text).toBe('pushed answer');
    for (const hit of hook.received) {
      expect(hit.headers['content-type']).toBe('application/a2a+json');
      expect(hit.headers.authorization).toBe(`Bearer ${credentials}`);
      expect(hit.headers['x-a2a-notification-token']).toBe(token);
      expect(hit.headers['a2a-version']).toBe('1.0');
      const signature = String(hit.headers['x-dirouter-push-signature']);
      const checked = verifySignature(signature, jwks, hit.body);
      expect(checked.valid).toBe(true);
      expect(checked.header.jku).toBe(`${base}/.well-known/jwks.json`);
      expect(checked.claims).toMatchObject({ aud: hook.url, taskId, iss: base });
      // A changed body no longer matches its signature.
      expect(
        verifySignature(signature, jwks, hit.body.replace('TASK_STATE', 'TASK_STATE_X')).valid,
      ).toBe(false);
    }
  });

  it('retries a failing webhook', async () => {
    await mockSays('text=retry,latency=0');
    const hook = await startWebhook({ fail: 2 });
    hooks.push(hook);
    const sent = await client.call('SendMessage', message('first'));
    const taskId = sent.result.task.id as string;
    // A config added to a finished task: nothing to send; to a new one: delivered after retries.
    const created = await client.call('CreateTaskPushNotificationConfig', {
      taskId,
      url: hook.url,
    });
    expect(created.result).toMatchObject({ taskId, url: hook.url, id: expect.any(String) });
    const next = await client.call('SendMessage', {
      ...message('second'),
      configuration: { taskPushNotificationConfig: { url: hook.url } },
    });
    expect(next.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    await gw.a2a.pushesSettled();
    expect(hook.received.map((r) => (JSON.parse(r.body) as Json).task?.status.state).at(-1)).toBe(
      'TASK_STATE_COMPLETED',
    );
  });

  it('push notification config CRUD in both versions, scoped to the project', async () => {
    const hook = await startWebhook();
    hooks.push(hook);
    const taskId = (await client.call('SendMessage', message('crud'))).result.task.id as string;
    const created = await client.call('CreateTaskPushNotificationConfig', {
      taskId,
      id: 'cfg-1',
      url: hook.url,
      token: 't1',
      authentication: { scheme: 'Bearer', credentials: 'never-returned' },
    });
    expect(created.result).toEqual({
      taskId,
      id: 'cfg-1',
      url: hook.url,
      token: 't1',
      authentication: { scheme: 'Bearer' },
    });
    expect(JSON.stringify(created)).not.toContain('never-returned');
    expect(
      (await client.call('GetTaskPushNotificationConfig', { taskId, id: 'cfg-1' })).result.id,
    ).toBe('cfg-1');
    const listed = await client.call('ListTaskPushNotificationConfigs', { taskId });
    expect(listed.result).toMatchObject({ configs: [{ id: 'cfg-1' }], nextPageToken: '' });

    // v0.3 shapes on the same task.
    const set03 = await rpc(KEY, 'tasks/pushNotificationConfig/set', {
      taskId,
      pushNotificationConfig: {
        id: 'cfg-2',
        url: hook.url,
        authentication: { schemes: ['Basic'], credentials: 'x' },
      },
    });
    expect(set03.body.result).toEqual({
      taskId,
      pushNotificationConfig: {
        id: 'cfg-2',
        url: hook.url,
        authentication: { schemes: ['Basic'] },
      },
    });
    const list03 = await rpc(KEY, 'tasks/pushNotificationConfig/list', { id: taskId });
    expect((list03.body.result as Json[]).map((c) => c.pushNotificationConfig.id)).toEqual([
      'cfg-1',
      'cfg-2',
    ]);
    const get03 = await rpc(KEY, 'tasks/pushNotificationConfig/get', {
      id: taskId,
      pushNotificationConfigId: 'cfg-2',
    });
    expect(get03.body.result.pushNotificationConfig.id).toBe('cfg-2');
    expect(
      (
        await rpc(KEY, 'tasks/pushNotificationConfig/delete', {
          id: taskId,
          pushNotificationConfigId: 'cfg-2',
        })
      ).body.result,
    ).toBeNull();

    expect(
      (await client.call('DeleteTaskPushNotificationConfig', { taskId, id: 'cfg-1' })).result,
    ).toEqual({});
    // Idempotent, and gone.
    expect(
      (await client.call('DeleteTaskPushNotificationConfig', { taskId, id: 'cfg-1' })).result,
    ).toEqual({});
    expect(
      (await client.call('GetTaskPushNotificationConfig', { taskId, id: 'cfg-1' })).error.code,
    ).toBe(-32602);

    // Bad input, unknown task, another project.
    for (const url of ['ftp://example.com/hook', 'not a url', 'http://user:pw@example.com/hook'])
      expect(
        (await client.call('CreateTaskPushNotificationConfig', { taskId, url })).error.code,
      ).toBe(-32602);
    expect(
      (await client.call('CreateTaskPushNotificationConfig', { taskId: 'nope', url: hook.url }))
        .error.code,
    ).toBe(-32001);
    expect(
      (await rpc(OTHER_PROJECT, 'ListTaskPushNotificationConfigs', { taskId })).body.error.code,
    ).toBe(-32001);
  });

  it('negotiates the A2A-Version header and query parameter', async () => {
    const ok = await rpc(KEY, 'GetTask', { id: 'none' }, { 'a2a-version': '1.0.3' });
    expect(ok.body.error.code).toBe(-32001);
    expect(ok.headers.get('a2a-version')).toBe('1.0');
    expect(
      (await rpc(KEY, 'GetTask', { id: 'none' }, { 'a2a-version': '1.1' })).body.error.code,
    ).toBe(-32009);
    expect(
      (await rpc(KEY, 'GetTask', { id: 'none' }, {}, '/a2a?A2A-Version=2.0')).body.error.code,
    ).toBe(-32009);
    expect(
      (await rpc(KEY, 'tasks/get', { id: 'none' }, { 'a2a-version': '0.3' })).headers.get(
        'a2a-version',
      ),
    ).toBe('0.3');
  });

  it('passes an external agent stream through', async () => {
    const res = await fetch(`${base}/a2a/agents/echo`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'a2a-version': '1.0',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'SendStreamingMessage',
        params: message('far'),
      }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('echo: far');
    expect(text).toContain('TASK_STATE_COMPLETED');
  });

  it.skipIf(!VALKEY_URL)(
    'subscribes on one replica to a task running on another (Valkey)',
    async () => {
      const a = new Redis(VALKEY_URL ?? '');
      const b = new Redis(VALKEY_URL ?? '');
      redis.push(a, b);
      const one = await startGateway({ stateRedis: a });
      const two = await startGateway({ stateRedis: b });
      await mockSays('text=across replicas,chunks=2,latency=500');
      const sent = new A2aClient(one.base, KEY);
      await sent.connect();
      const task = (
        await sent.call('SendMessage', {
          ...message('x'),
          configuration: { returnImmediately: true },
        })
      ).result.task as Json;
      const watcher = new A2aClient(two.base, KEY);
      await watcher.connect();
      const { events, text } = await watcher.stream('SubscribeToTask', { id: task.id });
      expect(events[0]?.task.id).toBe(task.id);
      expect(events.at(-1)?.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
      expect(text).toBe('');
      // The push config is stored encrypted in Valkey with the task.
      const hook = await startWebhook();
      hooks.push(hook);
      await watcher.call('CreateTaskPushNotificationConfig', {
        taskId: task.id,
        url: hook.url,
        token: 'plain-token',
      });
      expect(await a.get(`a2a:push:${String(task.id)}`)).not.toContain('plain-token');
    },
  );

  it('refuses private webhook addresses where the SSRF guard applies', async () => {
    const guarded = await startGateway({ blockPrivateUpstreams: true });
    const g = new A2aClient(guarded.base, KEY);
    await g.connect();
    // No model call needed: a rejected task exists to attach configs to.
    const taskId = (await g.call('SendMessage', { message: message('x').message })).result.task
      .id as string;
    for (const url of [
      'http://127.0.0.1:9/hook',
      'https://127.0.0.1/hook',
      'https://localhost/hook',
      'https://[::1]/hook',
      'https://169.254.169.254/latest',
    ])
      expect(
        (await g.call('CreateTaskPushNotificationConfig', { taskId, url })).error,
      ).toMatchObject({ code: -32602 });
  });
});
