/**
 * OAuth 2.1 access to an upstream MCP server with the organization's shared credential (card 28.1).
 *
 * Endpoints are discovered as the MCP authorization spec describes (protected resource metadata,
 * RFC 9728, from the `WWW-Authenticate` challenge or the well-known URI, then authorization server
 * metadata, RFC 8414) unless the credential names them. Tokens are requested with the RFC 8707
 * `resource` indicator and renewed on their own: shortly before they expire, and at once when the
 * server answers 401. A refresh token (from the authorization code connection, or one the server
 * hands out with client credentials) is used first; a rotated refresh token replaces the stored
 * one.
 *
 * With Valkey, replicas share the current access token and the latest refresh token (encrypted
 * with MASTER_KEY) and renew under a short lock, so a rotating authorization server never sees the
 * same refresh token twice.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { McpOAuthConfig } from '@dirouter/contracts';
import {
  type DiscoveredOAuth,
  decrypt,
  discoverOAuth,
  encrypt,
  type FetchLike,
  type Keyring,
  type Logger,
  OAuthError,
  requestToken,
  resourceMetadataFromChallenge,
  sameOriginHint,
  type TokenResponse,
} from '@dirouter/shared';
import type { Redis } from 'ioredis';

const DEFAULT_LIFETIME_S = 3600;
const MAX_SKEW_MS = 60_000;
const LOCK_MS = 15_000;
const WAIT_FOR_PEER_MS = 10_000;
const REFRESH_TOKEN_TTL_S = 90 * 24 * 3600;

interface CachedToken {
  token: string;
  expiresAt: number;
  refreshAt: number;
}

export interface McpOAuthOptions {
  serverId: string;
  /** The MCP server URL: discovery base and default resource indicator. */
  url: string;
  config: McpOAuthConfig;
  /** Changes whenever the stored credential changes; scopes the shared cache. */
  fingerprint: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
  keyring: Keyring;
  logger: Logger;
  redis?: Redis | undefined;
}

export class McpOAuthSession {
  #discovered: Promise<DiscoveredOAuth> | undefined;
  /** The authorization server in use; never replaced for the life of this session. */
  #pinned: DiscoveredOAuth | undefined;
  #hint: string | undefined;
  #cached: CachedToken | undefined;
  #inflight: Promise<string> | undefined;
  #refreshToken: string | undefined;
  readonly #rejected = new Set<string>();
  readonly #prefix: string;
  readonly stats = { clientCredentials: 0, refreshes: 0, rejected: 0 };

  constructor(private readonly options: McpOAuthOptions) {
    const fp = createHash('sha256').update(options.fingerprint).digest('hex').slice(0, 16);
    this.#prefix = `${options.serverId}:${fp}`;
    this.#refreshToken = options.config.refreshToken;
  }

