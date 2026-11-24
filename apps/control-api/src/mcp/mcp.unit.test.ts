/** MCP server connection test through the gateway probe (card 25.3). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env.js';
import type { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { McpService } from './mcp.service.js';

const ROW = {
  id: 'mcp_1',
  organizationId: 'org_1',
  name: 'Docs',
  slug: 'docs',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headersEnc: 'v1:encrypted-headers',
  enabled: false,
  forwardIdentity: true,
  timeoutMs: 20_000,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};
const ctx = { organizationId: 'org_1', userId: 'usr_1' } as OrgContext;
const env = {
  GATEWAY_INTERNAL_URL: 'http://gateway:8080/',
  INTERNAL_TOKEN: 'i'.repeat(32),
} as unknown as Env;

function service(row: typeof ROW | null = ROW) {
  const findFirst = vi.fn(() => Promise.resolve(row));
  const prisma = { client: { mcpServer: { findFirst } } } as unknown as PrismaService;
  return { mcp: new McpService(env, prisma), findFirst };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MCP connection test', () => {
  it('sends the stored server, headers still encrypted, to the gateway probe', async () => {
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        Response.json({
          ok: true,
          latencyMs: 42,
          tools: [{ name: 'search', description: 'Search the docs' }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const { mcp, findFirst } = service();
    expect(await mcp.test(ctx, 'mcp_1')).toEqual({
      ok: true,
      latencyMs: 42,
      tools: [{ name: 'search', description: 'Search the docs' }],
    });
    // Only a server of the caller's organization can be tested.
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'mcp_1', organizationId: 'org_1', deletedAt: null },
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://gateway:8080/internal/mcp/probe');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'i'.repeat(32)}`);
    expect(JSON.parse(init?.body as string)).toEqual({
      server: {
        id: 'mcp_1',
        organizationId: 'org_1',
        slug: 'docs',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        enabled: false,
        headers: 'v1:encrypted-headers',
        forwardIdentity: true,
        timeoutMs: 20_000,
      },
    });
  });

  it('passes a failed test through and keeps the agent name of an A2A agent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({ ok: false, latencyMs: 5, tools: [], error: 'x'.repeat(900) }),
        ),
      ),
    );
    const failed = await service().mcp.test(ctx, 'mcp_1');
    expect(failed.ok).toBe(false);
    expect(failed.error).toHaveLength(500);

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({ ok: true, latencyMs: 9, tools: [{ name: 'Echo' }], agentName: 'Echo' }),
        ),
      ),
    );
    expect(await service({ ...ROW, transport: 'a2a' }).mcp.test(ctx, 'mcp_1')).toMatchObject({
      agentName: 'Echo',
      tools: [{ name: 'Echo' }],
    });
  });

  it('reports an unreachable gateway and an unknown server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    await expect(service().mcp.test(ctx, 'mcp_1')).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))),
    );
    await expect(service().mcp.test(ctx, 'mcp_1')).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    await expect(service(null).mcp.test(ctx, 'mcp_x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
