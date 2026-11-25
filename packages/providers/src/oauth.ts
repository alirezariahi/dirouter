/**
 * OAuth credentials for enterprise connections (card 27.4).
 *
 * - Vertex AI with a Google service-account JSON key: an RS256 JWT is signed with the private key
 *   and exchanged at the token endpoint (JWT-bearer grant, RFC 7523).
 * - Azure OpenAI with an Entra ID app registration: the v2 client-credentials grant.
 *
 * The credential secret (the JSON key or the client secret) is stored encrypted like every other
 * credential and is decrypted only in gateway memory. This module builds the token request and
 * caches the access token; HTTP execution stays in the gateway, so proxies, timeouts and the SSRF
 * guard apply to the token call too. A token is refreshed before it expires, and one in-flight
 * refresh is shared by concurrent requests.
 */
import { createHash, createSign } from 'node:crypto';

import type { ProviderConfig } from '@dirouter/contracts';

import type { UpstreamRequest } from './adapters.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
export const ENTRA_AUTHORITY = 'https://login.microsoftonline.com';
export const AZURE_COGNITIVE_SCOPE = 'https://cognitiveservices.azure.com/.default';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** Google accepts assertions valid for at most one hour. */
const JWT_LIFETIME_S = 3600;

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  tokenUri?: string;
}

export interface EntraClientCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Thrown to one caller of `TokenCache.get` whose own signal aborted while it waited for a shared
 * refresh. It says nothing about the credential: the refresh keeps running for the other waiters.
 */
export class TokenWaitAborted extends Error {
  override readonly name = 'TokenWaitAborted';
  constructor(readonly reason?: unknown) {
    super('aborted while waiting for the credential token');
  }
}

/** Thrown for a malformed credential or a failed token exchange. */
export class TokenExchangeError extends Error {
  override readonly name = 'TokenExchangeError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

function parseJsonObject(secret: string): Record<string, unknown> | undefined {
  const trimmed = secret.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Google's downloaded key file (`type: service_account`); undefined when the secret is not one. */
export function parseServiceAccount(secret: string): ServiceAccountKey | undefined {
  const json = parseJsonObject(secret);
  if (json?.type !== 'service_account') return undefined;
  const clientEmail = asString(json.client_email);
  const privateKey = asString(json.private_key);
  if (!clientEmail || !privateKey)
    throw new TokenExchangeError('service account JSON needs client_email and private_key');
  const privateKeyId = asString(json.private_key_id);
  const tokenUri = asString(json.token_uri);
  return {
    clientEmail,
    privateKey,
    ...(privateKeyId ? { privateKeyId } : {}),
    ...(tokenUri ? { tokenUri } : {}),
  };
}

/** `{"tenantId","clientId","clientSecret"}` (snake_case is accepted too). */
export function parseEntraCredentials(secret: string): EntraClientCredentials {
  const json = parseJsonObject(secret);
  const tenantId = asString(json?.tenantId) ?? asString(json?.tenant_id);
  const clientId = asString(json?.clientId) ?? asString(json?.client_id);
  const clientSecret = asString(json?.clientSecret) ?? asString(json?.client_secret);
  if (!tenantId || !clientId || !clientSecret)
    throw new TokenExchangeError(
      'Entra ID credential must be JSON with tenantId, clientId and clientSecret',
    );
  if (!/^[A-Za-z0-9.-]{1,128}$/.test(tenantId))
    throw new TokenExchangeError('Entra ID tenantId is not a tenant id or domain');
  return { tenantId, clientId, clientSecret };
}

const base64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/** Signed RS256 assertion for Google's JWT-bearer grant. */
export function buildServiceAccountJwt(
  key: ServiceAccountKey,
  options: { audience: string; scope: string; nowS: number },
): string {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(key.privateKeyId ? { kid: key.privateKeyId } : {}),
  };
  const claims = {
    iss: key.clientEmail,
    scope: options.scope,
    aud: options.audience,
    iat: options.nowS,
    exp: options.nowS + JWT_LIFETIME_S,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  let signature: Buffer;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(key.privateKey);
  } catch {
    throw new TokenExchangeError('service account private_key is not a valid RSA key');
  }
  return `${unsigned}.${base64url(signature)}`;
}

/** Which OAuth flow, if any, a provider/credential pair uses. */
export type OAuthKind = 'google-service-account' | 'entra-client-credentials' | 'ibm-iam';

/** IBM Cloud IAM: an API key is exchanged for a bearer token (watsonx.ai, card 31.6). */
export const IBM_IAM_TOKEN_URL = 'https://iam.cloud.ibm.com/identity/token';

/**
 * Vertex uses the service-account flow when `options.authMode` is `serviceAccount` or the secret
 * is a service-account JSON key; Azure OpenAI uses Entra ID when `options.authMode` is `entra`.
 */
export function oauthKind(
  provider: Pick<ProviderConfig, 'type' | 'options'>,
  secret: string,
): OAuthKind | undefined {
  const mode = provider.options.authMode;
  if (provider.type === 'vertex') {
    if (mode === 'apiKey') return undefined;
    if (mode === 'serviceAccount' || parseJsonObject(secret)?.type === 'service_account')
      return 'google-service-account';
  }
  if (provider.type === 'azure-openai' && mode === 'entra') return 'entra-client-credentials';
  if (provider.type === 'openai-compatible' && provider.options.preset === 'watsonx')
    return 'ibm-iam';
  return undefined;
}

export interface TokenRequestPlan {
  kind: OAuthKind;
  /** Stable per credential secret: a rotated secret gets a fresh token. */
  cacheKey: string;
  /** Builds the request at refresh time (the JWT carries the current time). */
  build(nowMs: number): UpstreamRequest;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const option = (provider: Pick<ProviderConfig, 'options'>, name: string) =>
  asString(provider.options[name]);

/**
 * Token request for a credential, or undefined when the provider authenticates with the secret
 * directly. Token URLs can be overridden per provider (`options.tokenUrl`; Entra also
 * `options.authorityHost`), e.g. for a sovereign cloud, a private endpoint or a test server.
 */
export function oauthTokenPlan(
  provider: Pick<ProviderConfig, 'type' | 'options'>,
  credentialId: string,
  secret: string,
): TokenRequestPlan | undefined {
  const kind = oauthKind(provider, secret);
  if (!kind) return undefined;
  const digest = createHash('sha256').update(secret).digest('hex').slice(0, 16);
  const cacheKey = `${credentialId}:${digest}`;
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };

