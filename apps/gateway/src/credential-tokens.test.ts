/**
 * Card 27.4 through the real gateway and the mock provider's OAuth endpoints: a Vertex
 * service-account key and Azure Entra ID client credentials are exchanged for access tokens,
 * tokens are refreshed before expiry, and a failed exchange cools down only that credential.
 * The RSA key is generated at test time; no key material is committed.
 */
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ConfigSnapshotInput, ProviderConfig } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { oauthTokenPlan, TokenCache } from '@dirouter/providers';

import { credentialTokens, resolveCredentialKey, tokenFailure } from './credential-tokens.js';
import { probeProvider } from './probe.js';
import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const KEY = 'dr-test-oauth';
const mock = buildMock();
let mockUrl = '';
let base = '';
let gw: ReturnType<typeof buildGateway>;

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const serviceAccount = JSON.stringify({
  type: 'service_account',
  project_id: 'demo',
  private_key_id: 'test-kid',
  private_key: pem,
  client_email: 'gateway@demo.iam.gserviceaccount.com',
});
const entra = (clientId: string) =>
  JSON.stringify({ tenantId: 'contoso', clientId, clientSecret: 'test-client-secret' });

const cred = (id: string, secret: string) => ({
  id,
  name: id,
  secret: encrypt(keyring, secret, id),
  enabled: true,
});
const model = (id: string, providerId: string, upstreamModel: string) => ({
  id,
  organizationId: 'org',
  slug: id,
  providerId,
  upstreamModel,
  enabled: true,
  contextWindow: 100_000,
  pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
  capabilities: {},
});

const oauthStats = async () =>
  (await (await fetch(`${mockUrl}/__mock/oauth`)).json()) as {
    byIdentity: Record<string, number>;
    refused: number;
  };
const setTtl = (ttlSeconds: number) =>
  fetch(`${mockUrl}/__mock/oauth`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true, ttlSeconds }),
  });

const azureProvider = () => ({
  id: 'az',
  organizationId: 'org',
  slug: 'az',
  type: 'azure-openai' as const,
  name: 'az',
  baseUrl: mockUrl,
  enabled: true,
  options: { authMode: 'entra', authorityHost: mockUrl },
  credentials: [cred('az-bad', entra('fail-app')), cred('az-good', entra('good-app'))],
});

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const addr = mock.server.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const snapshot: ConfigSnapshotInput = {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      {
        id: 'vx',
        organizationId: 'org',
        slug: 'vx',
        type: 'vertex',
        name: 'vx',
        baseUrl: mockUrl,
        enabled: true,
        options: { project: 'demo', location: 'us-central1', tokenUrl: `${mockUrl}/oauth2/token` },
        credentials: [cred('vx-sa', serviceAccount)],
      },
      azureProvider(),
    ],
    models: [model('vertex-m', 'vx', 'gemini-mock-flash'), model('azure-m', 'az', 'gpt-dep')],
    combos: [],
    aliases: [],
    virtualKeys: [
      {
        id: 'vk',
        hash: hashApiKey(KEY, pepper),
        prefix: 'dr-test',
        organizationId: 'org',
        teamId: null,
        projectId: 'prj',
        enabled: true,
        expiresAt: null,
      },
    ],
    settings: { defaultRetry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 } },
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-oauth-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
  gw = buildGateway({
    logger: createLogger({ service: 'test', level: 'silent' }),
    keyring,
    pepper,
    dataDir,
    emitUsage: () => undefined,
    internalToken: 'i'.repeat(32),
  });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const gaddr = gw.app.server.address();
  base = `http://127.0.0.1:${typeof gaddr === 'object' && gaddr ? gaddr.port : 0}`;
});

afterAll(async () => {
  await gw.app.close();
  await mock.close();
  credentialTokens.clear();
});

const chat = (model: string) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });

