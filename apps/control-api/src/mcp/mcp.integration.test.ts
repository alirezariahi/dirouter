/** MCP servers, the key tool allowlist, the snapshot and the call log (card 20.1). */
import { MOCK_OAUTH_CLIENT } from '@dirouter/mock-provider/mcp';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
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

  it('keeps a shared OAuth credential write-only and connects it by authorization code (card 28.1)', async () => {
    const mock = buildMock();
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const address = mock.server.address();
    const mockRoot = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
    try {
      const created = await call('POST', 'mcp/servers', {
        name: 'Protected',
        slug: 'protected',
        url: `${mockRoot}/mcp-oauth/protected`,
        oauth: {
          grantType: 'authorization_code',
          clientId: MOCK_OAUTH_CLIENT.clientId,
          clientSecret: MOCK_OAUTH_CLIENT.clientSecret,
          scope: 'mcp',
        },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json<{ id: string }>().id;
      expect(created.json()).toMatchObject({
        oauth: { grantType: 'authorization_code', hasClientSecret: true, connected: false },
      });
      expect(created.body).not.toContain(MOCK_OAUTH_CLIENT.clientSecret);

      // Discovery from the server URL, PKCE S256, the resource indicator and a sealed state.
      const started = await call('POST', `mcp/servers/${id}/oauth/authorize`, {
        redirectUri: 'http://localhost:5173/mcp/callback',
      });
      expect(started.statusCode).toBe(200);
      const authorizationUrl = new URL(
        started.json<{ authorizationUrl: string }>().authorizationUrl,
      );
      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
        `${mockRoot}/oauth/authorize`,
      );
      expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
        response_type: 'code',
        client_id: MOCK_OAUTH_CLIENT.clientId,
        code_challenge_method: 'S256',
        resource: `${mockRoot}/mcp-oauth/protected`,
        scope: 'mcp',
      });
      // The administrator approves; the authorization server sends the browser back.
      const back = new URL(
        (await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location') ?? '',
      );
      const code = back.searchParams.get('code') ?? '';
      const state = back.searchParams.get('state') ?? '';
      expect(
        (await call('POST', `mcp/servers/${id}/oauth/callback`, { code, state: `${state}x` }))
          .statusCode,
      ).toBe(422);
      const connected = await call('POST', `mcp/servers/${id}/oauth/callback`, { code, state });
      expect(connected.statusCode).toBe(200);
      expect(connected.json()).toMatchObject({ oauth: { connected: true } });

      // The snapshot carries the credential encrypted, refresh token included.
      const snapshot = await app.get(SnapshotService).build();
      const entry = snapshot.mcpServers?.find((s) => s.id === id);
      expect(entry?.oauth).toBeDefined();
      expect(JSON.stringify(snapshot)).not.toContain(MOCK_OAUTH_CLIENT.clientSecret);
      const sealed = JSON.parse(
        decrypt(parseKeyring(MASTER_KEY), entry?.oauth ?? '', `mcp-oauth:${id}`),
      ) as { refreshToken?: string };
      expect(sealed.refreshToken).toMatch(/^rt-/);

      // A new client secret keeps the connection; removing the credential drops it.
      const rotated = await call('PATCH', `mcp/servers/${id}`, {
        oauth: {
          grantType: 'authorization_code',
          clientId: MOCK_OAUTH_CLIENT.clientId,
          clientSecret: 'another-secret',
        },
      });
      expect(rotated.json()).toMatchObject({ oauth: { connected: true } });
      const audit = await app.get(PrismaService).client.auditLog.findFirst({
        where: { action: 'mcp_server.updated', targetId: id },
      });
      expect(JSON.stringify(audit?.diff)).not.toContain('another-secret');
      const removed = await call('PATCH', `mcp/servers/${id}`, { oauth: null });
      expect(removed.json()).toMatchObject({ oauth: null });
      expect(
        (
          await call('POST', `mcp/servers/${id}/oauth/authorize`, {
            redirectUri: 'http://x.test/cb',
          })
        ).statusCode,
      ).toBe(422);
      expect((await call('DELETE', `mcp/servers/${id}`)).statusCode).toBe(204);
    } finally {
      await mock.close();
    }
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
