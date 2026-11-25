/**
 * OAuth 2.1 client helpers (card 28.1) for reaching OAuth-protected MCP servers with an
 * organization's shared credential:
 *
 * - Protected resource metadata (RFC 9728): the authorization servers of a resource, found through
 *   the `resource_metadata` parameter of a `WWW-Authenticate` challenge or the well-known URI.
 * - Authorization server metadata (RFC 8414, with the OpenID Connect discovery fallbacks the MCP
 *   authorization spec lists): token and authorization endpoints.
 * - Token requests (client credentials, authorization code with PKCE, refresh token), always with
 *   the RFC 8707 `resource` indicator.
 *
 * `fetchImpl` lets the caller route these requests through its SSRF guard.
 */
import { createHash, randomBytes } from 'node:crypto';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OAuthHttpOptions {
  fetchImpl?: FetchLike | undefined;
  timeoutMs?: number | undefined;
}

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer?: string;
  token_endpoint: string;
  authorization_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  scopes_supported?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret?: string | undefined;
  authMethod?: ClientAuthMethod | undefined;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    /** The `error` code of an RFC 6749 error response, when the server sent one. */
    readonly error?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

async function getJson<T>(url: string, options: OAuthHttpOptions): Promise<T | undefined> {
  const res = await (options.fetchImpl ?? fetch)(url, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  }).catch(() => undefined);
  if (!res?.ok) {
    await res?.body?.cancel().catch(() => undefined);
    return undefined;
  }
  return (await res.json().catch(() => undefined)) as T | undefined;
}

/** The `resource_metadata` URL of a `WWW-Authenticate: Bearer …` challenge, if it has one. */
export function resourceMetadataFromChallenge(
  header: string | null | undefined,
): string | undefined {
  if (!header) return undefined;
  const match = /resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/i.exec(header);
  return match?.[1] ?? match?.[2];
}

/**
 * Well-known URL with the suffix inserted between the host and the path (RFC 8414 section 3.1,
 * RFC 9728 section 3.1): `https://h/a/b` → `https://h/.well-known/<suffix>/a/b`.
 */
