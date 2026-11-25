/**
 * Card 27.4: service-account JWT, Entra client credentials, token cache and refresh.
 * The RSA key pair is generated at test time; no key material is committed.
 */
import { generateKeyPairSync, createVerify } from 'node:crypto';

import type { ProviderConfig } from '@dirouter/contracts';
import { describe, expect, it, vi } from 'vitest';

import { adapterForProvider } from './adapters.js';
import {
  AZURE_COGNITIVE_SCOPE,
  GOOGLE_CLOUD_SCOPE,
  GOOGLE_TOKEN_URL,
  TokenCache,
  TokenWaitAborted,
  TokenExchangeError,
  buildServiceAccountJwt,
  oauthKind,
  oauthTokenPlan,
  parseEntraCredentials,
  parseServiceAccount,
  parseTokenResponse,
} from './oauth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const serviceAccount = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'demo',
    private_key_id: 'kid-1',
    private_key: pem,
    client_email: 'gateway@demo.iam.gserviceaccount.com',
    ...over,
  });

const entraSecret = JSON.stringify({
  tenantId: 'contoso.onmicrosoft.com',
  clientId: 'app-id',
  clientSecret: 'app-secret',
});

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p',
  organizationId: 'o',
  slug: 's',
  type: 'vertex',
  name: 'n',
  baseUrl: 'https://us-central1-aiplatform.googleapis.com',
  enabled: true,
  options: { project: 'demo' },
  credentials: [],
  ...over,
});

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('service-account JWT', () => {
  it('parses the key file and signs an RS256 assertion Google accepts', () => {
    const key = parseServiceAccount(serviceAccount());
    expect(key).toMatchObject({ clientEmail: 'gateway@demo.iam.gserviceaccount.com' });
    const jwt = buildServiceAccountJwt(key!, {
      audience: GOOGLE_TOKEN_URL,
      scope: GOOGLE_CLOUD_SCOPE,
      nowS: 1_700_000_000,
    });
    const [h, c, s] = jwt.split('.');
    expect(decode(h!)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    expect(decode(c!)).toEqual({
      iss: 'gateway@demo.iam.gserviceaccount.com',
      scope: GOOGLE_CLOUD_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const ok = createVerify('RSA-SHA256')
      .update(`${h!}.${c!}`)
      .verify(publicKey, Buffer.from(s!, 'base64url'));
    expect(ok).toBe(true);
  });

  it('rejects a key file without a private key and a broken key', () => {
    expect(() => parseServiceAccount(serviceAccount({ private_key: '' }))).toThrow(
      TokenExchangeError,
    );
    expect(parseServiceAccount('ya29.token')).toBeUndefined();
    const broken = parseServiceAccount(serviceAccount({ private_key: 'not a key' }))!;
    expect(() => buildServiceAccountJwt(broken, { audience: 'a', scope: 's', nowS: 1 })).toThrow(
      /not a valid RSA key/,
    );
  });
});

describe('token request plans', () => {
  it('detects a Vertex service account and builds a JWT-bearer form', () => {
    const plan = oauthTokenPlan(provider(), 'cred-1', serviceAccount())!;
    expect(plan.kind).toBe('google-service-account');
    const req = plan.build(1_700_000_000_000);
    expect(req.url).toBe(GOOGLE_TOKEN_URL);
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(req.body);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(decode(body.get('assertion')!.split('.')[1]!).aud).toBe(GOOGLE_TOKEN_URL);
  });

  it('lets options.tokenUrl point at another endpoint (the JWT audience follows)', () => {
    const plan = oauthTokenPlan(
      provider({ options: { project: 'demo', tokenUrl: 'http://mock/oauth2/token' } }),
      'cred-1',
      serviceAccount(),
    )!;
    const req = plan.build(Date.now());
    expect(req.url).toBe('http://mock/oauth2/token');
    const claims = decode(new URLSearchParams(req.body).get('assertion')!.split('.')[1]!);
    expect(claims.aud).toBe('http://mock/oauth2/token');
  });

  it('keeps a plain access token and apiKey mode untouched', () => {
    expect(oauthTokenPlan(provider(), 'c', 'ya29.token')).toBeUndefined();
    expect(
      oauthKind(provider({ options: { project: 'p', authMode: 'apiKey' } }), serviceAccount()),
    ).toBeUndefined();
    expect(() =>
      oauthTokenPlan(provider({ options: { project: 'p', authMode: 'serviceAccount' } }), 'c', 'x'),
    ).toThrow(TokenExchangeError);
  });

  it('builds the Entra v2 client-credentials request for Azure OpenAI', () => {
    const azure = provider({
      type: 'azure-openai',
      baseUrl: 'https://res.openai.azure.com',
      options: { authMode: 'entra' },
    });
    const plan = oauthTokenPlan(azure, 'cred-2', entraSecret)!;
    const req = plan.build(Date.now());
    expect(req.url).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    );
    const body = new URLSearchParams(req.body);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'app-id',
      client_secret: 'app-secret',
      scope: AZURE_COGNITIVE_SCOPE,
    });
    const sovereign = oauthTokenPlan(
      { ...azure, options: { authMode: 'entra', authorityHost: 'https://login.example.cn/' } },
      'cred-2',
      entraSecret,
    )!;
    expect(sovereign.build(0).url).toBe(
      'https://login.example.cn/contoso.onmicrosoft.com/oauth2/v2.0/token',
    );
    // A plain resource key is not an OAuth credential.
    expect(oauthTokenPlan({ ...azure, options: {} }, 'c', 'resource-key')).toBeUndefined();
  });

  it('rejects incomplete Entra credentials and a hostile tenant id', () => {
    expect(() => parseEntraCredentials('{"tenantId":"t","clientId":"c"}')).toThrow();
    expect(() =>
      parseEntraCredentials('{"tenantId":"../evil","clientId":"c","clientSecret":"s"}'),
    ).toThrow(/tenant/);
    expect(parseEntraCredentials('{"tenant_id":"t","client_id":"c","client_secret":"s"}')).toEqual({
      tenantId: 't',
      clientId: 'c',
      clientSecret: 's',
    });
  });

  it('gives a rotated secret a different cache key', () => {
    const a = oauthTokenPlan(provider(), 'cred', serviceAccount())!;
    const b = oauthTokenPlan(provider(), 'cred', serviceAccount({ private_key_id: 'kid-2' }))!;
    expect(a.cacheKey).not.toBe(b.cacheKey);
  });

  it('sends the Entra token as Bearer instead of api-key', () => {
    const azure = provider({
      type: 'azure-openai',
      baseUrl: 'https://res.openai.azure.com',
      options: { authMode: 'entra' },
    });
    const built = adapterForProvider(azure).buildRequest({
      provider: azure,
      model: {
        id: 'm',
        slug: 'gpt',
        providerId: 'p',
        upstreamModel: 'dep',
        capabilities: [],
        enabled: true,
      } as never,
      apiKey: 'eyJ.token',
      request: { inboundApi: 'openai.chat', model: 'gpt', system: [], messages: [], stream: false },
    });
    expect(built.headers.authorization).toBe('Bearer eyJ.token');
    expect(built.headers['api-key']).toBeUndefined();
    expect(adapterForProvider(azure).listModelsRequest(azure, 'eyJ.token').headers).toEqual({
      authorization: 'Bearer eyJ.token',
    });
  });
});

