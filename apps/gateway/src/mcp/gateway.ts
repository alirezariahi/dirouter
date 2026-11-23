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
 *
 * The endpoint is stateless: no session id is issued, every POST stands alone.
 */
import { randomUUID } from 'node:crypto';

import {
  MCP_TOOL_SEPARATOR,
  type McpCallRecord,
  type McpServerConfig,
  mcpToolAllowed,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';
import { DiRouterError } from '@dirouter/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { authenticate, extractApiKey } from '../auth.js';
import type { ConfigStore, LoadedConfig } from '../config-store.js';
import { maskArguments } from './mask.js';
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
}

export class McpGateway {
  readonly #upstreams = new Map<string, { fingerprint: string; client: McpUpstream }>();
  readonly #tools = new Map<string, { fingerprint: string; until: number; tools: Tool[] }>();
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
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'DiRouter MCP gateway', version: '1.0.0' },
              instructions:
                'Tools of the MCP servers registered in DiRouter, named <server>__<tool>.',
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: await this.#listTools(config, key) } };
        case 'tools/call':
          return { jsonrpc: '2.0', id, result: await this.#callTool(config, key, message, req) };
        // Clients probe these; this gateway offers tools only.
        case 'resources/list':
          return { jsonrpc: '2.0', id, result: { resources: [] } };
        case 'resources/templates/list':
          return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
        case 'prompts/list':
          return { jsonrpc: '2.0', id, result: { prompts: [] } };
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

  #servers(config: LoadedConfig, organizationId: string): McpServerConfig[] {
    return config.snapshot.mcpServers.filter(
      (s) => s.enabled && s.organizationId === organizationId,
    );
  }

  /** One client per server, rebuilt when its address, transport or headers change. */
  #upstream(config: LoadedConfig, server: McpServerConfig): McpUpstream {
    const fingerprint = `${server.transport}|${server.url}|${server.headers ?? ''}|${String(server.timeoutMs)}`;
    const cached = this.#upstreams.get(server.id);
    if (cached?.fingerprint === fingerprint) return cached.client;
    cached?.client.reset();
    const headers = server.headers
      ? (JSON.parse(config.secret(`mcp:${server.id}`, server.headers)) as Record<string, string>)
      : {};
    const client = new McpUpstream(
      { url: server.url, transport: server.transport, headers, timeoutMs: server.timeoutMs },
      this.options.logger,
    );
    this.#upstreams.set(server.id, { fingerprint, client });
    return client;
  }

  async #serverTools(config: LoadedConfig, server: McpServerConfig): Promise<Tool[]> {
    const fingerprint = `${server.url}|${server.transport}|${server.headers ?? ''}`;
    const cached = this.#tools.get(server.id);
    if (cached?.fingerprint === fingerprint && cached.until > Date.now()) return cached.tools;
    const client = this.#upstream(config, server);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    // Follow pagination, with a hard stop against a server that never ends it.
    for (let page = 0; page < 20; page++) {
      const result = (await client.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: Tool[];
        nextCursor?: string;
      };
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    this.#tools.set(server.id, { fingerprint, until: Date.now() + TOOL_CACHE_MS, tools });
    return tools;
  }

  async #listTools(config: LoadedConfig, key: VirtualKeyConfig): Promise<Tool[]> {
    const lists = await Promise.all(
      this.#servers(config, key.organizationId).map(async (server) => {
        try {
          return (await this.#serverTools(config, server)).map((tool) => ({
            ...tool,
            name: `${server.slug}${MCP_TOOL_SEPARATOR}${tool.name}`,
          }));
        } catch (error) {
          // One broken server must not hide the others' tools.
          this.stats.upstreamErrors++;
          this.options.logger.warn({ err: error, server: server.slug }, 'MCP tools/list failed');
          return [];
        }
      }),
    );
    return lists.flat().filter((tool) => mcpToolAllowed(key.mcpTools, tool.name));
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
    const identity: Record<string, string> = server.forwardIdentity
      ? {
          'x-dirouter-organization-id': key.organizationId,
          'x-dirouter-project-id': key.projectId,
          'x-dirouter-key-id': key.id,
          ...(typeof req.headers['x-dirouter-user'] === 'string'
            ? { 'x-dirouter-user': req.headers['x-dirouter-user'].slice(0, 200) }
            : {}),
        }
      : {};
    try {
      const result = await this.#upstream(config, server).request(
        'tools/call',
        { name: tool, arguments: args },
        identity,
      );
      const isError = (result as { isError?: boolean } | undefined)?.isError === true;
      record(isError ? 'error' : 'success', isError ? 'tool reported an error' : undefined);
      return result;
    } catch (error) {
      this.stats.upstreamErrors++;
      record('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

class ToolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
