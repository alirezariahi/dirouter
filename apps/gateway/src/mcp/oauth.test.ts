/**
 * OAuth-protected upstream MCP servers (card 28.1), against the mock's OAuth 2.1 authorization
 * server: discovery (RFC 9728 and RFC 8414), client credentials, authorization code with rotating
 * refresh tokens, renewal before expiry and after a 401, Valkey sharing between replicas, and the
 * SSRF guard on discovered endpoints.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, McpOAuthConfig } from '@dirouter/contracts';
import { MOCK_OAUTH_CLIENT } from '@dirouter/mock-provider/mcp';
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
import { configureUpstreamGuard, tenantFetch, UpstreamBlocked } from '../upstream.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-oauth-key-00001';
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

interface Answer {
  result?: { content?: { text?: string }[]; resources?: { uri: string }[] };
  error?: { code: number; message: string };
}
interface Stats {
  client_credentials: number;
  authorization_code: number;
  refresh_token: number;
  rejected: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('OAuth-protected MCP servers', { timeout: 30_000 }, () => {
  const mock = buildMock();
  let mockRoot = '';
  const keyring: Keyring = parseKeyring(generateKey());
  const gateways: ReturnType<typeof buildGateway>[] = [];
  const redis: Redis[] = [];
  const run = randomBytes(4).toString('hex');

  const stats = async () => (await (await fetch(`${mockRoot}/__oauth/stats`)).json()) as Stats;
  const configure = (body: object) =>
    fetch(`${mockRoot}/__oauth/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** A refresh token from the authorization code flow, as an administrator would connect it. */
  async function connect(resource: string): Promise<string> {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(`${mockRoot}/oauth/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: MOCK_OAUTH_CLIENT.clientId,
      redirect_uri: 'http://localhost/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
      state: 's1',
    }))
      authorize.searchParams.set(k, v);
    const redirect = await fetch(authorize, { redirect: 'manual' });
    const code = new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const token = await fetch(`${mockRoot}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'http://localhost/callback',
        resource,
        client_id: MOCK_OAUTH_CLIENT.clientId,
        client_secret: MOCK_OAUTH_CLIENT.clientSecret,
      }).toString(),
    });
    return ((await token.json()) as { refresh_token: string }).refresh_token;
  }

  async function startGateway(
    servers: { id: string; slug: string; path: string; oauth: McpOAuthConfig }[],
    stateRedis?: Redis,
  ) {
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [],
      models: [],
      combos: [],
      aliases: [],
      virtualKeys: [
        {
          id: 'vk-oauth',
          hash: hashApiKey(KEY, pepper),
          prefix: 'vk-oauth',
          organizationId: 'org',
          teamId: null,
          projectId: 'prj',
          enabled: true,
          expiresAt: null,
          mcpTools: [],
        },
      ],
      mcpServers: servers.map((s) => ({
        id: s.id,
        organizationId: 'org',
        slug: s.slug,
        transport: 'streamable-http' as const,
        url: `${mockRoot}${s.path}`,
        enabled: true,
        oauth: encrypt(keyring, JSON.stringify(s.oauth), `mcp-oauth:${s.id}`),
      })),
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-mcp-oauth-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    const gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: () => undefined,
      ...(stateRedis ? { stateRedis } : {}),
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    gateways.push(gw);
    const address = gw.app.server.address();
    const base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
    return async (method: string, params: unknown) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()) as Answer;
    };
  }

  const echo = async (rpc: Awaited<ReturnType<typeof startGateway>>, tool: string, text: string) =>
    (await rpc('tools/call', { name: tool, arguments: { text } })).result?.content?.[0]?.text;

  const client = {
    clientId: MOCK_OAUTH_CLIENT.clientId,
    clientSecret: MOCK_OAUTH_CLIENT.clientSecret,
  };

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const address = mock.server.address();
    mockRoot = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
  });

  afterAll(async () => {
    for (const gw of gateways) await gw.app.close();
    for (const r of redis) r.disconnect();
    await configure({ ttlSeconds: 3600, refreshWithClientCredentials: false });
    await mock.close();
  });

  it('refuses a call without a token, as the server demands', async () => {
    const res = await fetch(`${mockRoot}/mcp-oauth/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="http://127.0.0.1:');
  });

  it('discovers the authorization server, uses client credentials and renews the token by itself', async () => {
    await configure({ ttlSeconds: 2, refreshWithClientCredentials: false });
    const rpc = await startGateway([
      {
        id: 'cc',
        slug: 'cc',
        path: '/mcp-oauth/cc',
        oauth: { grantType: 'client_credentials', ...client },
      },
    ]);
    const before = await stats();
    expect(await echo(rpc, 'cc__echo', 'one')).toBe('one');
    expect(await echo(rpc, 'cc__echo', 'two')).toBe('two');
    const first = await stats();
    // One token for both calls (and the initialize behind them).
    expect(first.client_credentials - before.client_credentials).toBe(1);
    // Resources pass through the protected server too.
    expect((await rpc('resources/list', {})).result?.resources?.map((r) => r.uri)).toContain(
      'cc+mock://readme',
    );

    // Past the token's lifetime: a new one is fetched before the server could refuse it.
    await sleep(2_100);
    expect(await echo(rpc, 'cc__echo', 'three')).toBe('three');
    const second = await stats();
    expect(second.client_credentials - before.client_credentials).toBe(2);
    expect(second.rejected).toBe(first.rejected);

    // A token the server revoked early: the 401 drops it and the call goes through with a new one.
    await fetch(`${mockRoot}/__oauth/revoke`, { method: 'POST' });
    expect(await echo(rpc, 'cc__echo', 'four')).toBe('four');
    const third = await stats();
    expect(third.client_credentials - before.client_credentials).toBe(3);
    expect(third.rejected - second.rejected).toBe(1);
  });

  it('uses the refresh token a client-credentials server hands out', async () => {
    await configure({ ttlSeconds: 2, refreshWithClientCredentials: true });
    const rpc = await startGateway([
      {
        id: 'ccr',
        slug: 'ccr',
        path: '/mcp-oauth/ccr',
        oauth: {
          grantType: 'client_credentials',
          ...client,
          tokenEndpointAuthMethod: 'client_secret_post',
          scope: 'mcp',
        },
      },
    ]);
    const before = await stats();
    expect(await echo(rpc, 'ccr__echo', 'a')).toBe('a');
    await sleep(2_100);
    expect(await echo(rpc, 'ccr__echo', 'b')).toBe('b');
    const after = await stats();
    expect(after.client_credentials - before.client_credentials).toBe(1);
    expect(after.refresh_token - before.refresh_token).toBe(1);
  });

  it('keeps an authorization-code connection alive with rotating refresh tokens', async () => {
    await configure({ ttlSeconds: 2, refreshWithClientCredentials: false });
    const refreshToken = await connect(`${mockRoot}/mcp-oauth/linked`);
    const rpc = await startGateway([
      {
        id: 'linked',
        slug: 'linked',
        path: '/mcp-oauth/linked',
        // Issuer given: protected resource metadata is skipped, RFC 8414 discovery still runs.
        oauth: {
          grantType: 'authorization_code',
          ...client,
          issuer: `${mockRoot}/oauth`,
          refreshToken,
        },
      },
      {
        id: 'unlinked',
        slug: 'unlinked',
        path: '/mcp-oauth/unlinked',
        oauth: { grantType: 'authorization_code', ...client },
      },
    ]);
    const before = await stats();
    expect(await echo(rpc, 'linked__echo', 'first')).toBe('first');
    // Each refresh rotates the token; the old one no longer works at the server, so passing the
    // second and third renewals proves the gateway kept the newest.
    for (const text of ['second', 'third']) {
      await sleep(2_100);
      expect(await echo(rpc, 'linked__echo', text)).toBe(text);
    }
    const after = await stats();
    expect(after.refresh_token - before.refresh_token).toBe(3);
    expect(after.client_credentials).toBe(before.client_credentials);

    const unlinked = await rpc('tools/call', { name: 'unlinked__echo', arguments: { text: 'x' } });
    expect(unlinked.error?.message).toMatch(/not connected yet/);
  });

  it.skipIf(!VALKEY_URL)('shares tokens between replicas through Valkey', async () => {
    await configure({ ttlSeconds: 3, refreshWithClientCredentials: false });
    const id = `shared-${run}`;
    const servers = [
      {
        id,
        slug: 'shared',
        path: '/mcp-oauth/shared',
        oauth: { grantType: 'client_credentials' as const, ...client },
      },
    ];
    const a = new Redis(VALKEY_URL ?? '');
    const b = new Redis(VALKEY_URL ?? '');
    redis.push(a, b);
    const one = await startGateway(servers, a);
    const two = await startGateway(servers, b);
    const before = await stats();
    expect(await echo(one, 'shared__echo', 'from one')).toBe('from one');
    expect(await echo(two, 'shared__echo', 'from two')).toBe('from two');
    expect((await stats()).client_credentials - before.client_credentials).toBe(1);
    // The token is stored encrypted, never in the clear.
    const keys = await a.keys(`mcp:oauth:at:${id}:*`);
    expect(keys).toHaveLength(1);
    expect(await a.get(keys[0] ?? '')).toMatch(/^v\d+\./);
    await a.del(...(await a.keys(`mcp:oauth:*:${id}:*`)));
  });

  it('keeps discovered OAuth endpoints of customer organizations on public addresses', async () => {
    configureUpstreamGuard({ enabled: true, platformOrganizationId: () => 'platform' });
    try {
      await expect(tenantFetch('customer')(`${mockRoot}/__oauth/stats`)).rejects.toBeInstanceOf(
        UpstreamBlocked,
      );
      await expect(tenantFetch('customer')('http://localhost:1/x')).rejects.toThrow();
      expect((await tenantFetch('platform')(`${mockRoot}/__oauth/stats`)).status).toBe(200);
    } finally {
      configureUpstreamGuard({ enabled: false, platformOrganizationId: () => undefined });
    }
  });
});
