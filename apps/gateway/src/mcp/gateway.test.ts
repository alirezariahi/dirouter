/**
 * MCP gateway (card 20.1) against the fake MCP servers of mock-provider: Streamable HTTP (JSON and
 * SSE answers, sessions, pagination) and the older HTTP+SSE transport.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, McpCallRecord } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from '../server.js';
import { maskArguments } from './mask.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const ALL = 'dr-mcp-all-000001';
const LIMITED = 'dr-mcp-limited-001';
const OTHER_ORG = 'dr-mcp-other-0001';

interface Answer {
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

describe('MCP gateway', () => {
  const mock = buildMock();
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  let mockRoot = '';
  const records: McpCallRecord[] = [];

  const rpc = async (key: string, method: string, params?: unknown, id: number | null = 1) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
    });
    return {
      status: res.status,
      body: res.status === 202 ? undefined : ((await res.json()) as Answer),
    };
  };
  const names = async (key: string) =>
    ((await rpc(key, 'tools/list')).body?.result?.tools ?? []).map((t) => t.name).sort();

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const keyring = parseKeyring(generateKey());
    const server = (
      id: string,
      slug: string,
      path: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      organizationId: 'org',
      slug,
      transport: 'streamable-http' as const,
      url: `${mockRoot}${path}`,
      enabled: true,
      ...extra,
    });
    const key = (raw: string, id: string, organizationId: string, mcpTools: string[]) => ({
      id,
      hash: hashApiKey(raw, pepper),
      prefix: id,
      organizationId,
      teamId: null,
      projectId: `prj-${organizationId}`,
      enabled: true,
      expiresAt: null,
      mcpTools,
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [],
      models: [],
      combos: [],
      aliases: [],
      virtualKeys: [
        key(ALL, 'vk-all', 'org', []),
        key(LIMITED, 'vk-limited', 'org', ['demo__echo', 'old__*']),
        key(OTHER_ORG, 'vk-other', 'org-2', []),
      ],
      mcpServers: [
        server('mcp-demo', 'demo', '/mcp/demo', {
          forwardIdentity: true,
          headers: encrypt(
            keyring,
            JSON.stringify({ authorization: 'Bearer upstream-secret' }),
            'mcp:mcp-demo',
          ),
        }),
        server('mcp-stream', 'stream', '/mcp/stream-sse'),
        server('mcp-old', 'old', '/mcp-legacy/old', { transport: 'sse' }),
        server('mcp-off', 'off', '/mcp/off', { enabled: false }),
        server('mcp-down', 'down', '/nothing-here'),
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-mcp-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: () => undefined,
      recordMcpCall: (call) => records.push(call),
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

  it('initializes like an MCP server and refuses bad keys and other methods', async () => {
    const init = await rpc(ALL, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.body?.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
    });
    expect((await rpc(ALL, 'notifications/initialized', undefined, null)).status).toBe(202);
    expect((await rpc('dr-wrong-key-00000', 'tools/list')).status).toBe(401);
    expect(
      (await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${ALL}` } })).status,
    ).toBe(405);
    expect((await rpc(ALL, 'sampling/createMessage')).body?.error?.code).toBe(-32601);
  });

  it('lists the tools of every enabled server, paged and prefixed; a broken one is skipped', async () => {
    const all = await names(ALL);
    for (const server of ['demo', 'stream', 'old'])
      for (const tool of ['add', 'echo', 'fail', 'whoami'])
        expect(all).toContain(`${server}__${tool}`);
    expect(all).toHaveLength(12);
    expect(all.some((n) => n.startsWith('off__') || n.startsWith('down__'))).toBe(false);
    // Another organization's key sees none of them.
    expect(await names(OTHER_ORG)).toEqual([]);
  });

  it('a tool outside the key allowlist is neither listed nor callable', async () => {
    expect(await names(LIMITED)).toEqual([
      'demo__echo',
      'old__add',
      'old__echo',
      'old__fail',
      'old__whoami',
    ]);
    const denied = await rpc(LIMITED, 'tools/call', {
      name: 'demo__add',
      arguments: { a: 1, b: 2 },
    });
    expect(denied.body?.error).toMatchObject({ code: -32602, message: 'Unknown tool: demo__add' });
    expect(records.at(-1)).toMatchObject({
      status: 'denied',
      tool: 'add',
      virtualKeyId: 'vk-limited',
    });
  });

  it('calls tools over all three upstream transports', async () => {
    const call = (name: string, args: Record<string, unknown>) =>
      rpc(ALL, 'tools/call', { name, arguments: args }).then((r) => r.body?.result);
    expect(await call('demo__echo', { text: 'hi' })).toEqual({
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(await call('stream__add', { a: 2, b: 3 })).toMatchObject({ content: [{ text: '5' }] });
    expect(await call('old__add', { a: 4, b: 5 })).toMatchObject({ content: [{ text: '9' }] });
    expect(await call('demo__fail', {})).toMatchObject({ isError: true });
    expect(records.at(-1)).toMatchObject({ status: 'error', tool: 'fail' });
  });

  it('forwards identity and the server headers only where configured', async () => {
    const whoami = await rpc(ALL, 'tools/call', { name: 'demo__whoami', arguments: {} });
    expect(JSON.parse(whoami.body?.result?.content?.[0]?.text ?? '')).toEqual({
      'x-dirouter-organization-id': 'org',
      'x-dirouter-project-id': 'prj-org',
      'x-dirouter-key-id': 'vk-all',
    });
    const plain = await rpc(ALL, 'tools/call', { name: 'stream__whoami', arguments: {} });
    expect(JSON.parse(plain.body?.result?.content?.[0]?.text ?? '')).toEqual({});
  });

  it('starts a new upstream session when the old one expires', async () => {
    await fetch(`${mockRoot}/__mcp/expire`, { method: 'POST' });
    const again = await rpc(ALL, 'tools/call', {
      name: 'demo__echo',
      arguments: { text: 'after expiry' },
    });
    expect(again.body?.result).toMatchObject({ content: [{ text: 'after expiry' }] });
  });

  it('logs calls with masked arguments', async () => {
    await rpc(ALL, 'tools/call', {
      name: 'demo__echo',
      arguments: { text: 'x'.repeat(500), password: 'hunter2', nested: { apiKey: 'sk-1' } },
    });
    const last = records.at(-1);
    expect(last).toMatchObject({
      status: 'success',
      serverId: 'mcp-demo',
      tool: 'echo',
      organizationId: 'org',
      projectId: 'prj-org',
      arguments: { password: '***', nested: { apiKey: '***' } },
    });
    expect(String(last?.arguments.text)).toMatch(/^x{200}…\(500\)$/);
    expect(JSON.stringify(records)).not.toContain('hunter2');
  });

  it('masks deep and wide values', () => {
    expect(maskArguments({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({
      a: { b: { c: { d: '[…]' } } },
    });
    expect(
      (maskArguments({ list: Array.from({ length: 60 }, (_, i) => i) }).list as unknown[]).length,
    ).toBe(51);
  });
});
