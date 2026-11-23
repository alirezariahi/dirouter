/**
 * A2A (card 20.3): DiRouter's own agent (v1.0 and v0.3 wire formats, tasks scoped to the project,
 * answers through the gateway's chat endpoint) and the proxy to a registered external agent.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, McpCallRecord, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from '../server.js';
import { messageText, taskView } from './agent.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-a2a-main-000001';
const OTHER_PROJECT = 'dr-a2a-other-00001';
const LIMITED = 'dr-a2a-limited-0001';

interface Part {
  text?: string;
  kind?: string;
}
interface Task {
  id: string;
  contextId: string;
  kind?: string;
  status: { state: string };
  artifacts: { parts: Part[] }[];
  history: { role: string; parts: Part[] }[];
  metadata?: { identity?: Record<string, string> };
}
interface Answer {
  result?: Partial<Task> & { task?: Task };
  error?: { code: number; message: string };
}

describe('A2A', () => {
  const mock = buildMock();
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  const usage: UsageEvent[] = [];
  const records: McpCallRecord[] = [];

  const rpc = async (
    key: string,
    method: string,
    params: unknown,
    path = '/a2a',
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'r1', method, params }),
    });
    return { status: res.status, body: (await res.json()) as Answer };
  };
  /** The task of a v1.0 SendMessage answer. */
  const sendTask = async (key: string, params: unknown, path = '/a2a') => {
    const task = (await rpc(key, 'SendMessage', params, path)).body.result?.task;
    if (!task) throw new Error('no task in the answer');
    return task;
  };
  const message = (text: string, extra: Record<string, unknown> = {}) => ({
    message: { messageId: `m-${text}`, role: 'ROLE_USER', parts: [{ text }], ...extra },
  });
  const withModel = (text: string, extra: Record<string, unknown> = {}) => ({
    ...message(text, extra),
    metadata: { model: 'small' },
  });

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const keyring = parseKeyring(generateKey());
    const key = (raw: string, id: string, projectId: string, mcpTools: string[] = []) => ({
      id,
      hash: hashApiKey(raw, pepper),
      prefix: id,
      organizationId: 'org',
      teamId: null,
      projectId,
      enabled: true,
      expiresAt: null,
      mcpTools,
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
      virtualKeys: [
        key(KEY, 'vk', 'prj'),
        key(OTHER_PROJECT, 'vk-2', 'prj-2'),
        key(LIMITED, 'vk-3', 'prj', ['other__*']),
      ],
      mcpServers: [
        {
          id: 'agent-echo',
          organizationId: 'org',
          slug: 'echo',
          transport: 'a2a',
          url: `${mockRoot}/a2a-agent`,
          enabled: true,
          forwardIdentity: true,
          headers: encrypt(
            keyring,
            JSON.stringify({ 'x-agent-key': 'agent-secret' }),
            'mcp:agent-echo',
          ),
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-a2a-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: (e) => usage.push(e),
      recordMcpCall: (r) => records.push(r),
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

  it('publishes an agent card with both protocol versions on /a2a', async () => {
    const card = (await (await fetch(`${base}/.well-known/agent-card.json`)).json()) as Record<
      string,
      unknown
    >;
    expect(card).toMatchObject({
      name: 'DiRouter',
      supportedInterfaces: [
        { url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        { url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
      ],
      skills: [{ id: 'chat' }],
    });
  });

  it('v1.0: SendMessage answers through the gateway, GetTask returns it to the same project only', async () => {
    const task = await sendTask(KEY, withModel('hello agent'));
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.artifacts[0]?.parts[0]?.text).toEqual(expect.any(String));
    expect(task.history.map((m) => m.role)).toEqual(['ROLE_USER', 'ROLE_AGENT']);
    // Billed and logged like any request of this key.
    expect(usage.at(-1)).toMatchObject({
      virtualKeyId: 'vk',
      requestedModel: 'small',
      status: 'success',
    });

    const got = await rpc(KEY, 'GetTask', { id: task.id, historyLength: 1 });
    expect(got.body.result).toMatchObject({
      id: task.id,
      status: { state: 'TASK_STATE_COMPLETED' },
    });
    expect(got.body.result?.history).toHaveLength(1);
    expect((await rpc(OTHER_PROJECT, 'GetTask', { id: task.id })).body.error?.code).toBe(-32001);
    expect((await rpc(KEY, 'CancelTask', { id: task.id })).body.error?.code).toBe(-32002);
  });

  it('keeps the conversation of a context, within the project', async () => {
    const first = await sendTask(KEY, withModel('one'));
    const second = await sendTask(KEY, withModel('two', { contextId: first.contextId }));
    expect(second.contextId).toBe(first.contextId);
    expect(second.history.map((m) => m.parts[0]?.text).slice(0, 3)).toEqual([
      'one',
      first.artifacts[0]?.parts[0]?.text,
      'two',
    ]);
    // Another project reusing the context id starts fresh.
    const foreign = await sendTask(
      OTHER_PROJECT,
      withModel('three', { contextId: first.contextId }),
    );
    expect(foreign.history).toHaveLength(2);
  });

  it('v0.3: message/send and tasks/get use the older shapes', async () => {
    const sent = await rpc(KEY, 'message/send', {
      message: {
        kind: 'message',
        messageId: 'x',
        role: 'user',
        parts: [{ kind: 'text', text: 'old client' }],
      },
      metadata: { model: 'small' },
    });
    expect(sent.body.result).toMatchObject({ kind: 'task', status: { state: 'completed' } });
    expect(sent.body.result?.artifacts?.[0]?.parts[0]).toMatchObject({ kind: 'text' });
    const got = await rpc(KEY, 'tasks/get', { id: sent.body.result?.id });
    expect(got.body.result).toMatchObject({ kind: 'task', id: sent.body.result?.id });
  });

  it('without a model the task is rejected; bad keys and versions are refused', async () => {
    const task = await sendTask(KEY, message('no model'));
    expect(task.status).toMatchObject({ state: 'TASK_STATE_REJECTED' });
    expect((await rpc('dr-nope-000000000000', 'SendMessage', message('x'))).status).toBe(401);
    const v2 = await rpc(KEY, 'SendMessage', message('x'), '/a2a', { 'a2a-version': '2.0' });
    expect(v2.body.error?.code).toBe(-32009);
    expect((await rpc(KEY, 'SendStreamingMessage', message('x'))).body.error?.code).toBe(-32601);
  });

  it('proxies a registered external agent with its secret and the caller identity, and logs it', async () => {
    const card = (await (
      await fetch(`${base}/a2a/agents/echo/.well-known/agent-card.json`, {
        headers: { authorization: `Bearer ${KEY}` },
      })
    ).json()) as Record<string, unknown>;
    expect(card.supportedInterfaces).toEqual([
      { url: `${base}/a2a/agents/echo`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ]);
    expect(JSON.stringify(card)).not.toContain('x-agent-key');

    const task = await sendTask(KEY, message('over there'), '/a2a/agents/echo');
    expect(task.artifacts[0]?.parts[0]?.text).toBe('echo: over there');
    expect(task.metadata?.identity).toMatchObject({
      'x-dirouter-organization-id': 'org',
      'x-dirouter-project-id': 'prj',
      'x-dirouter-key-id': 'vk',
    });
    expect(records.at(-1)).toMatchObject({
      serverId: 'agent-echo',
      tool: 'a2a:SendMessage',
      status: 'success',
    });

    // A key whose allowlist does not include the agent does not see it.
    expect((await rpc(LIMITED, 'SendMessage', message('x'), '/a2a/agents/echo')).status).toBe(404);
    expect(records.at(-1)).toMatchObject({ status: 'denied', virtualKeyId: 'vk-3' });
  });

  it('reads text from either part shape and trims history', () => {
    expect(
      messageText({ parts: [{ text: 'a' }, { kind: 'text', text: 'b' }, { kind: 'file' }] }),
    ).toBe('a\nb');
    const stored = {
      id: 't',
      contextId: 'c',
      state: 'completed' as const,
      history: [
        { role: 'user' as const, text: 'q', messageId: '1' },
        { role: 'agent' as const, text: 'a', messageId: '2' },
      ],
      timestamp: 'now',
      owner: { organizationId: 'o', projectId: 'p' },
    };
    expect(taskView(stored, '1.0', 0).history).toEqual([]);
    expect(taskView(stored, '0.3').history).toHaveLength(2);
  });
});