  /** A valid access token, renewed when it is about to expire. */
  async token(): Promise<string> {
    if (this.#cached && this.#cached.refreshAt > Date.now()) return this.#cached.token;
    this.#inflight ??= this.#renew().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  /** The server refused `token` (HTTP 401): the next call gets a fresh one. */
  rejected(token: string, challenge: string | null): void {
    this.stats.rejected++;
    this.#rejected.add(token);
    if (this.#rejected.size > 20) this.#rejected.delete(this.#rejected.values().next().value ?? '');
    if (this.#cached?.token === token) this.#cached = undefined;
    // The challenge's metadata hint only guides the first discovery, and only on the server's own
    // origin. Once an authorization server has been discovered it stays pinned: a later 401 renews
    // the token there, so a challenge can never move the client secret or the refresh token to
    // another token endpoint.
    if (this.#pinned) return;
    const hint = resourceMetadataFromChallenge(challenge);
    if (hint && sameOriginHint(hint, this.options.url)) this.#hint = hint;
  }

  #discover(): Promise<DiscoveredOAuth> {
    if (this.#pinned) return Promise.resolve(this.#pinned);
    this.#discovered ??= discoverOAuth(this.options.url, this.options.config, {
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.options.timeoutMs,
      hint: this.#hint,
    }).then(
      (discovered) => {
        this.#pinned = discovered;
        return discovered;
      },
      (error: unknown) => {
        this.#discovered = undefined;
        throw error;
      },
    );
    return this.#discovered;
  }

  // ───────────── shared state (Valkey) ─────────────

  #aad(kind: string) {
    return `mcp-oauth-${kind}:${this.options.serverId}`;
  }

  async #readShared(kind: 'at' | 'rt'): Promise<string | undefined> {
    const raw = await this.options.redis
      ?.get(`mcp:oauth:${kind}:${this.#prefix}`)
      .catch(() => null);
    if (!raw) return undefined;
    try {
      return decrypt(this.options.keyring, raw, this.#aad(kind));
    } catch {
      return undefined;
    }
  }

  async #writeShared(kind: 'at' | 'rt', value: string, ttlSeconds: number): Promise<void> {
    if (!this.options.redis || ttlSeconds <= 0) return;
    await this.options.redis
      .set(
        `mcp:oauth:${kind}:${this.#prefix}`,
        encrypt(this.options.keyring, value, this.#aad(kind)),
        'EX',
        Math.max(1, Math.floor(ttlSeconds)),
      )
      .catch(() => undefined);
  }

  /** A fresh token another replica stored, if any. */
  async #peerToken(): Promise<CachedToken | undefined> {
    const raw = await this.#readShared('at');
    if (!raw) return undefined;
    const token = JSON.parse(raw) as CachedToken;
    return token.refreshAt > Date.now() && !this.#rejected.has(token.token) ? token : undefined;
  }

  async #renew(): Promise<string> {
    const redis = this.options.redis;
    if (!redis) return this.#obtain();
    const peer = await this.#peerToken();
    if (peer) {
      this.#cached = peer;
      return peer.token;
    }
    const lockKey = `mcp:oauth:lock:${this.#prefix}`;
    const owner = randomUUID();
    const locked = await redis.set(lockKey, owner, 'PX', LOCK_MS, 'NX').catch(() => 'OK');
    if (locked !== 'OK') {
      // Another replica is renewing: wait for its token rather than spending the refresh token.
      const until = Date.now() + WAIT_FOR_PEER_MS;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const token = await this.#peerToken();
        if (token) {
          this.#cached = token;
          return token.token;
        }
      }
    }
    try {
      return await this.#obtain();
    } finally {
      if ((await redis.get(lockKey).catch(() => null)) === owner)
        await redis.del(lockKey).catch(() => undefined);
    }
  }

  async #obtain(): Promise<string> {
    const { config } = this.options;
    const discovered = await this.#discover();
    const http = { fetchImpl: this.options.fetchImpl, timeoutMs: this.options.timeoutMs };
    const client = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      authMethod: config.tokenEndpointAuthMethod,
    };
    const refreshToken = (await this.#readShared('rt')) ?? this.#refreshToken;
    let response: TokenResponse | undefined;
    if (refreshToken) {
      try {
        response = await requestToken(
          discovered.server,
          client,
          {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            resource: discovered.resource,
          },
          http,
        );
        this.stats.refreshes++;
      } catch (error) {
        if (config.grantType === 'authorization_code')
          throw new OAuthError(
            `the refresh token was refused (${error instanceof Error ? error.message : String(error)}); connect the server again`,
          );
        // Client credentials can always start over.
        this.#refreshToken = undefined;
        this.options.logger.warn(
          { err: error, server: this.options.serverId },
          'MCP OAuth refresh failed, using client credentials',
        );
      }
    }
    if (!response) {
      if (config.grantType === 'authorization_code')
        throw new OAuthError('the server is not connected yet: complete the authorization first');
      response = await requestToken(
        discovered.server,
        client,
        { grant_type: 'client_credentials', scope: config.scope, resource: discovered.resource },
        http,
      );
      this.stats.clientCredentials++;
    }
    if (response.refresh_token && response.refresh_token !== refreshToken) {
      this.#refreshToken = response.refresh_token;
      await this.#writeShared('rt', response.refresh_token, REFRESH_TOKEN_TTL_S);
    }
    const now = Date.now();
    const lifetime = (response.expires_in ?? DEFAULT_LIFETIME_S) * 1000;
    const skew = Math.min(MAX_SKEW_MS, lifetime / 4);
    const cached: CachedToken = {
      token: response.access_token,
      expiresAt: now + lifetime,
      refreshAt: now + lifetime - skew,
    };
    this.#cached = cached;
    await this.#writeShared('at', JSON.stringify(cached), (lifetime - skew) / 1000);
    return cached.token;
  }
}
