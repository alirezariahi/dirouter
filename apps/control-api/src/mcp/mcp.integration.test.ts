/** MCP servers, the key tool allowlist, the snapshot and the call log (card 20.1). */
import { decrypt, generateKey, parseKeyring } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const MASTER_KEY = generateKey();

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('MCP servers over HTTP', () => {
  let app: NestFastifyApplication;
  let token = '';
  let org = '';
  let serverId = '';

  const call = (method: string, url: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url: `/api/v1/orgs/${org}/${url}`,
        headers: { authorization: `Bearer ${token}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });

  beforeAll(async () => {
    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        VALKEY_URL,
        MASTER_KEY,
        KEY_PEPPER: 'q'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
      }),
    );
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, mcp_servers, mcp_tool_calls, wallet_transactions, wallets, organizations CASCADE',
      );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    token = (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            organizationName: 'MCP',
            name: 'O',
            email: 'mcp@example.com',
            password: 'a-long-enough-password',
          },
        })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (
        await app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: 'GET',
            url: '/api/v1/auth/me',
            headers: { authorization: `Bearer ${token}` },
          })
      ).json<{ organizations: { id: string }[] }>().organizations[0]?.id ?? '';
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers a server; header values are encrypted and never returned', async () => {
    const res = await call('POST', 'mcp/servers', {
      name: 'GitHub',
      slug: 'github',
      url: 'http://mcp.internal:8080/mcp',
      headers: { Authorization: 'Bearer ghp_secret' },
      forwardIdentity: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      slug: 'github',
      transport: 'streamable-http',
      hasHeaders: true,
    });
    expect(res.body).not.toContain('ghp_secret');
    serverId = res.json<{ id: string }>().id;
    const row = await app
      .get(PrismaService)
      .client.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    expect(row.headersEnc).not.toContain('ghp_secret');
    expect(
      JSON.parse(decrypt(parseKeyring(MASTER_KEY), row.headersEnc ?? '', `mcp:${serverId}`)),
    ).toEqual({
      Authorization: 'Bearer ghp_secret',
    });
    expect(
      (await call('POST', 'mcp/servers', { name: 'Dup', slug: 'github', url: 'http://x.test/mcp' }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', 'mcp/servers', {
          name: 'Bad',
          slug: 'Bad Slug',
          url: 'http://x.test/mcp',
        })
      ).statusCode,
    ).toBe(422);
  });

  it('the snapshot carries servers (headers still encrypted) and each key its tool allowlist', async () => {
    const project = (await call('POST', 'projects', { name: 'P' })).json<{ id: string }>().id;
    const key = await call('POST', 'keys', {
      name: 'agent',
      projectId: project,
      mcpTools: ['github__*', 'fs__read_file'],
    });
    expect(key.statusCode).toBe(201);
    expect(key.json()).toMatchObject({ mcpTools: ['github__*', 'fs__read_file'] });
    expect(
      (await call('POST', 'keys', { name: 'x', projectId: project, mcpTools: ['no prefix'] }))
        .statusCode,
    ).toBe(422);
    const snapshot = await app.get(SnapshotService).build();
    expect(snapshot.mcpServers).toEqual([
      expect.objectContaining({
        id: serverId,
        slug: 'github',
        enabled: true,
        forwardIdentity: true,
        timeoutMs: 60_000,
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('ghp_secret');
    expect(
      snapshot.virtualKeys.find((k) => k.id === key.json<{ id: string }>().id)?.mcpTools,
    ).toEqual(['github__*', 'fs__read_file']);
  });

  it('updates and deletes; a deleted server leaves the snapshot', async () => {
    const patched = await call('PATCH', `mcp/servers/${serverId}`, {
      headers: null,
      timeoutMs: 5_000,
    });
    expect(patched.json()).toMatchObject({ hasHeaders: false, timeoutMs: 5_000 });
    const audit = await app.get(PrismaService).client.auditLog.findFirst({
      where: { action: 'mcp_server.updated', targetId: serverId },
    });
    expect(audit?.diff).toEqual({ headers: 'removed', timeoutMs: 5_000 });
    expect((await call('DELETE', `mcp/servers/${serverId}`)).statusCode).toBe(204);
    expect((await app.get(SnapshotService).build()).mcpServers).toEqual([]);
  });

  it('lists the calls the worker logged, filtered by status', async () => {
    const db = app.get(PrismaService).client;
    for (const [i, status] of ['success', 'denied', 'error'].entries())
      await db.mcpToolCall.create({
        data: {
          id: `call-${String(i)}`,
          occurredAt: new Date(Date.now() - i * 1_000),
          organizationId: org,
          projectId: 'p',
          apiKeyId: 'k',
          serverId,
          tool: 'search',
          arguments: { query: 'x', token: '***' },
          status,
          latencyMs: 12,
          gatewayInstance: 'gw',
        },
      });
    const all = (await call('GET', 'mcp/calls')).json<{ status: string }[]>();
    expect(all.map((c) => c.status)).toEqual(['success', 'denied', 'error']);
    expect((await call('GET', 'mcp/calls?status=denied')).json()).toEqual([
      expect.objectContaining({
        id: 'call-1',
        tool: 'search',
        arguments: { query: 'x', token: '***' },
      }),
    ]);
  });
});