describe('token responses', () => {
  it('reads access_token and expires_in', () => {
    expect(parseTokenResponse(200, { access_token: 't', expires_in: 3599 }, 1000)).toEqual({
      token: 't',
      expiresAt: 1000 + 3_599_000,
    });
  });

  it('turns OAuth error bodies into a TokenExchangeError', () => {
    expect(() =>
      parseTokenResponse(400, { error: 'invalid_grant', error_description: 'bad jwt' }, 0),
    ).toThrow('token endpoint returned 400 invalid_grant: bad jwt');
    expect(() => parseTokenResponse(200, { access_token: 't' }, 0)).toThrow(/expires_in/);
  });
});

describe('TokenCache', () => {
  const token = (value: string, now: number, ttlS = 3600) => ({
    token: value,
    expiresAt: now + ttlS * 1000,
  });

  it('caches the token and refreshes it before expiry', async () => {
    let now = 0;
    const cache = new TokenCache({ clock: () => now, refreshSkewMs: 300_000 });
    let n = 0;
    const fetchToken = vi.fn(() => Promise.resolve(token(`t${String(++n)}`, now)));

    expect(await cache.get('k', fetchToken)).toBe('t1');
    now = 3_000_000; // 50 minutes: still fresh
    expect(await cache.get('k', fetchToken)).toBe('t1');
    expect(fetchToken).toHaveBeenCalledTimes(1);

    now = 3_301_000; // 55 min + 1 s: inside the 5-minute refresh window, token not yet expired
    expect(cache.peek('k')!.expiresAt).toBeGreaterThan(now);
    expect(await cache.get('k', fetchToken)).toBe('t2');
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(cache.peek('k')!.expiresAt).toBe(3_301_000 + 3_600_000);
  });

  it('refreshes short-lived tokens at half their lifetime', async () => {
    let now = 0;
    const cache = new TokenCache({ clock: () => now });
    let n = 0;
    const fetchToken = () => Promise.resolve(token(`t${String(++n)}`, now, 60));
    await cache.get('k', fetchToken);
    now = 29_000;
    expect(await cache.get('k', fetchToken)).toBe('t1');
    now = 31_000;
    expect(await cache.get('k', fetchToken)).toBe('t2');
  });

  it('shares one refresh between concurrent callers', async () => {
    const cache = new TokenCache();
    let resolve: (v: { token: string; expiresAt: number }) => void = () => undefined;
    const fetchToken = vi.fn(
      () =>
        new Promise<{ token: string; expiresAt: number }>((r) => {
          resolve = r;
        }),
    );
    const a = cache.get('k', fetchToken);
    const b = cache.get('k', fetchToken);
    resolve(token('t', Date.now()));
    expect(await Promise.all([a, b])).toEqual(['t', 't']);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it('lets one caller stop waiting without failing the shared refresh for the others', async () => {
    const cache = new TokenCache();
    let resolve: (v: { token: string; expiresAt: number }) => void = () => undefined;
    const fetchToken = vi.fn(
      () =>
        new Promise<{ token: string; expiresAt: number }>((r) => {
          resolve = r;
        }),
    );
    const gone = new AbortController();
    const a = cache.get('k', fetchToken, gone.signal);
    const b = cache.get('k', fetchToken, new AbortController().signal);
    gone.abort(new Error('client went away'));
    await expect(a).rejects.toBeInstanceOf(TokenWaitAborted);
    resolve(token('t', Date.now()));
    expect(await b).toBe('t');
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(cache.peek('k')?.token).toBe('t');
  });

  it('drops every cached token of a credential on invalidate', async () => {
    const cache = new TokenCache();
    await cache.get('cred_1:aaaa', () => Promise.resolve(token('t1', Date.now())));
    await cache.get('cred_10:bbbb', () => Promise.resolve(token('t2', Date.now())));
    cache.invalidate('cred_1');
    expect(cache.peek('cred_1:aaaa')).toBeUndefined();
    expect(cache.peek('cred_10:bbbb')?.token).toBe('t2');
    let n = 0;
    expect(
      await cache.get('cred_1:aaaa', () =>
        Promise.resolve(token(`fresh${String(++n)}`, Date.now())),
      ),
    ).toBe('fresh1');
  });

  it('keeps a still-valid token when a refresh fails, and throws once none is valid', async () => {
    let now = 0;
    const cache = new TokenCache({ clock: () => now, retryAfterFailureMs: 10_000 });
    const fetchToken = vi.fn(() => Promise.resolve(token('t1', now)));
    await cache.get('k', fetchToken);

    const failing = vi.fn(() => Promise.reject(new TokenExchangeError('down', 503)));
    now = 3_400_000; // in the refresh window
    expect(await cache.get('k', failing)).toBe('t1');
    expect(failing).toHaveBeenCalledTimes(1);
    now += 5_000; // pause after a failure: no new attempt
    expect(await cache.get('k', failing)).toBe('t1');
    expect(failing).toHaveBeenCalledTimes(1);

    now = 3_600_001; // expired
    await expect(cache.get('k', failing)).rejects.toThrow('down');
    // Another credential is not affected.
    expect(await cache.get('other', fetchToken)).toBe('t1');
  });
});
