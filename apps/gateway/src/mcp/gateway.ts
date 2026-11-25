/**
 * MCP gateway (card 20.1): one Streamable HTTP endpoint, `/mcp`, in front of every MCP server the
 * organization registered. Clients (Claude Code: `claude mcp add --transport http …`) authenticate
 * with the same virtual key as for models.
 *
 * - `tools/list` merges the tools of all enabled servers as `<server>__<tool>`, filtered by the
 *   key's `mcpTools` allowlist; a tool outside it is neither listed nor callable.
 * - `tools/call` routes by prefix and is logged (caller, masked arguments, latency, outcome).
 * - With `forwardIdentity`, the caller's organization, project and key ids go upstream as
 *   `X-DiRouter-*` headers.
 * - Resources, resource templates and prompts pass through too (card 28.1): prompt and resource
 *   names get the same `<server>__` prefix as tools, and resource URIs become `<server>+<uri>` so a
 *   `resources/read` (or a template the client expanded) finds its server again. Prompts follow
 *   the key allowlist by name; resources need the whole server (`<server>__*`, `*` or no list).
 * - An upstream protected by OAuth 2.1 is reached with the organization's shared credential;
 *   tokens are discovered, obtained and renewed by `McpOAuthSession`.
 *
 * The endpoint is stateless: no session id is issued, every POST stands alone.
 */
import { randomUUID } from 'node:crypto';

import {
  MCP_TOOL_SEPARATOR,
  MCP_URI_SEPARATOR,
  type McpCallRecord,
  McpOAuthConfig,
  type McpServerConfig,
  mcpToolAllowed,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import type { Keyring, Logger } from '@dirouter/shared';
import { DiRouterError } from '@dirouter/shared';
import type { Redis } from 'ioredis';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { authenticate, extractApiKey } from '../auth.js';
import type { ConfigStore, LoadedConfig } from '../config-store.js';
import { tenantFetch } from '../upstream.js';
import { maskArguments } from './mask.js';
import { McpOAuthSession } from './oauth.js';
import { CLIENT_PROTOCOL, McpUpstream, McpUpstreamError } from './upstream.js';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TOOL_CACHE_MS = 60_000;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

/** What an upstream server lists, by method: the result field holding the items. */
const LISTS = {
  'tools/list': 'tools',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
  'prompts/list': 'prompts',
} as const;
type ListMethod = keyof typeof LISTS;
type Item = Record<string, unknown> & { name?: string };

type McpServer = McpServerConfig & { transport: 'streamable-http' | 'sse' };

const rpcError = (id: JsonRpcRequest['id'], code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id: id ?? null,
  error: { code, message },
});

export interface McpGatewayOptions {
  store: ConfigStore;
  pepper: string;
  logger: Logger;
  instance: string;
  /** Destination of tool-call records (the `mcp-calls` queue); never awaited. */
  record?: (call: McpCallRecord) => void;
  /** Encrypts the OAuth tokens shared through Valkey. */
  keyring: Keyring;
  /** Shares OAuth tokens between replicas (card 28.1); without it each replica keeps its own. */
  redis?: Redis | undefined;
}

export class McpGateway {
  readonly #upstreams = new Map<
    string,
    { fingerprint: string; client: McpUpstream; oauth?: McpOAuthSession }
  >();
  readonly #lists = new Map<string, { fingerprint: string; until: number; items: Item[] }>();
  readonly stats = { requests: 0, calls: 0, denied: 0, upstreamErrors: 0 };

  constructor(private readonly options: McpGatewayOptions) {}