describe('Vertex service account (card 27.4)', () => {
  it('obtains a token with the signed JWT, caches it and refreshes it before expiry', async () => {
    credentialTokens.clear();
    await setTtl(2);
    expect((await chat('vertex-m')).status).toBe(200);
    expect((await chat('vertex-m')).status).toBe(200);
    // Both calls used one cached token.
    expect((await oauthStats()).byIdentity['gateway@demo.iam.gserviceaccount.com']).toBe(1);

    // Past half of the 2 s lifetime the token is refreshed, while the old one is still valid.
    await new Promise((r) => setTimeout(r, 1_200));
    expect((await chat('vertex-m')).status).toBe(200);
    expect((await oauthStats()).byIdentity['gateway@demo.iam.gserviceaccount.com']).toBe(2);

    // Well past the first token's expiry the gateway still works: it never sent an expired token.
    await new Promise((r) => setTimeout(r, 1_200));
    expect((await chat('vertex-m')).status).toBe(200);
    expect((await oauthStats()).refused).toBe(0);
    // The upstream received the access token, never the JSON key.
    const upstreamKeys = Object.keys(
      ((await (await fetch(`${mockUrl}/__mock/stats`)).json()) as { byKey: object }).byKey,
    );
    expect(upstreamKeys.every((k) => k.startsWith('Bearer mock-oauth-google-'))).toBe(true);
    await setTtl(3600);
  });
});

describe('Azure OpenAI with Entra ID (card 27.4)', () => {
  it('a failed token exchange cools down only that credential, not the provider', async () => {
    credentialTokens.clear();
    // Credentials are picked at random: call until the failing one has been tried once.
    const triedBad = () => gw.health.report().credentials.some((c) => c.credentialId === 'az-bad');
    let calls = 0;
    while (calls < 6 || (!triedBad() && calls < 40)) {
      expect((await chat('azure-m')).status).toBe(200);
      calls++;
    }

    const report = gw.health.report();
    const bad = report.credentials.find((c) => c.credentialId === 'az-bad');
    const good = report.credentials.find((c) => c.credentialId === 'az-good');
    expect(bad?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(bad?.disabledUntil).toBeUndefined();
    expect(good?.cooldownUntil).toBeUndefined();
    expect(gw.health.providerBreaker('az').state).toBe('closed');
    expect(gw.health.credentialAvailable('az-good', 'azure-m')).toBe(true);

    const stats = await oauthStats();
    // The good credential got one token for every call; the failing one never got a token.
    expect(stats.byIdentity['contoso/good-app']).toBe(1);
    expect(stats.byIdentity['contoso/fail-app']).toBeUndefined();
  });

  it('the connection test reports a failed exchange instead of calling the model', async () => {
    const provider = azureProvider();
    const result = await probeProvider({ provider, credentialId: 'az-bad' }, keyring);
    expect(result.ok).toBe(false);
    expect(result.error?.class).toBe('auth');
    expect(result.error?.message).toMatch(/token endpoint returned 401 invalid_client/);
    expect(result.error?.message).not.toContain('test-client-secret');
  });
});

describe('shared token exchange', () => {
  it('a caller that aborts does not fail the exchange for the others or blame the credential', async () => {
    let release: () => void = () => undefined;
    let exchanges = 0;
    const slow = createServer((_req, res) => {
      exchanges++;
      release = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'shared-token', expires_in: 3600 }));
      };
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const addr = slow.address();
    const tokenUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/token`;
    try {
      const provider = ProviderConfig.parse({
        ...azureProvider(),
        options: { authMode: 'entra', tokenUrl },
        credentials: [],
      });
      const cache = new TokenCache();
      const gone = new AbortController();
      const first = resolveCredentialKey(provider, { id: 'az-x' }, entra('x'), {
        signal: gone.signal,
        cache,
      });
      const second = resolveCredentialKey(provider, { id: 'az-x' }, entra('x'), {
        signal: new AbortController().signal,
        cache,
      });
      while (exchanges === 0) await new Promise((r) => setTimeout(r, 5));
      gone.abort(new Error('client disconnected'));
      const firstError = await first.catch((error: unknown) => error);
      release();
      expect(await second).toBe('shared-token');
      expect(exchanges).toBe(1);
      const failure = tokenFailure(firstError);
      expect(failure.credentialAction).toBeUndefined();
      expect(failure.class).not.toBe('auth');
    } finally {
      await new Promise((r) => slow.close(r));
    }
  });

  it('drops the cached token once the upstream rejects it with 401', async () => {
    const plan = oauthTokenPlan(
      { type: 'vertex', options: { project: 'demo', location: 'us-central1' } },
      'vx-sa',
      serviceAccount,
    );
    expect((await chat('vertex-m')).status).toBe(200);
    expect(credentialTokens.peek(plan!.cacheKey)).toBeDefined();
    await fetch(`${mockUrl}/__mock/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directives: 'status=401' }),
    });
    try {
      expect((await chat('vertex-m')).status).not.toBe(200);
      expect(credentialTokens.peek(plan!.cacheKey)).toBeUndefined();
    } finally {
      await fetch(`${mockUrl}/__mock/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directives: '' }),
      });
    }
  });
});