export function wellKnownUrl(base: string, suffix: string): string {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/${suffix}${path}`;
}

/** Resource identifiers compared as RFC 9728 requires ("identical"), ignoring a trailing slash. */
function sameResource(a: string, b: string): boolean {
  try {
    const strip = (value: string) => {
      const url = new URL(value);
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    };
    return strip(a) === strip(b);
  } catch {
    return false;
  }
}

/** Whether `hint` (a `resource_metadata` URL, possibly relative) is on the origin of `resourceUrl`. */
export function sameOriginHint(hint: string, resourceUrl: string): boolean {
  try {
    return new URL(hint, resourceUrl).origin === new URL(resourceUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Protected resource metadata of `resourceUrl` (RFC 9728), trying the challenge hint first.
 *
 * - A hint is followed only on the origin of `resourceUrl`: a challenge cannot send the client to
 *   metadata (and so to an authorization server) somewhere else.
 * - The metadata's `resource` must be identical to the resource identifier it was retrieved for
 *   (section 3.3): `resourceUrl` for the hint and the path-inserted well-known URI, the origin for
 *   the well-known URI at the root. Metadata naming another resource is not used.
 */
export async function discoverProtectedResource(
  resourceUrl: string,
  options: OAuthHttpOptions & { hint?: string | undefined } = {},
): Promise<ProtectedResourceMetadata | undefined> {
  const origin = new URL(resourceUrl).origin;
  const candidates: { url: string; resource: string }[] = [
    ...(options.hint && sameOriginHint(options.hint, resourceUrl)
      ? [{ url: new URL(options.hint, resourceUrl).toString(), resource: resourceUrl }]
      : []),
    { url: wellKnownUrl(resourceUrl, 'oauth-protected-resource'), resource: resourceUrl },
    { url: `${origin}/.well-known/oauth-protected-resource`, resource: origin },
  ];
  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (tried.has(candidate.url)) continue;
    tried.add(candidate.url);
    const meta = await getJson<ProtectedResourceMetadata>(candidate.url, options);
    if (!meta || !Array.isArray(meta.authorization_servers)) continue;
    if (typeof meta.resource !== 'string' || !sameResource(meta.resource, candidate.resource))
      continue;
    return meta;
  }
  return undefined;
}

/**
 * Authorization server metadata for an issuer, in the order the MCP authorization spec gives:
 * RFC 8414 with path insertion, OpenID discovery with path insertion, OpenID discovery appended.
 * The returned issuer must match the one asked for (RFC 8414 section 3.3).
 */
export async function discoverAuthorizationServer(
  issuer: string,
  options: OAuthHttpOptions = {},
): Promise<AuthorizationServerMetadata> {
  const trimmed = issuer.replace(/\/+$/, '');
  const hasPath = new URL(trimmed).pathname.length > 1;
  const candidates = [
    wellKnownUrl(trimmed, 'oauth-authorization-server'),
    wellKnownUrl(trimmed, 'openid-configuration'),
    ...(hasPath ? [`${trimmed}/.well-known/openid-configuration`] : []),
  ];
  for (const candidate of candidates) {
    const meta = await getJson<AuthorizationServerMetadata>(candidate, options);
    if (!meta || typeof meta.token_endpoint !== 'string') continue;
    if (meta.issuer && meta.issuer.replace(/\/+$/, '') !== trimmed)
      throw new OAuthError(
        `authorization server metadata names issuer ${meta.issuer}, not ${issuer}`,
      );
    return meta;
  }
  throw new OAuthError(`no authorization server metadata found for ${issuer}`);
}

export interface DiscoveredOAuth {
  /** The resource indicator to send (RFC 8707). */
  resource: string;
  server: AuthorizationServerMetadata;
}

/**
 * Endpoints for an MCP server: an explicit token endpoint wins, then an explicit issuer, then
 * protected resource metadata of the server URL.
 */
export async function discoverOAuth(
  resourceUrl: string,
  config: {
    tokenEndpoint?: string | undefined;
    authorizationEndpoint?: string | undefined;
    issuer?: string | undefined;
  },
  options: OAuthHttpOptions & { hint?: string | undefined } = {},
): Promise<DiscoveredOAuth> {
  if (config.tokenEndpoint)
    return {
      resource: resourceUrl,
      server: {
        token_endpoint: config.tokenEndpoint,
        ...(config.authorizationEndpoint
          ? { authorization_endpoint: config.authorizationEndpoint }
          : {}),
      },
    };
  let issuer = config.issuer;
  let resource = resourceUrl;
  if (!issuer) {
    const prm = await discoverProtectedResource(resourceUrl, options);
    issuer = prm?.authorization_servers?.[0];
    if (!issuer || !prm?.resource)
      throw new OAuthError(`no protected resource metadata found for ${resourceUrl}`);
    resource = prm.resource;
  }
  const server = await discoverAuthorizationServer(issuer, options);
  return {
    resource,
    server: config.authorizationEndpoint
      ? { ...server, authorization_endpoint: config.authorizationEndpoint }
      : server,
  };
}

/** Picks the client authentication method the server supports (basic is the RFC default). */
export function clientAuthMethod(
  client: OAuthClientCredentials,
  server: AuthorizationServerMetadata,
): ClientAuthMethod {
  if (client.authMethod) return client.authMethod;
  if (!client.clientSecret) return 'none';
  const supported = server.token_endpoint_auth_methods_supported;
  if (
    supported &&
    !supported.includes('client_secret_basic') &&
    supported.includes('client_secret_post')
  )
    return 'client_secret_post';
  return 'client_secret_basic';
}

/** POSTs a token request (form encoded) and returns the token response. */
export async function requestToken(
  server: AuthorizationServerMetadata,
  client: OAuthClientCredentials,
  params: Record<string, string | undefined>,
  options: OAuthHttpOptions = {},
): Promise<TokenResponse> {
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value) form.set(name, value);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  const method = clientAuthMethod(client, server);
  if (method === 'client_secret_basic') {
    // RFC 6749 section 2.3.1: both parts form-urlencoded before base64.
    const encode = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
    headers.authorization = `Basic ${Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret ?? '')}`).toString('base64')}`;
  } else {
    form.set('client_id', client.clientId);
    if (method === 'client_secret_post' && client.clientSecret)
      form.set('client_secret', client.clientSecret);
  }
  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(server.token_endpoint, {
      method: 'POST',
      headers,
      body: form.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new OAuthError(
      `token endpoint unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (!res.ok || typeof body.access_token !== 'string') {
    throw new OAuthError(
      `token request failed (HTTP ${String(res.status)}${body.error ? `: ${body.error}` : ''}${body.error_description ? ` – ${body.error_description}` : ''})`,
      body.error,
      res.status,
    );
  }
  if (body.token_type && body.token_type.toLowerCase() !== 'bearer')
    throw new OAuthError(`unsupported token type ${body.token_type}`);
  return body as TokenResponse;
}

/** PKCE pair (RFC 7636, S256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