  /** Closes upstream connections (the HTTP+SSE transport keeps a stream open). */
  close(): void {
    for (const { client } of this.#upstreams.values()) client.reset();
    this.#upstreams.clear();
  }

  async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (req.method !== 'POST') {
      // Stateless: no server-initiated stream (GET) and no session to end (DELETE).
      await reply.status(405).header('allow', 'POST').send({ error: 'Method not allowed' });
      return;
    }
    const config = this.options.store.current;
    if (!config) {
      await reply.status(503).send(rpcError(null, -32603, 'Gateway has no configuration yet'));
      return;
    }
    let key: VirtualKeyConfig;
    try {
      key = authenticate(config, extractApiKey(req.headers), this.options.pepper, req.ip);
    } catch (error) {
      const status = error instanceof DiRouterError ? error.status : 401;
      await reply
        .status(status)
        .send(rpcError(null, -32001, error instanceof Error ? error.message : 'unauthenticated'));
      return;
    }
    this.stats.requests++;
    const batch = Array.isArray(req.body);
    const messages = (batch ? req.body : [req.body]) as JsonRpcRequest[];
    const answers = (
      await Promise.all(messages.map((m) => this.#dispatch(config, key, m, req)))
    ).filter((a) => a !== undefined);
    if (answers.length === 0) {
      await reply.status(202).send();
      return;
    }
    await reply.status(200).send(batch ? answers : answers[0]);
  }

  async #dispatch(
    config: LoadedConfig,
    key: VirtualKeyConfig,
    message: JsonRpcRequest,
    req: FastifyRequest,
  ) {
    if (
      typeof message !== 'object' ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string'
    )
      return rpcError(message.id ?? null, -32600, 'Invalid request');
    // Notifications get no answer.
    if (message.id === undefined || message.id === null) return undefined;
    const id = message.id;
    try {
      switch (message.method) {
        case 'initialize': {
          const requested = message.params?.protocolVersion;
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion:
                typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested)
                  ? requested
                  : CLIENT_PROTOCOL,
              capabilities: {
                tools: { listChanged: false },
                resources: { listChanged: false, subscribe: false },
                prompts: { listChanged: false },
              },
              serverInfo: { name: 'DiRouter MCP gateway', version: '1.1.0' },
              instructions:
                'Tools and prompts of the MCP servers registered in DiRouter are named <server>__<name>; their resource URIs are <server>+<uri>.',
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: await this.#listTools(config, key) } };
        case 'tools/call':
          return { jsonrpc: '2.0', id, result: await this.#callTool(config, key, message, req) };
        case 'resources/list':
        case 'resources/templates/list':
        case 'prompts/list':
          return {
            jsonrpc: '2.0',
            id,
            result: { [LISTS[message.method]]: await this.#listOther(config, key, message.method) },
          };
        case 'resources/read':
          return { jsonrpc: '2.0', id, result: await this.#read(config, key, message, req) };
        case 'prompts/get':
          return { jsonrpc: '2.0', id, result: await this.#getPrompt(config, key, message, req) };
        default:
          return rpcError(id, -32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      if (error instanceof McpUpstreamError) return rpcError(id, error.code, error.message);
      if (error instanceof ToolError) return rpcError(id, error.code, error.message);
      this.options.logger.error({ err: error }, 'MCP gateway error');
      return rpcError(id, -32603, 'Internal error');
    }
  }

  /** The organization's enabled MCP servers (A2A agents share the registry but not /mcp). */
  #servers(config: LoadedConfig, organizationId: string): McpServer[] {
    return config.snapshot.mcpServers.filter(
      (s): s is McpServer =>
        s.enabled && s.organizationId === organizationId && s.transport !== 'a2a',
    );
  }

  /** One client per server, rebuilt when its address, transport or headers change. */
  #upstream(config: LoadedConfig, server: McpServer): McpUpstream {
    const fingerprint = `${server.transport}|${server.url}|${server.headers ?? ''}|${server.oauth ?? ''}|${String(server.timeoutMs)}`;
    const cached = this.#upstreams.get(server.id);
    if (cached?.fingerprint === fingerprint) return cached.client;
    cached?.client.reset();
    const headers = server.headers
      ? (JSON.parse(config.secret(`mcp:${server.id}`, server.headers)) as Record<string, string>)
      : {};
    const oauthJson = server.oauth && config.secret(`mcp-oauth:${server.id}`, server.oauth);
    const oauth = oauthJson
      ? new McpOAuthSession({
          serverId: server.id,
          url: server.url,
          config: McpOAuthConfig.parse(JSON.parse(oauthJson)),
          // The plaintext, so replicas (and a re-encrypted snapshot) share one cache.
          fingerprint: oauthJson,
          timeoutMs: Math.min(server.timeoutMs, 30_000),
          fetchImpl: tenantFetch(server.organizationId),
          keyring: this.options.keyring,
          logger: this.options.logger,
          redis: this.options.redis,
        })
      : undefined;
    const client = new McpUpstream(
      {
        url: server.url,
        transport: server.transport,
        headers,
        timeoutMs: server.timeoutMs,
        auth: oauth,
      },
      this.options.logger,
    );
    this.#upstreams.set(server.id, { fingerprint, client, ...(oauth ? { oauth } : {}) });
    return client;
  }

  /** The OAuth session of a server, for tests and diagnostics. */
  oauthSession(serverId: string): McpOAuthSession | undefined {
    return this.#upstreams.get(serverId)?.oauth;
  }

  /** Everything one server lists for `method`, following pagination; cached for a minute. */
  async #serverList(config: LoadedConfig, server: McpServer, method: ListMethod): Promise<Item[]> {
    const fingerprint = `${server.url}|${server.transport}|${server.headers ?? ''}|${server.oauth ?? ''}`;
    const cacheKey = `${server.id}|${method}`;
    const cached = this.#lists.get(cacheKey);
    if (cached?.fingerprint === fingerprint && cached.until > Date.now()) return cached.items;
    const client = this.#upstream(config, server);
    const items: Item[] = [];
    let cursor: string | undefined;
    // Follow pagination, with a hard stop against a server that never ends it.
    for (let page = 0; page < 20; page++) {
      let result: Record<string, unknown>;
      try {
        result = (await client.request(method, cursor ? { cursor } : {})) as Record<
          string,
          unknown
        >;
      } catch (error) {
        // A server without resources or prompts simply has none.
        if (method !== 'tools/list' && error instanceof McpUpstreamError && error.code === -32601)
          break;
        throw error;
      }
      const list = result[LISTS[method]];
      if (Array.isArray(list)) items.push(...(list as Item[]));
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    this.#lists.set(cacheKey, { fingerprint, until: Date.now() + TOOL_CACHE_MS, items });
    return items;
  }

  /** `method` across every server, one broken server hiding only its own items. */
  async #gather(
    config: LoadedConfig,
    key: VirtualKeyConfig,
    method: ListMethod,
    map: (server: McpServer, item: Item) => Item,
  ): Promise<Item[]> {
    const lists = await Promise.all(
      this.#servers(config, key.organizationId).map(async (server) => {
        try {
          return (await this.#serverList(config, server, method)).map((item) => map(server, item));
        } catch (error) {
          this.stats.upstreamErrors++;
          this.options.logger.warn({ err: error, server: server.slug }, `MCP ${method} failed`);
          return [];
        }
      }),
    );
    return lists.flat();
  }

  async #listTools(config: LoadedConfig, key: VirtualKeyConfig): Promise<Tool[]> {
    const tools = await this.#gather(config, key, 'tools/list', (server, tool) => ({
      ...tool,
      name: `${server.slug}${MCP_TOOL_SEPARATOR}${String(tool.name)}`,
    }));
    return (tools as Tool[]).filter((tool) => mcpToolAllowed(key.mcpTools, tool.name));
  }

  /** Resources, resource templates and prompts, namespaced and filtered by the allowlist. */
  async #listOther(
    config: LoadedConfig,
    key: VirtualKeyConfig,
    method: Exclude<ListMethod, 'tools/list'>,
  ): Promise<Item[]> {
    const items = await this.#gather(config, key, method, (server, item) => {
      const named = { ...item, name: `${server.slug}${MCP_TOOL_SEPARATOR}${String(item.name)}` };
      if (method === 'resources/list' && typeof item.uri === 'string')
        return { ...named, uri: prefixUri(server.slug, item.uri) };
      if (method === 'resources/templates/list' && typeof item.uriTemplate === 'string')
        return { ...named, uriTemplate: prefixUri(server.slug, item.uriTemplate) };
      return named;
    });
    return items.filter((item) => {
      const slug = String(item.name).split(MCP_TOOL_SEPARATOR, 1)[0] ?? '';
      return method === 'prompts/list'
        ? mcpToolAllowed(key.mcpTools, String(item.name))
        : serverAllowed(key, slug);
    });
  }

  /** The record function of one call, for the `mcp-calls` log. */
  #recorder(key: VirtualKeyConfig, serverId: string, tool: string, args: Record<string, unknown>) {
    const started = Date.now();
    return (status: McpCallRecord['status'], errorMessage?: string) => {
      this.options.record?.({
        id: randomUUID(),
        occurredAt: new Date(started).toISOString(),
        organizationId: key.organizationId,
        projectId: key.projectId,
        virtualKeyId: key.id,
        serverId,
        tool,
        arguments: maskArguments(args),
        status,
        ...(errorMessage ? { errorMessage: errorMessage.slice(0, 500) } : {}),
        latencyMs: Date.now() - started,
        gatewayInstance: this.options.instance,
      });
    };
  }

  async #read(
    config: LoadedConfig,
    key: VirtualKeyConfig,
    message: JsonRpcRequest,
    req: FastifyRequest,
  ) {
    const uri = typeof message.params?.uri === 'string' ? message.params.uri : '';
    const split = uri.indexOf(MCP_URI_SEPARATOR);
    const slug = split > 0 ? uri.slice(0, split) : '';
    const upstreamUri = split > 0 ? uri.slice(split + 1) : '';
    const server = this.#servers(config, key.organizationId).find((s) => s.slug === slug);
    const record = this.#recorder(
      key,
      server?.id ?? slug,
      `resource:${upstreamUri.slice(0, 200)}`,
      {},
    );
    // MCP's "resource not found" (-32002); a resource outside the allowlist looks the same.
    if (!server || !upstreamUri || !serverAllowed(key, slug)) {
      if (server) {
        this.stats.denied++;
        record('denied');
      }
      throw new ToolError(-32002, `Resource not found: ${uri}`);
    }
    try {
      const result = (await this.#upstream(config, server).request(
        'resources/read',
        { uri: upstreamUri },
        this.#identity(server, key, req),
      )) as { contents?: Item[] };
      record('success');
      return {
        ...result,
        contents: (result.contents ?? []).map((c) =>
          typeof c.uri === 'string' ? { ...c, uri: prefixUri(slug, c.uri) } : c,
        ),
      };
    } catch (error) {
      this.stats.upstreamErrors++;
      record('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async #getPrompt(
    config: LoadedConfig,
    key: VirtualKeyConfig,
    message: JsonRpcRequest,
    req: FastifyRequest,
  ) {
    const name = typeof message.params?.name === 'string' ? message.params.name : '';
    const args =
      message.params?.arguments && typeof message.params.arguments === 'object'
        ? (message.params.arguments as Record<string, unknown>)
        : {};
    const split = name.indexOf(MCP_TOOL_SEPARATOR);
    const slug = split > 0 ? name.slice(0, split) : '';
    const prompt = split > 0 ? name.slice(split + MCP_TOOL_SEPARATOR.length) : '';
    const server = this.#servers(config, key.organizationId).find((s) => s.slug === slug);
    const record = this.#recorder(key, server?.id ?? slug, `prompt:${prompt || name}`, args);
    if (!server || !prompt || !mcpToolAllowed(key.mcpTools, name)) {
      if (server) {
        this.stats.denied++;
        record('denied');
      }
      throw new ToolError(-32602, `Unknown prompt: ${name}`);
    }
    try {
      const result = (await this.#upstream(config, server).request(
        'prompts/get',
        { name: prompt, arguments: args },
        this.#identity(server, key, req),
      )) as { messages?: { content?: unknown }[] };
      record('success');
      return {
        ...result,
        messages: (result.messages ?? []).map((m) => ({
          ...m,
          content: prefixContent(slug, m.content),
        })),
      };
    } catch (error) {
      this.stats.upstreamErrors++;
      record('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  #identity(server: McpServer, key: VirtualKeyConfig, req: FastifyRequest): Record<string, string> {
    return server.forwardIdentity
      ? {
          'x-dirouter-organization-id': key.organizationId,
          'x-dirouter-project-id': key.projectId,
          'x-dirouter-key-id': key.id,
          ...(typeof req.headers['x-dirouter-user'] === 'string'
            ? { 'x-dirouter-user': req.headers['x-dirouter-user'].slice(0, 200) }
            : {}),
        }
      : {};
  }

  async #callTool(
    config: LoadedConfig,
    key: VirtualKeyConfig,
    message: JsonRpcRequest,
    req: FastifyRequest,
  ) {
    const name = typeof message.params?.name === 'string' ? message.params.name : '';
    const args =
      message.params?.arguments && typeof message.params.arguments === 'object'
        ? (message.params.arguments as Record<string, unknown>)
        : {};
    const split = name.indexOf(MCP_TOOL_SEPARATOR);
    const slug = split > 0 ? name.slice(0, split) : '';
    const tool = split > 0 ? name.slice(split + MCP_TOOL_SEPARATOR.length) : '';
    const server = this.#servers(config, key.organizationId).find((s) => s.slug === slug);
    const started = Date.now();
    const record = (status: McpCallRecord['status'], errorMessage?: string) => {
      this.options.record?.({
        id: randomUUID(),
        occurredAt: new Date(started).toISOString(),
        organizationId: key.organizationId,
        projectId: key.projectId,
        virtualKeyId: key.id,
        serverId: server?.id ?? slug,
        tool: tool || name,
        arguments: maskArguments(args),
        status,
        ...(errorMessage ? { errorMessage: errorMessage.slice(0, 500) } : {}),
        latencyMs: Date.now() - started,
        gatewayInstance: this.options.instance,
      });
    };
    // A tool outside the allowlist looks exactly like one that does not exist.
    if (!server || !tool || !mcpToolAllowed(key.mcpTools, name)) {
      if (server) {
        this.stats.denied++;
        record('denied');
      }
      throw new ToolError(-32602, `Unknown tool: ${name}`);
    }
    this.stats.calls++;
    try {
      const result = (await this.#upstream(config, server).request(
        'tools/call',
        { name: tool, arguments: args },
        this.#identity(server, key, req),
      )) as { isError?: boolean; content?: unknown } | undefined;
      const isError = result?.isError === true;
      record(isError ? 'error' : 'success', isError ? 'tool reported an error' : undefined);
      // Resource links and embedded resources point back through the gateway.
      return result && Array.isArray(result.content)
        ? { ...result, content: prefixContent(server.slug, result.content) }
        : result;
    } catch (error) {
      this.stats.upstreamErrors++;
      record('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

/** `<slug>+<uri>`: the server's resource URI, routable back to it. */
export function prefixUri(slug: string, uri: string): string {
  return `${slug}${MCP_URI_SEPARATOR}${uri}`;
}

/** Resources are granted per server: `<slug>__*`, `*` or an empty allowlist. */
function serverAllowed(key: VirtualKeyConfig, slug: string): boolean {
  return mcpToolAllowed(key.mcpTools, `${slug}${MCP_TOOL_SEPARATOR}*`);
}

/** Rewrites resource URIs inside content blocks (a list or a single block). */
function prefixContent(slug: string, content: unknown): unknown {
  if (Array.isArray(content)) return content.map((c) => prefixContent(slug, c));
  if (!content || typeof content !== 'object') return content;
  const block = content as Record<string, unknown>;
  if (block.type === 'resource_link' && typeof block.uri === 'string')
    return { ...block, uri: prefixUri(slug, block.uri) };
  const resource = block.resource as Record<string, unknown> | undefined;
  if (block.type === 'resource' && resource && typeof resource.uri === 'string')
    return { ...block, resource: { ...resource, uri: prefixUri(slug, resource.uri) } };
  return block;
}

class ToolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