  if (kind === 'google-service-account') {
    const key = parseServiceAccount(secret);
    if (!key)
      throw new TokenExchangeError(
        'vertex authMode serviceAccount needs a service account JSON key as the credential',
      );
    const url = option(provider, 'tokenUrl') ?? key.tokenUri ?? GOOGLE_TOKEN_URL;
    const scope = option(provider, 'scope') ?? GOOGLE_CLOUD_SCOPE;
    return {
      kind,
      cacheKey,
      build: (nowMs) => ({
        url,
        method: 'POST',
        headers,
        body: form({
          grant_type: JWT_BEARER_GRANT,
          assertion: buildServiceAccountJwt(key, {
            audience: url,
            scope,
            nowS: Math.floor(nowMs / 1000),
          }),
        }),
      }),
    };
  }

  if (kind === 'ibm-iam') {
    const url = option(provider, 'tokenUrl') ?? IBM_IAM_TOKEN_URL;
    return {
      kind,
      cacheKey,
      build: () => ({
        url,
        method: 'POST',
        headers,
        body: form({ grant_type: 'urn:ibm:params:oauth:grant-type:apikey', apikey: secret }),
      }),
    };
  }

  const entra = parseEntraCredentials(secret);
  const authority = (option(provider, 'authorityHost') ?? ENTRA_AUTHORITY).replace(/\/+$/, '');
  const url =
    option(provider, 'tokenUrl') ??
    `${authority}/${encodeURIComponent(entra.tenantId)}/oauth2/v2.0/token`;
  const scope = option(provider, 'scope') ?? AZURE_COGNITIVE_SCOPE;
  return {
    kind,
    cacheKey,
    build: () => ({
      url,
      method: 'POST',
      headers,
      body: form({
        grant_type: 'client_credentials',
        client_id: entra.clientId,
        client_secret: entra.clientSecret,
        scope,
      }),
    }),
  };
}

export interface AccessToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** `{access_token, expires_in}` from either endpoint; error bodies become a TokenExchangeError. */
export function parseTokenResponse(status: number, json: unknown, nowMs: number): AccessToken {
  const body = (json ?? {}) as Record<string, unknown>;
  if (status < 200 || status >= 300) {
    const code = asString(body.error) ?? `http_${String(status)}`;
    // error_description is the provider's text; it never carries the secret.
    const detail = asString(body.error_description)?.slice(0, 200);
    throw new TokenExchangeError(
      `token endpoint returned ${String(status)} ${code}${detail ? `: ${detail}` : ''}`,
      status,
    );
  }
  const token = asString(body.access_token);
  const expiresIn = Number(body.expires_in);
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0)
    throw new TokenExchangeError('token endpoint response has no access_token / expires_in');
  return { token, expiresAt: nowMs + expiresIn * 1000 };
}

