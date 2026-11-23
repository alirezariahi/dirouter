/** DiRouter's admin MCP server (card 20.2): explicit per-key access, write tools only with write. */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';

interface Answer {
  result?: {
    tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    protocolVersion?: string;
  };
  error?: { code: number; message: string };
}

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('admin MCP server', () => {
  let app: NestFastifyApplication;
  let owner = '';
  let org = '';
  let project = '';
  const keys: Record<string, string> = {};

  const inject = (method: string, url: string, token: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'POST',
        url: `/api/v1/${url}`,
        headers: { authorization: `Bearer ${token}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });
  const mcp = async (key: string, method: string, params?: Record<string, unknown>) => {
    const res = await inject('POST', 'mcp', key, { jsonrpc: '2.0', id: 1, method, params });
    return { status: res.statusCode, body: res.json<Answer>() };
  };
  const tools = async (key: string) =>
    ((await mcp(key, 'tools/list')).body.result?.tools ?? []).map((t) => t.name).sort();

  beforeAll(async () => {
    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        VALKEY_URL,
        MASTER_KEY: generateKey(),
        KEY_PEPPER: 'q'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
        GATEWAY_INTERNAL_URL: 'http://127.0.0.1:1',
      }),
    );
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, users, api_keys, projects, models, providers, wallet_transactions, wallets, organizations CASCADE',
      );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    owner = (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            organizationName: 'Admin MCP',
            name: 'O',
            email: 'amcp@example.com',
            password: PW,
          },
        })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (await inject('GET', 'auth/me', owner)).json<{ organizations: { id: string }[] }>()
        .organizations[0]?.id ?? '';
    project = (await inject('POST', `orgs/${org}/projects`, owner, { name: 'Agents' })).json<{
      id: string;
    }>().id;
    const provider = (
      await inject('POST', `orgs/${org}/providers`, owner, {
        name: 'Up',
        type: 'openai',
        credentials: [{ name: 'k', secret: 'sk-x' }],
      })
    ).json<{ id: string }>().id;
    for (const slug of ['team/fast', 'team/smart'])
      await inject('POST', `orgs/${org}/models`, owner, {
        providerId: provider,
        upstreamModel: slug,
        slug,
        pricing: { inputPerMTok: '1', outputPerMTok: '2' },
      });
    for (const [name, mcpAdmin, allowedModels] of [
      ['none', undefined, []],
      ['read', 'read', []],
      ['write', 'write', ['team/fast']],
    ] as const) {
      const res = await inject('POST', `orgs/${org}/keys`, owner, {
        name,
        projectId: project,
        allowedModels,
        ...(mcpAdmin ? { mcpAdmin } : {}),
      });
      keys[name] = res.json<{ key: string }>().key;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('only owners and admins grant MCP admin access', async () => {
    const invite = (
      await inject('POST', `orgs/${org}/invitations`, owner, {
        email: 'member@example.com',
        role: 'MEMBER',
      })
    ).json<{ token: string }>();
    const member = (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/invitations/accept',
          payload: { token: invite.token, name: 'M', password: PW },
        })
    ).json<{ accessToken: string }>().accessToken;
    const denied = await inject('POST', `orgs/${org}/keys`, member, {
      name: 'x',
      projectId: project,
      mcpAdmin: 'write',
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (await inject('POST', `orgs/${org}/keys`, member, { name: 'plain', projectId: project }))
        .statusCode,
    ).toBe(201);
  });

  it('a key without access is refused; read sees only read tools', async () => {
    expect((await mcp(keys.none ?? '', 'initialize')).status).toBe(403);
    expect((await mcp('dr-not-a-real-key-000', 'initialize')).status).toBe(401);
    const init = await mcp(keys.read ?? '', 'initialize', { protocolVersion: '2025-03-26' });
    expect(init.body.result?.protocolVersion).toBe('2025-03-26');
    expect(await tools(keys.read ?? '')).toEqual([
      'health_status',
      'list_models',
      'simulate_route',
      'usage_summary',
    ]);
    const write = await mcp(keys.read ?? '', 'tools/call', {
      name: 'create_api_key',
      arguments: { name: 'x' },
    });
    expect(write.body.error).toEqual({ code: -32602, message: 'Unknown tool: create_api_key' });
  });

  it('read tools answer from the organization', async () => {
    const models = await mcp(keys.read ?? '', 'tools/call', { name: 'list_models', arguments: {} });
    expect(models.body.result?.structuredContent).toMatchObject({
      models: [
        { name: 'team/fast', priceUsd: { inputPerMTok: '1.000000', outputPerMTok: '2.000000' } },
        { name: 'team/smart' },
      ],
    });
    // The write key is restricted to one model and sees only that one.
    const restricted = await mcp(keys.write ?? '', 'tools/call', {
      name: 'list_models',
      arguments: {},
    });
    expect((restricted.body.result?.structuredContent?.models as unknown[]).length).toBe(1);
    const usage = await mcp(keys.read ?? '', 'tools/call', {
      name: 'usage_summary',
      arguments: { days: 7 },
    });
    expect(usage.body.result?.structuredContent).toMatchObject({
      scope: 'key',
      days: 7,
      usage: { requests: 0 },
    });
    // The gateway is not running in this test: the tool reports it as a tool error.
    const sim = await mcp(keys.read ?? '', 'tools/call', {
      name: 'simulate_route',
      arguments: { model: 'team/fast' },
    });
    expect(sim.body.result?.isError).toBe(true);
  });

  it('write creates a narrower, expiring key that the gateway will know', async () => {
    expect(await tools(keys.write ?? '')).toContain('create_api_key');
    const tooWide = await mcp(keys.write ?? '', 'tools/call', {
      name: 'create_api_key',
      arguments: { name: 'child', allowedModels: ['team/smart'] },
    });
    expect(tooWide.body.error?.code).toBe(-32602);
    const created = await mcp(keys.write ?? '', 'tools/call', {
      name: 'create_api_key',
      arguments: { name: 'child', expiresInDays: 7 },
    });
    const child = created.body.result?.structuredContent as {
      id: string;
      key: string;
      expiresAt: string;
      allowedModels: string[];
    };
    expect(child.key).toMatch(/^dr-/);
    expect(child.allowedModels).toEqual(['team/fast']);
    expect(Date.parse(child.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const row = await app
      .get(PrismaService)
      .client.apiKey.findUniqueOrThrow({ where: { id: child.id } });
    expect(row).toMatchObject({ mcpAdmin: 'none', projectId: project });
    // The child has no access to this server.
    expect((await mcp(child.key, 'initialize')).status).toBe(403);
    expect(
      (await app.get(SnapshotService).build()).virtualKeys.some((k) => k.id === child.id),
    ).toBe(true);
    const audit = await app
      .get(PrismaService)
      .client.auditLog.findFirst({ where: { action: 'mcp_admin.key_created' } });
    expect(audit?.targetId).toBe(child.id);
  });
});
