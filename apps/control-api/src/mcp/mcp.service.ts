/**
 * MCP servers of an organization and the tool-call log (card 20.1). The gateway serves them under
 * /mcp; this service registers them (headers encrypted with MASTER_KEY, AAD `mcp:<id>`, never
 * returned), checks the URL against the outbound policy, and reads the calls the worker logged.
 *
 * Card 28.1: an OAuth-protected server keeps the organization's shared OAuth 2.1 credential
 * (encrypted, AAD `mcp-oauth:<id>`). With the authorization code grant an administrator connects it
 * once: `authorize` returns the authorization URL (PKCE S256, state sealed with MASTER_KEY) and
 * `callback` trades the code for a refresh token, which the gateway then uses and renews.
 */
import type { McpOAuthConfig } from '@dirouter/contracts';
import {
  decrypt,
  discoverOAuth,
  encrypt,
  type FetchLike,
  OAuthError,
  pkcePair,
  requestToken,
} from '@dirouter/shared';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { checkOutboundUrl } from '../alerts/alert-url.js';
import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

export interface McpServerInput {
  name: string;
  slug: string;
  transport: 'streamable-http' | 'sse' | 'a2a';
  url: string;
  /** Replaces the stored headers; `null` removes them, absent keeps them. */
  headers?: Record<string, string> | null | undefined;
  /** Replaces the stored OAuth credential; `null` removes it, absent keeps it. */
  oauth?: McpOAuthConfig | null | undefined;
  enabled?: boolean | undefined;
  forwardIdentity?: boolean | undefined;
  timeoutMs?: number | undefined;
}

type Row = NonNullable<Awaited<ReturnType<PrismaService['client']['mcpServer']['findFirst']>>>;

const STATE_AAD = 'mcp-oauth-state';
const STATE_TTL_MS = 10 * 60_000;

/** What an administrator may see of the OAuth credential: never the secret or the tokens. */
function oauthView(config: McpOAuthConfig | undefined) {
  if (!config) return null;
  return {
    grantType: config.grantType,
    clientId: config.clientId,
    hasClientSecret: Boolean(config.clientSecret),
    scope: config.scope ?? null,
    issuer: config.issuer ?? null,
    tokenEndpoint: config.tokenEndpoint ?? null,
    authorizationEndpoint: config.authorizationEndpoint ?? null,
    tokenEndpointAuthMethod: config.tokenEndpointAuthMethod ?? null,
    /** Authorization code: whether the server has been connected (a refresh token is stored). */
    connected: config.grantType === 'client_credentials' || Boolean(config.refreshToken),
  };
}

