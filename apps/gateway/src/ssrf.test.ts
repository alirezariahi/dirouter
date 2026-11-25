/** SSRF guard (card 22.3): customer providers reach public addresses only, checked at connect. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';
import { configureUpstreamGuard } from './upstream.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const INTERNAL = 'i'.repeat(32);

describe('SSRF guard', () => {
  const mock = buildMock();
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  let port = 0;

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    port = typeof ma === 'object' && ma ? ma.port : 0;
    const keyring = parseKeyring(generateKey());
    const provider = (id: string, organizationId: string, host: string) => ({
      id,
      organizationId,
      slug: id,
      type: 'openai-compatible' as const,
      name: id,
      baseUrl: `http://${host}:${String(port)}/v1`,
      enabled: true,
      options: {},
      credentials: [
        { id: `${id}-k`, name: 'k', secret: encrypt(keyring, 'sk', `${id}-k`), enabled: true },
      ],
    });
    const model = (id: string, providerId: string, organizationId: string) => ({
      id,
      organizationId,
      slug: id,
      providerId,
      upstreamModel: 'mock-small',
      enabled: true,
      pricing: { inputPerMTok: '0', outputPerMTok: '0' },
      capabilities: {
        streaming: true,
        tools: false,
        vision: false,
        reasoning: false,
        jsonMode: false,
        embeddings: false,
      },
    });
    const key = (raw: string, organizationId: string) => ({
      id: `vk-${organizationId}`,
      hash: hashApiKey(raw, pepper),
      prefix: 'vk',
      organizationId,
      teamId: null,
      projectId: 'prj',
      enabled: true,
      expiresAt: null,
      allowedModels: [],
    });
    const mcp = (
      id: string,
      organizationId: string,
      slug: string,
      transport: 'streamable-http' | 'a2a',
      path: string,
    ) => ({
      id,
      organizationId,
      slug,
      transport,
      url: `http://127.0.0.1:${String(port)}${path}`,
      enabled: true,
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      platformOrganizationId: 'platform',
      providers: [
        provider('cust-ip', 'customer', '127.0.0.1'),
        provider('cust-name', 'customer', 'localhost'),
        provider('plat', 'platform', '127.0.0.1'),
      ],
      models: [
        model('ip', 'cust-ip', 'customer'),
        model('name', 'cust-name', 'customer'),
        model('own', 'plat', 'platform'),
      ],
      combos: [],
      aliases: [],
      virtualKeys: [key('dr-customer-00001', 'customer'), key('dr-platform-00001', 'platform')],
      // Tenant-supplied MCP servers and A2A agents on a private address (the mock on 127.0.0.1).
      mcpServers: [
        mcp('cust-mcp', 'customer', 'cmcp', 'streamable-http', '/mcp/demo'),
        mcp('cust-agent', 'customer', 'cagent', 'a2a', '/a2a-agent'),
        mcp('plat-mcp', 'platform', 'pmcp', 'streamable-http', '/mcp/demo'),
        mcp('plat-agent', 'platform', 'pagent', 'a2a', '/a2a-agent'),
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-ssrf-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: () => undefined,
      blockPrivateUpstreams: true,
      internalToken: INTERNAL,
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  });
  afterAll(async () => {
    configureUpstreamGuard({ enabled: false, platformOrganizationId: () => undefined });
    await gw.app.close();
    await mock.close();
  });

  const ask = (key: string, model: string) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });
  const hits = async () =>
    (
      (await (await fetch(`http://127.0.0.1:${String(port)}/__mock/stats`)).json()) as {
        requests?: number;
      }
    ).requests ?? 0;

  it('a customer provider on a private address is refused before any connection', async () => {
    const before = await hits();
    for (const model of ['ip', 'name']) {
      const res = await ask('dr-customer-00001', model);
      expect(res.status, model).toBeGreaterThanOrEqual(500);
      await res.text();
    }
    expect(await hits()).toBe(before);
  });

  it("the platform organization's own provider may use a private address", async () => {
    const res = await ask('dr-platform-00001', 'own');
    expect(res.status).toBe(200);
    await res.text();
  });

  const mcpTools = async (key: string) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
    return (body.result?.tools ?? []).map((t) => t.name);
  };

  it("a customer's MCP server on a private address is never reached; the platform's is", async () => {
    expect((await mcpTools('dr-customer-00001')).some((n) => n.startsWith('cmcp__'))).toBe(false);
    expect(await mcpTools('dr-platform-00001')).toContain('pmcp__echo');
  });

  it("a customer's A2A agent on a private address is refused for card and messages", async () => {
    const auth = (key: string) => ({ authorization: `Bearer ${key}` });
    const card = await fetch(`${base}/a2a/agents/cagent/.well-known/agent-card.json`, {
      headers: auth('dr-customer-00001'),
    });
    expect(card.status).toBe(502);
    await card.text();
    const sent = await fetch(`${base}/a2a/agents/cagent`, {
      method: 'POST',
      headers: { ...auth('dr-customer-00001'), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }),
    });
    expect(sent.status).toBe(502);
    await sent.text();
    const own = await fetch(`${base}/a2a/agents/pagent/.well-known/agent-card.json`, {
      headers: auth('dr-platform-00001'),
    });
    expect(own.status).toBe(200);
    await own.text();
  });

  it('the connection test of a customer MCP server or agent obeys the guard too', async () => {
    const probe = async (server: Record<string, unknown>) => {
      const res = await fetch(`${base}/internal/mcp/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL}` },
        body: JSON.stringify({ server: { enabled: true, ...server } }),
      });
      return (await res.json()) as { ok: boolean; error?: string };
    };
    const url = (path: string) => `http://127.0.0.1:${String(port)}${path}`;
    const blocked = await probe({
      id: 'p1',
      organizationId: 'customer',
      slug: 'p1',
      transport: 'streamable-http',
      url: url('/mcp/demo'),
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/public address/);
    const blockedAgent = await probe({
      id: 'p2',
      organizationId: 'customer',
      slug: 'p2',
      transport: 'a2a',
      url: url('/a2a-agent'),
    });
    expect(blockedAgent).toMatchObject({ ok: false });
    expect(blockedAgent.error).toMatch(/public address/);
    const own = await probe({
      id: 'p3',
      organizationId: 'platform',
      slug: 'p3',
      transport: 'a2a',
      url: url('/a2a-agent'),
    });
    expect(own.ok).toBe(true);
  });
});