export interface TokenCacheOptions {
  clock?: () => number;
  /** Refresh this long before expiry (default 5 minutes, at most half the token lifetime). */
  refreshSkewMs?: number;
  /** After a failed refresh, wait this long before trying again while the old token is valid. */
  retryAfterFailureMs?: number;
}

interface Entry {
  value?: AccessToken;
  issuedAt?: number;
  inflight?: Promise<AccessToken>;
  failedAt?: number;
}

/**
 * Access tokens per credential. `get` returns the cached token while it is fresh, refreshes it
 * once it enters the refresh window (before expiry), and shares one refresh between concurrent
 * callers. If a refresh fails while the old token is still valid, the old token keeps serving
 * (and the refresh is retried after a pause); with no valid token the failure is thrown, so the
 * caller can put that one credential in cooldown.
 */
export class TokenCache {
  readonly #entries = new Map<string, Entry>();
  readonly #clock: () => number;
  readonly #skewMs: number;
  readonly #retryMs: number;

  constructor(options: TokenCacheOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#skewMs = options.refreshSkewMs ?? 300_000;
    this.#retryMs = options.retryAfterFailureMs ?? 10_000;
  }

  /**
   * `fetchToken` runs once for all concurrent callers, so it must not depend on any one caller's
   * signal. `signal` only stops this caller from waiting: it then gets a TokenWaitAborted while
   * the shared refresh carries on for the others.
   */
  async get(
    key: string,
    fetchToken: () => Promise<AccessToken>,
    signal?: AbortSignal,
  ): Promise<string> {
    const now = this.#clock();
    let entry = this.#entries.get(key);
    if (!entry) this.#entries.set(key, (entry = {}));
    const current = entry.value;
    if (current && current.expiresAt > now) {
      const lifetime = current.expiresAt - (entry.issuedAt ?? now);
      const refreshAt = current.expiresAt - Math.min(this.#skewMs, lifetime / 2);
      const pausing = entry.failedAt !== undefined && now - entry.failedAt < this.#retryMs;
      if (now < refreshAt || pausing) return current.token;
      // In the refresh window: refresh, but fall back to the still-valid token on failure.
      try {
        return (await waitFor(this.#refresh(entry, fetchToken), signal)).token;
      } catch {
        return current.token;
      }
    }
    return (await waitFor(this.#refresh(entry, fetchToken), signal)).token;
  }

  /**
   * Forget the token of a credential (every secret version of it), e.g. after the upstream
   * rejected it with 401/403: a revoked token must not be reused until its refresh window.
   */
  invalidate(credentialId: string): void {
    for (const key of [...this.#entries.keys()])
      if (key === credentialId || key.startsWith(`${credentialId}:`)) this.#entries.delete(key);
  }

  /** Cached token state (tests, diagnostics); never logged. */
  peek(key: string): AccessToken | undefined {
    return this.#entries.get(key)?.value;
  }

  clear(): void {
    this.#entries.clear();
  }

  #refresh(entry: Entry, fetchToken: () => Promise<AccessToken>): Promise<AccessToken> {
    entry.inflight ??= (async () => {
      const issuedAt = this.#clock();
      try {
        const value = await fetchToken();
        entry.value = value;
        entry.issuedAt = issuedAt;
        delete entry.failedAt;
        return value;
      } catch (error) {
        entry.failedAt = this.#clock();
        throw error;
      } finally {
        delete entry.inflight;
      }
    })();
    // Every caller may have stopped waiting; a failure nobody awaits must not go unhandled.
    entry.inflight.catch(() => undefined);
    return entry.inflight;
  }
}

/** The shared promise, or a TokenWaitAborted as soon as this caller's signal aborts. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new TokenWaitAborted(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new TokenWaitAborted(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