export function mcpServerView(s: Row, oauth?: McpOAuthConfig) {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    transport: s.transport,
    url: s.url,
    hasHeaders: s.headersEnc !== null,
    oauth: oauthView(oauth),
    enabled: s.enabled,
    forwardIdentity: s.forwardIdentity,
    timeoutMs: s.timeoutMs,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

@Injectable()
export class McpService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  async #checkUrl(ctx: OrgContext, url: string) {
    // The gateway calls this address: same policy as alert webhooks (https and public addresses in
    // production; anything in development, where MCP servers run next door). The platform
    // organization may reach private addresses, such as the stdio bridge sidecar (card 28.1).
    let production = this.env.NODE_ENV === 'production';
    if (production) {
      const org = await this.db.organization.findUnique({
        where: { id: ctx.organizationId },
        select: { isPlatform: true },
      });
      if (org?.isPlatform) production = false;
    }
    const check = await checkOutboundUrl(url, { production });
    if (!check.ok) throw new DiRouterError('validation_failed', { message: check.error });
  }

  #oauth(row: Row): McpOAuthConfig | undefined {
    return row.oauthEnc
      ? (JSON.parse(
          decrypt(this.env.MASTER_KEY, row.oauthEnc, `mcp-oauth:${row.id}`),
        ) as McpOAuthConfig)
      : undefined;
  }

  #sealOauth(id: string, config: McpOAuthConfig): string {
    return encrypt(this.env.MASTER_KEY, JSON.stringify(config), `mcp-oauth:${id}`);
  }

  #view(row: Row) {
    return mcpServerView(row, this.#oauth(row));
  }

  /** Endpoints found in metadata obey the same outbound policy as the server URL. */
  readonly #fetch: FetchLike = async (url, init) => {
    const check = await checkOutboundUrl(url, { production: this.env.NODE_ENV === 'production' });
    if (!check.ok) throw new OAuthError(`${url}: ${check.error}`);
    return fetch(url, { ...init, redirect: 'manual' });
  };

  async #discover(row: Row, config: McpOAuthConfig) {
    try {
      return await discoverOAuth(row.url, config, { fetchImpl: this.#fetch });
    } catch (error) {
      throw new DiRouterError('validation_failed', {
        message: `OAuth discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * A new credential keeps the stored refresh token while it still names the same client and
   * authorization server, so rotating the client secret does not disconnect the server.
   */
  #mergeOauth(previous: McpOAuthConfig | undefined, next: McpOAuthConfig): McpOAuthConfig {
    const same =
      previous?.refreshToken &&
      previous.grantType === next.grantType &&
      previous.clientId === next.clientId &&
      previous.issuer === next.issuer &&
      previous.tokenEndpoint === next.tokenEndpoint;
    return !next.refreshToken && same ? { ...next, refreshToken: previous.refreshToken } : next;
  }

  async #audit(ctx: OrgContext, action: string, targetId: string, diff?: object) {
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        action,
        targetType: 'mcp_server',
        targetId,
        ...(diff ? { diff } : {}),
      },
    });
  }

  async #load(ctx: OrgContext, id: string) {
    const row = await this.db.mcpServer.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
    });
    if (!row) throw new DiRouterError('not_found', { message: 'MCP server not found' });
    return row;
  }

  async #slugFree(ctx: OrgContext, slug: string, except?: string) {
    const taken = await this.db.mcpServer.findFirst({
      where: {
        organizationId: ctx.organizationId,
        slug,
        deletedAt: null,
        NOT: { id: except ?? '' },
      },
      select: { id: true },
    });
    if (taken)
      throw new DiRouterError('conflict', { message: `MCP server '${slug}' already exists` });
  }

  async list(ctx: OrgContext) {
    const rows = await this.db.mcpServer.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      orderBy: { slug: 'asc' },
    });
    return rows.map((row) => this.#view(row));
  }

  async get(ctx: OrgContext, id: string) {
    return this.#view(await this.#load(ctx, id));
  }

  async create(ctx: OrgContext, input: McpServerInput) {
    await this.#checkUrl(ctx, input.url);
    await this.#slugFree(ctx, input.slug);
    const id = prefixedId('mcp');
    await this.db.mcpServer.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        name: input.name,
        slug: input.slug,
        transport: input.transport,
        url: input.url,
        headersEnc: input.headers
          ? encrypt(this.env.MASTER_KEY, JSON.stringify(input.headers), `mcp:${id}`)
          : null,
        oauthEnc: input.oauth ? this.#sealOauth(id, input.oauth) : null,
        enabled: input.enabled ?? true,
        forwardIdentity: input.forwardIdentity ?? false,
        timeoutMs: input.timeoutMs ?? 60_000,
      },
    });
    await this.#audit(ctx, 'mcp_server.created', id, { slug: input.slug, url: input.url });
    return this.get(ctx, id);
  }

  async update(ctx: OrgContext, id: string, input: Partial<McpServerInput>) {
    const row = await this.#load(ctx, id);
    if (input.url !== undefined) await this.#checkUrl(ctx, input.url);
    if (input.slug !== undefined && input.slug !== row.slug)
      await this.#slugFree(ctx, input.slug, id);
    await this.db.mcpServer.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.transport !== undefined ? { transport: input.transport } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.headers !== undefined
          ? {
              headersEnc: input.headers
                ? encrypt(this.env.MASTER_KEY, JSON.stringify(input.headers), `mcp:${id}`)
                : null,
            }
          : {}),
        ...(input.oauth !== undefined
          ? {
              oauthEnc: input.oauth
                ? this.#sealOauth(id, this.#mergeOauth(this.#oauth(row), input.oauth))
                : null,
            }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.forwardIdentity !== undefined ? { forwardIdentity: input.forwardIdentity } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      },
    });
    // Header values are secrets: the audit trail records that they changed, not what they are.
    const { headers, oauth, ...rest } = input;
    await this.#audit(ctx, 'mcp_server.updated', id, {
      ...rest,
      ...(headers !== undefined ? { headers: headers ? 'replaced' : 'removed' } : {}),
      ...(oauth !== undefined
        ? { oauth: oauth ? { replaced: true, grantType: oauth.grantType } : 'removed' }
        : {}),
    });
    return this.get(ctx, id);
  }

  /** Starts the authorization code connection: the URL the administrator opens. */
  async authorize(ctx: OrgContext, id: string, redirectUri: string) {
    const row = await this.#load(ctx, id);
    const config = this.#oauth(row);
    if (config?.grantType !== 'authorization_code')
      throw new DiRouterError('validation_failed', {
        message: 'the server has no OAuth credential with the authorization code grant',
      });
    const { resource, server } = await this.#discover(row, config);
    if (!server.authorization_endpoint)
      throw new DiRouterError('validation_failed', {
        message: 'the authorization server publishes no authorization endpoint',
      });
    // OAuth 2.1 and the MCP authorization spec: PKCE with S256, refused if not advertised.
    if (!config.authorizationEndpoint && !server.code_challenge_methods_supported?.includes('S256'))
      throw new DiRouterError('validation_failed', {
        message: 'the authorization server does not advertise PKCE S256',
      });
    const pkce = pkcePair();
    const state = encrypt(
      this.env.MASTER_KEY,
      JSON.stringify({
        s: id,
        o: ctx.organizationId,
        v: pkce.verifier,
        r: redirectUri,
        e: Date.now() + STATE_TTL_MS,
      }),
      STATE_AAD,
    );
    const url = new URL(server.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('resource', resource);
    if (config.scope) url.searchParams.set('scope', config.scope);
    return { authorizationUrl: url.toString(), state };
  }

  /** Finishes the connection: trades the code for tokens and keeps the refresh token. */
  async callback(ctx: OrgContext, id: string, input: { code: string; state: string }) {
    const row = await this.#load(ctx, id);
    const config = this.#oauth(row);
    let state: { s: string; o: string; v: string; r: string; e: number };
    try {
      state = JSON.parse(decrypt(this.env.MASTER_KEY, input.state, STATE_AAD)) as typeof state;
    } catch {
      throw new DiRouterError('validation_failed', { message: 'invalid state' });
    }
    if (state.s !== id || state.o !== ctx.organizationId || state.e < Date.now())
      throw new DiRouterError('validation_failed', { message: 'invalid or expired state' });
    if (config?.grantType !== 'authorization_code')
      throw new DiRouterError('validation_failed', {
        message: 'the server has no OAuth credential with the authorization code grant',
      });
    const { resource, server } = await this.#discover(row, config);
    let tokens;
    try {
      tokens = await requestToken(
        server,
        {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          authMethod: config.tokenEndpointAuthMethod,
        },
        {
          grant_type: 'authorization_code',
          code: input.code,
          code_verifier: state.v,
          redirect_uri: state.r,
          resource,
        },
        { fetchImpl: this.#fetch },
      );
    } catch (error) {
      throw new DiRouterError('validation_failed', {
        message: `code exchange failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (!tokens.refresh_token)
      throw new DiRouterError('validation_failed', {
        message:
          'the authorization server issued no refresh token (does the scope need offline_access?)',
      });
    await this.db.mcpServer.update({
      where: { id },
      data: { oauthEnc: this.#sealOauth(id, { ...config, refreshToken: tokens.refresh_token }) },
    });
    await this.#audit(ctx, 'mcp_server.oauth_connected', id);
    return this.get(ctx, id);
  }

  async remove(ctx: OrgContext, id: string) {
    await this.#load(ctx, id);
    await this.db.mcpServer.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
    await this.#audit(ctx, 'mcp_server.deleted', id);
  }

  /**
   * Connection test and tool discovery (card 25.3). The gateway runs it with the same MCP client as
   * real traffic; the headers travel encrypted and are only decrypted there. Works for disabled
   * servers and before the snapshot carrying a new server has been loaded.
   */
  async test(ctx: OrgContext, id: string) {
    const row = await this.#load(ctx, id);
    const res = await fetch(
      `${this.env.GATEWAY_INTERNAL_URL.replace(/\/+$/, '')}/internal/mcp/probe`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.env.INTERNAL_TOKEN}`,
        },
        body: JSON.stringify({
          server: {
            id: row.id,
            organizationId: row.organizationId,
            slug: row.slug,
            transport: row.transport,
            url: row.url,
            enabled: row.enabled,
            ...(row.headersEnc ? { headers: row.headersEnc } : {}),
            forwardIdentity: row.forwardIdentity,
            timeoutMs: row.timeoutMs,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    ).catch((error: unknown) => {
      throw new DiRouterError('service_unavailable', {
        message: 'Gateway is not reachable',
        cause: error,
      });
    });
    if (!res.ok)
      throw new DiRouterError('service_unavailable', {
        message: `Gateway probe failed (${String(res.status)})`,
      });
    const result = (await res.json()) as {
      ok: boolean;
      latencyMs: number;
      tools?: { name: string; description?: string }[];
      agentName?: string;
      error?: string;
    };
    return {
      ok: result.ok,
      latencyMs: result.latencyMs,
      tools: result.tools ?? [],
      ...(result.agentName ? { agentName: result.agentName } : {}),
      ...(result.error ? { error: result.error.slice(0, 500) } : {}),
    };
  }

  async calls(
    ctx: OrgContext,
    q: {
      limit: number;
      serverId?: string | undefined;
      apiKeyId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    const rows = await this.db.mcpToolCall.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(q.serverId ? { serverId: q.serverId } : {}),
        ...(q.apiKeyId ? { apiKeyId: q.apiKeyId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: q.limit,
    });
    return rows.map((c) => ({
      id: c.id,
      occurredAt: c.occurredAt.toISOString(),
      apiKeyId: c.apiKeyId,
      projectId: c.projectId,
      serverId: c.serverId,
      tool: c.tool,
      arguments: c.arguments,
      status: c.status,
      errorMessage: c.errorMessage,
      latencyMs: c.latencyMs,
    }));
  }
}
