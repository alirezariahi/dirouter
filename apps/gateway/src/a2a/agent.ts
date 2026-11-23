/**
 * Agent-to-agent (A2A) protocol (card 20.3).
 *
 * DiRouter as an agent: the Agent Card at `/.well-known/agent-card.json`, JSON-RPC at `/a2a`. A
 * message is answered by the gateway's own `/v1/chat/completions` with the caller's key, so routing,
 * fallback, budgets, the prepaid wallet and usage logging apply exactly as for any other request.
 * Tasks (and the conversation of their context) are kept in Valkey for a day and are visible only
 * to the project that created them.
 *
 * External agents registered with transport `a2a` are proxied at `/a2a/agents/<slug>` under the
 * same key allowlist (`<slug>__*`) and call log as MCP tools; their card is served with the
 * interface URL rewritten to DiRouter.
 *
 * Both protocol versions are spoken: v1.0 (`SendMessage`, `GetTask`, `CancelTask`, parts
 * `{text}`, `TASK_STATE_*`) and v0.3 (`message/send`, `tasks/get`, `tasks/cancel`, parts
 * `{kind: 'text'}`), chosen by the method name; an empty `A2A-Version` header means 0.3.
 */
import { randomUUID } from 'node:crypto';

import {
  MCP_TOOL_SEPARATOR,
  type McpCallRecord,
  type McpServerConfig,
  mcpToolAllowed,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { DiRouterError, type Logger } from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

import { authenticate, extractApiKey } from '../auth.js';
import type { ConfigStore, LoadedConfig } from '../config-store.js';
import { maskArguments } from '../mcp/mask.js';

const TASK_TTL_SECONDS = 24 * 3600;
const MAX_CONTEXT_MESSAGES = 40;

type Version = '1.0' | '0.3';
type State = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'rejected';

/** Version-neutral task kept in the store. */
interface StoredTask {
  id: string;
  contextId: string;
  state: State;
  statusText?: string;
  answer?: string;
  history: { role: 'user' | 'agent'; text: string; messageId: string }[];
  timestamp: string;
  owner: { organizationId: string; projectId: string };
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const V1_METHODS: Record<string, string> = {
  SendMessage: 'send',
  GetTask: 'get',
  CancelTask: 'cancel',
  ListTasks: 'list',
  GetExtendedAgentCard: 'card',
};
const V03_METHODS: Record<string, string> = {
  'message/send': 'send',
  'tasks/get': 'get',
  'tasks/cancel': 'cancel',
};

class A2aError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const rpcError = (id: Rpc['id'], code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id: id ?? null,
  error: { code, message },
});

/** Text of a message's parts in either version (`{text}` or `{kind:'text', text}`). */
export function messageText(message: unknown): string {
  const parts = (message as { parts?: unknown[] } | undefined)?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) =>
      p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
        ? (p as { text: string }).text
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** A stored task in the wire format of the requested version. */
export function taskView(task: StoredTask, version: Version, historyLength?: number) {
  const history =
    historyLength === undefined
      ? task.history
      : task.history.slice(-historyLength || task.history.length);
  const trimmed = historyLength === 0 ? [] : history;
  if (version === '1.0')
    return {
      id: task.id,
      contextId: task.contextId,
      status: {
        state: `TASK_STATE_${task.state.toUpperCase()}`,
        timestamp: task.timestamp,
        ...(task.statusText
          ? {
              message: {
                messageId: `${task.id}-status`,
                role: 'ROLE_AGENT',
                parts: [{ text: task.statusText }],
              },
            }
          : {}),
      },
      ...(task.answer
        ? {
            artifacts: [
              { artifactId: `${task.id}-answer`, name: 'answer', parts: [{ text: task.answer }] },
            ],
          }
        : {}),
      history: trimmed.map((m) => ({
        messageId: m.messageId,
        contextId: task.contextId,
        taskId: task.id,
        role: m.role === 'user' ? 'ROLE_USER' : 'ROLE_AGENT',
        parts: [{ text: m.text }],
      })),
    };
  return {
    kind: 'task',
    id: task.id,
    contextId: task.contextId,
    status: {
      state: task.state,
      timestamp: task.timestamp,
      ...(task.statusText
        ? {
            message: {
              kind: 'message',
              messageId: `${task.id}-status`,
              role: 'agent',
              parts: [{ kind: 'text', text: task.statusText }],
            },
          }
        : {}),
    },
    ...(task.answer
      ? {
          artifacts: [
            {
              artifactId: `${task.id}-answer`,
              name: 'answer',
              parts: [{ kind: 'text', text: task.answer }],
            },
          ],
        }
      : {}),
    history: trimmed.map((m) => ({
      kind: 'message',
      messageId: m.messageId,
      contextId: task.contextId,
      taskId: task.id,
      role: m.role,
      parts: [{ kind: 'text', text: m.text }],
    })),
  };
}

export interface A2aOptions {
  store: ConfigStore;
  pepper: string;
  logger: Logger;
  instance: string;
  redis?: Redis | undefined;
  record?: (call: McpCallRecord) => void;
}

export class A2aAgent {
  /** In-memory fallback when there is no Valkey (single node). */
  readonly #local = new Map<string, { value: string; until: number }>();
  readonly stats = { messages: 0, proxied: 0, denied: 0 };

  constructor(
    private readonly app: FastifyInstance,
    private readonly options: A2aOptions,
  ) {}

  register(): void {
    this.app.get('/.well-known/agent-card.json', (req, reply) => this.#card(req, reply));
    // v0.3 clients look here first.
    this.app.get('/.well-known/agent.json', (req, reply) => this.#card(req, reply));
    this.app.post('/a2a', (req, reply) => this.#rpc(req, reply));
    this.app.get<{ Params: { slug: string } }>(
      '/a2a/agents/:slug/.well-known/agent-card.json',
      (req, reply) => this.#remoteCard(req, reply),
    );
    this.app.post<{ Params: { slug: string } }>('/a2a/agents/:slug', (req, reply) =>
      this.#proxy(req, reply),
    );
  }

  #base(req: FastifyRequest): string {
    const proto =
      String(req.headers['x-forwarded-proto'] ?? req.protocol)
        .split(',')[0]
        ?.trim() ?? 'http';
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost')
      .split(',')[0]
      ?.trim();
    return `${proto}://${host ?? 'localhost'}`;
  }

  #card(req: FastifyRequest, reply: FastifyReply) {
    const url = `${this.#base(req)}/a2a`;
    void reply.header('cache-control', 'public, max-age=300');
    return {
      name: 'DiRouter',
      description:
        'An LLM gateway as an agent: send a message and one of the models available to your key answers it. Choose the model with metadata.model.',
      supportedInterfaces: [
        { url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        { url, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
      ],
      provider: { organization: 'DiRouter', url: this.#base(req) },
      version: '1.0.0',
      capabilities: { streaming: false, pushNotifications: false },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [
        {
          id: 'chat',
          name: 'Answer with a language model',
          description:
            'Answers the message with the model named in metadata.model (or the gateway default), keeping the conversation of the context.',
          tags: ['llm', 'chat'],
          examples: ['Summarize this paragraph', 'Translate to Persian'],
        },
      ],
    };
  }

  #key(req: FastifyRequest): { config: LoadedConfig; key: VirtualKeyConfig } {
    const config = this.options.store.current;
    if (!config) throw new A2aError(-32603, 'Gateway has no configuration yet');
    return {
      config,
      key: authenticate(config, extractApiKey(req.headers), this.options.pepper, req.ip),
    };
  }

  async #authenticated(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ config: LoadedConfig; key: VirtualKeyConfig } | undefined> {
    try {
      return this.#key(req);
    } catch (error) {
      const status = error instanceof DiRouterError ? error.status : 503;
      await reply
        .status(status)
        .send(rpcError(null, -32001, error instanceof Error ? error.message : 'unauthenticated'));
      return undefined;
    }
  }

  // ───────────── DiRouter's own agent ─────────────

  async #rpc(req: FastifyRequest, reply: FastifyReply) {
    const auth = await this.#authenticated(req, reply);
    if (!auth) return reply;
    const message = req.body as Rpc;
    if (
      typeof message !== 'object' ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string'
    )
      return reply.send(rpcError(message.id ?? null, -32600, 'Invalid request'));
    const version: Version = message.method in V1_METHODS ? '1.0' : '0.3';
    const operation = V1_METHODS[message.method] ?? V03_METHODS[message.method];
    const header = String(req.headers['a2a-version'] ?? '');
    if (header && !header.startsWith('1.') && !header.startsWith('0.3'))
      return reply.send(rpcError(message.id, -32009, `A2A version ${header} is not supported`));
    try {
      if (!operation) throw new A2aError(-32601, `Method not found: ${message.method}`);
      const result = await this.#operate(operation, version, message.params ?? {}, auth.key, req);
      return await reply.send({ jsonrpc: '2.0', id: message.id ?? null, result });
    } catch (error) {
      if (error instanceof A2aError)
        return reply.send(rpcError(message.id, error.code, error.message));
      this.options.logger.error({ err: error }, 'A2A request failed');
      return reply.send(rpcError(message.id, -32603, 'Internal error'));
    }
  }

  async #operate(
    operation: string,
    version: Version,
    params: Record<string, unknown>,
    key: VirtualKeyConfig,
    req: FastifyRequest,
  ) {
    const owner = { organizationId: key.organizationId, projectId: key.projectId };
    switch (operation) {
      case 'send': {
        const task = await this.#send(params, key, req, owner);
        const view = taskView(
          task,
          version,
          (params.configuration as { historyLength?: number } | undefined)?.historyLength,
        );
        return version === '1.0' ? { task: view } : view;
      }
      case 'get': {
        const task = await this.#load(typeof params.id === 'string' ? params.id : '', owner);
        return taskView(
          task,
          version,
          typeof params.historyLength === 'number' ? params.historyLength : undefined,
        );
      }
      case 'cancel': {
        await this.#load(typeof params.id === 'string' ? params.id : '', owner);
        // Answers are produced within the request, so a stored task is always finished.
        throw new A2aError(-32002, 'Task is already in a terminal state');
      }
      case 'list':
        return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 };
      default:
        throw new A2aError(-32007, 'Extended agent card is not configured');
    }
  }

  async #send(
    params: Record<string, unknown>,
    key: VirtualKeyConfig,
    req: FastifyRequest,
    owner: StoredTask['owner'],
  ): Promise<StoredTask> {
    this.stats.messages++;
    const message = params.message as Record<string, unknown> | undefined;
    const text = messageText(message);
    if (!message || !text)
      throw new A2aError(-32602, 'message with at least one text part is required');
    const contextId =
      typeof message.contextId === 'string' && message.contextId ? message.contextId : randomUUID();
    const history = await this.#context(contextId, owner);
    const userMessage = {
      role: 'user' as const,
      text,
      messageId: typeof message.messageId === 'string' ? message.messageId : randomUUID(),
    };
    const metadata = {
      ...(params.metadata as object | undefined),
      ...(message.metadata as object | undefined),
    } as {
      model?: unknown;
    };
    const model =
      typeof metadata.model === 'string' && metadata.model
        ? metadata.model
        : this.options.store.current?.snapshot.settings.a2a?.defaultModel;
    const task: StoredTask = {
      id: randomUUID(),
      contextId,
      state: 'completed',
      history: [...history, userMessage].slice(-MAX_CONTEXT_MESSAGES),
      timestamp: new Date().toISOString(),
      owner,
    };
    if (!model) {
      task.state = 'rejected';
      task.statusText =
        'No model: set metadata.model (or the gateway default in settings.a2a.defaultModel).';
    } else {
      // Through the gateway's own endpoint, with the caller's key: every rule applies.
      const res = await this.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: req.headers.authorization ?? `Bearer ${extractApiKey(req.headers) ?? ''}`,
          'content-type': 'application/json',
          'x-forwarded-for': req.ip,
        },
        payload: {
          model,
          messages: task.history.map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.text,
          })),
        },
      });
      const body = res.json<{
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      }>();
      const answer = body.choices?.[0]?.message?.content;
      if (res.statusCode === 200 && typeof answer === 'string') {
        task.answer = answer;
        task.history.push({ role: 'agent', text: answer, messageId: `${task.id}-answer` });
      } else {
        task.state = 'failed';
        task.statusText =
          body.error?.message ?? `The model call failed (HTTP ${String(res.statusCode)})`;
      }
    }
    await this.#save(task);
    return task;
  }

  // ───────────── Task store ─────────────

  async #get(key: string): Promise<string | null> {
    if (this.options.redis) return this.options.redis.get(key).catch(() => null);
    const hit = this.#local.get(key);
    return hit && hit.until > Date.now() ? hit.value : null;
  }

  async #set(key: string, value: string): Promise<void> {
    if (this.options.redis) {
      await this.options.redis.set(key, value, 'EX', TASK_TTL_SECONDS).catch(() => undefined);
      return;
    }
    this.#local.set(key, { value, until: Date.now() + TASK_TTL_SECONDS * 1000 });
    if (this.#local.size > 10_000) this.#local.delete(this.#local.keys().next().value ?? '');
  }

  async #save(task: StoredTask) {
    await this.#set(`a2a:task:${task.id}`, JSON.stringify(task));
    await this.#set(
      `a2a:ctx:${task.contextId}`,
      JSON.stringify({ owner: task.owner, history: task.history }),
    );
  }

  /** A task the caller's project owns; anything else does not exist for it. */
  async #load(id: string, owner: StoredTask['owner']): Promise<StoredTask> {
    const raw = id ? await this.#get(`a2a:task:${id}`) : null;
    const task = raw ? (JSON.parse(raw) as StoredTask) : undefined;
    if (
      task?.owner.organizationId !== owner.organizationId ||
      task.owner.projectId !== owner.projectId
    )
      throw new A2aError(-32001, 'Task not found');
    return task;
  }

  async #context(contextId: string, owner: StoredTask['owner']): Promise<StoredTask['history']> {
    const raw = await this.#get(`a2a:ctx:${contextId}`);
    if (!raw) return [];
    const ctx = JSON.parse(raw) as { owner: StoredTask['owner']; history: StoredTask['history'] };
    // Another project's context id starts a fresh conversation instead of reading it.
    return ctx.owner.organizationId === owner.organizationId &&
      ctx.owner.projectId === owner.projectId
      ? ctx.history
      : [];
  }

  // ───────────── External agents ─────────────

  #agent(config: LoadedConfig, key: VirtualKeyConfig, slug: string): McpServerConfig | undefined {
    return config.snapshot.mcpServers.find(
      (s) =>
        s.enabled &&
        s.transport === 'a2a' &&
        s.slug === slug &&
        s.organizationId === key.organizationId,
    );
  }

  #headers(
    config: LoadedConfig,
    agent: McpServerConfig,
    key: VirtualKeyConfig,
    req: FastifyRequest,
  ) {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(typeof req.headers['a2a-version'] === 'string'
        ? { 'a2a-version': req.headers['a2a-version'] }
        : {}),
      ...(agent.headers
        ? (JSON.parse(config.secret(`mcp:${agent.id}`, agent.headers)) as Record<string, string>)
        : {}),
      ...(agent.forwardIdentity
        ? {
            'x-dirouter-organization-id': key.organizationId,
            'x-dirouter-project-id': key.projectId,
            'x-dirouter-key-id': key.id,
          }
        : {}),
    };
  }

  async #remoteCard(req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) {
    const auth = await this.#authenticated(req, reply);
    if (!auth) return reply;
    const agent = this.#agent(auth.config, auth.key, req.params.slug);
    if (!agent || !mcpToolAllowed(auth.key.mcpTools, `${agent.slug}${MCP_TOOL_SEPARATOR}*`))
      return reply.status(404).send({ error: 'agent not found' });
    // An agent mounted under a path serves its card there; otherwise at the origin root.
    let res: Response | undefined;
    for (const candidate of [
      `${agent.url.replace(/\/+$/, '')}/.well-known/agent-card.json`,
      new URL('/.well-known/agent-card.json', agent.url).toString(),
    ]) {
      res = await fetch(candidate, {
        headers: this.#headers(auth.config, agent, auth.key, req),
        signal: AbortSignal.timeout(agent.timeoutMs),
      }).catch(() => undefined);
      if (res?.ok) break;
    }
    if (!res?.ok) return reply.status(502).send({ error: 'agent card unavailable' });
    const card = (await res.json()) as Record<string, unknown>;
    const url = `${this.#base(req)}/a2a/agents/${agent.slug}`;
    // Clients talk to DiRouter with their DiRouter key; the agent's own address and auth stay hidden.
    return {
      ...card,
      ...(Array.isArray(card.supportedInterfaces)
        ? {
            supportedInterfaces: (card.supportedInterfaces as Record<string, unknown>[])
              .filter((i) => i.protocolBinding === 'JSONRPC')
              .map((i) => ({ ...i, url })),
          }
        : {}),
      ...(typeof card.url === 'string'
        ? { url, preferredTransport: 'JSONRPC', additionalInterfaces: [] }
        : {}),
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    };
  }

  async #proxy(req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) {
    const auth = await this.#authenticated(req, reply);
    if (!auth) return reply;
    const message = req.body as Rpc;
    const agent = this.#agent(auth.config, auth.key, req.params.slug);
    const started = Date.now();
    const record = (status: McpCallRecord['status'], errorMessage?: string) =>
      this.options.record?.({
        id: randomUUID(),
        occurredAt: new Date(started).toISOString(),
        organizationId: auth.key.organizationId,
        projectId: auth.key.projectId,
        virtualKeyId: auth.key.id,
        serverId: agent?.id ?? req.params.slug,
        tool: `a2a:${message.method ?? '?'}`,
        arguments: maskArguments({
          text: messageText((message.params as { message?: unknown } | undefined)?.message),
        }),
        status,
        ...(errorMessage ? { errorMessage: errorMessage.slice(0, 500) } : {}),
        latencyMs: Date.now() - started,
        gatewayInstance: this.options.instance,
      });
    if (!agent || !mcpToolAllowed(auth.key.mcpTools, `${agent.slug}${MCP_TOOL_SEPARATOR}*`)) {
      if (agent) {
        this.stats.denied++;
        record('denied');
      }
      return reply.status(404).send(rpcError(message.id ?? null, -32601, 'Agent not found'));
    }
    this.stats.proxied++;
    const res = await fetch(agent.url, {
      method: 'POST',
      headers: this.#headers(auth.config, agent, auth.key, req),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(agent.timeoutMs),
    }).catch((error: unknown) => error as Error);
    if (res instanceof Error) {
      record('error', res.message);
      return reply.status(502).send(rpcError(message.id ?? null, -32603, 'Agent unreachable'));
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      record('error', `non-JSON answer (HTTP ${String(res.status)})`);
      return reply.status(502).send(rpcError(message.id ?? null, -32006, 'Invalid agent response'));
    }
    const failed = (body as { error?: { message?: string } }).error;
    record(failed || !res.ok ? 'error' : 'success', failed?.message);
    return reply.status(res.status).send(body);
  }
}
