/** MCP server and A2A agent connection test and tool discovery for control-api (card 25.3). */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from '../server.js';

const INTERNAL = 'i'.repeat(32);
const keyring = parseKeyring(generateKey());

describe('MCP probe', () => {
  const mock = buildMock();
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  let mockRoot = '';

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-mcp-probe-'));
    await writeFile(
      join(dataDir, 'snapshot.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: 1,
        generatedAt: new Date().toISOString(),
        providers: [],
        models: [],
        combos: [],
        aliases: [],
        virtualKeys: [],
        settings: {},
      }),
    );
    gw = buildGateway({
      logger: createLogger({ service: 'test', level: 'silent' }),
      keyring,
      pepper: 'p'.repeat(32),
      dataDir,
      emitUsage: () => undefined,
      internalToken: INTERNAL,
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

  const probe = async (server: Record<string, unknown>, token: string | null = INTERNAL) => {
    const res = await fetch(`${base}/internal/mcp/probe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        server: { organizationId: 'org', enabled: true, transport: 'streamable-http', ...server },
      }),
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        ok: boolean;
        latencyMs: number;
        tools: { name: string; description?: string }[];
        agentName?: string;
        error?: string;
      },
    };
  };

  it('discovers the tools of a Streamable HTTP server with encrypted headers', async () => {
    const { status, body } = await probe({
      id: 'mcp-demo',
      slug: 'demo',
      url: `${mockRoot}/mcp/demo`,
      headers: encrypt(keyring, JSON.stringify({ authorization: 'Bearer x' }), 'mcp:mcp-demo'),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.tools.map((t) => t.name).sort()).toEqual(['add', 'echo', 'fail', 'whoami']);
    expect(body.tools.find((t) => t.name === 'echo')?.description).toBeTruthy();
  });

  it('speaks the older HTTP+SSE transport too', async () => {
    const { body } = await probe({
      id: 'mcp-old',
      slug: 'old',
      transport: 'sse',
      url: `${mockRoot}/mcp-legacy/old`,
    });
    expect(body.ok).toBe(true);
    expect(body.tools.map((t) => t.name)).toContain('echo');
  });

  it('reads the skills of an A2A agent from its card', async () => {
    const { body } = await probe({
      id: 'mcp-agent',
      slug: 'echo-agent',
      transport: 'a2a',
      url: `${mockRoot}/a2a-agent`,
    });
    expect(body).toMatchObject({
      ok: true,
      agentName: 'Echo agent',
      tools: [{ name: 'Echo', description: 'Repeats the message' }],
    });
  });

  it('reports an unreachable server as a failed test, not a gateway error', async () => {
    const { status, body } = await probe({
      id: 'mcp-down',
      slug: 'down',
      url: `${mockRoot}/nothing-here`,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.tools).toEqual([]);
    expect(body.error).toBeTruthy();
  });

  it('is hidden without the internal token and rejects a malformed body', async () => {
    expect((await probe({ id: 'x', slug: 'x', url: `${mockRoot}/mcp/demo` }, null)).status).toBe(
      404,
    );
    expect((await probe({ id: 'x', slug: 'Bad Slug', url: 'not a url' })).status).toBe(422);
  });
});
