/**
 * Agent-to-agent (A2A) protocol (cards 20.3 and 28.2).
 *
 * DiRouter as an agent: the Agent Card at `/.well-known/agent-card.json`, JSON-RPC at `/a2a`. A
 * message is answered by the gateway's own `/v1/chat/completions` with the caller's key, so routing,
 * fallback, budgets, the prepaid wallet and usage logging apply exactly as for any other request.
 * Tasks (and the conversation of their context) are kept in Valkey for a day and are visible only
 * to the project that created them.
 *
 * Card 28.2 completes A2A 1.0:
 * - `SendStreamingMessage` (v0.3 `message/stream`) answers over SSE: the Task first, then status
 *   and artifact updates (the model's answer streamed chunk by chunk), closing at a terminal state.
 * - `SubscribeToTask` (v0.3 `tasks/resubscribe`) streams a running task from any replica (events
 *   travel over Valkey pub/sub); a finished task answers UnsupportedOperationError.
 * - `SendMessage` with `returnImmediately` (v0.3 `blocking: false`) returns the task at once and
 *   finishes it in the background; `CancelTask` cancels a running one.
 * - Push notification configs (`Create/Get/List/DeleteTaskPushNotificationConfig`, v0.3
 *   `tasks/pushNotificationConfig/*`, or `configuration.taskPushNotificationConfig` on a send):
 *   webhooks validated against SSRF and called with a signed payload on every status change
 *   (see push.ts).
 * - The `A2A-Version` header (or query parameter) is negotiated as Major.Minor: 1.0 and 0.3 are
 *   spoken, anything else is VersionNotSupportedError (-32009); empty means 0.3, per the spec, but
 *   the method name decides the wire format so v1.0 clients that omit it keep working.
 *
 * External agents registered with transport `a2a` are proxied at `/a2a/agents/<slug>` under the
 * same key allowlist (`<slug>__*`) and call log as MCP tools; their card is served with the
 * interface URL rewritten to DiRouter, and their SSE answers are passed through.
 */
import { randomUUID } from 'node:crypto';

import {
  MCP_TOOL_SEPARATOR,
  type McpCallRecord,
  type McpServerConfig,
  mcpToolAllowed,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { decrypt, DiRouterError, encrypt, type Keyring, type Logger } from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

import { authenticate, extractApiKey } from '../auth.js';
import type { ConfigStore, LoadedConfig } from '../config-store.js';
import { maskArguments } from '../mcp/mask.js';
import { guardedOrganization, tenantFetch } from '../upstream.js';
import { A2aError, type State, type StoredTask, TERMINAL, type Version } from './common.js';
import {
  checkWebhookUrl,
  deliverPush,
  MAX_PUSH_CONFIGS,
  type PushConfig,
  pushConfigView,
  PushSigner,
  readPushConfig,
} from './push.js';

export type { StoredTask } from './common.js';

const TASK_TTL_SECONDS = 24 * 3600;
const MAX_CONTEXT_MESSAGES = 40;
const HEARTBEAT_MS = 15_000;
const SUPPORTED_VERSIONS = new Set<string>(['1.0', '0.3']);

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const V1_METHODS: Record<string, string> = {
  SendMessage: 'send',
  SendStreamingMessage: 'stream',
  GetTask: 'get',
  CancelTask: 'cancel',
  ListTasks: 'list',
  SubscribeToTask: 'subscribe',
  CreateTaskPushNotificationConfig: 'pushSet',
  GetTaskPushNotificationConfig: 'pushGet',
  ListTaskPushNotificationConfigs: 'pushList',
  DeleteTaskPushNotificationConfig: 'pushDelete',
  GetExtendedAgentCard: 'card',
};
const V03_METHODS: Record<string, string> = {
  'message/send': 'send',
  'message/stream': 'stream',
  'tasks/get': 'get',
  'tasks/cancel': 'cancel',
  'tasks/resubscribe': 'subscribe',
  'tasks/pushNotificationConfig/set': 'pushSet',
  'tasks/pushNotificationConfig/get': 'pushGet',
  'tasks/pushNotificationConfig/list': 'pushList',
  'tasks/pushNotificationConfig/delete': 'pushDelete',
};

/** What happens to a task, delivered to SSE streams, subscribers and push notifications. */
export type TaskEvent =
  | { type: 'task'; task: StoredTask }
  | { type: 'status'; task: StoredTask }
  | {
      type: 'artifact';
      taskId: string;
      contextId: string;
      text: string;
      append: boolean;
      lastChunk: boolean;
    };

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

function statusView(task: StoredTask, version: Version) {
  if (version === '1.0')
    return {
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
    };
  return {
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
  };
}

const artifactView = (taskId: string, text: string, version: Version) => ({
  artifactId: `${taskId}-answer`,
  name: 'answer',
  parts: [version === '1.0' ? { text } : { kind: 'text', text }],
});

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
      status: statusView(task, version),
      ...(task.answer ? { artifacts: [artifactView(task.id, task.answer, version)] } : {}),
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
    status: statusView(task, version),
    ...(task.answer ? { artifacts: [artifactView(task.id, task.answer, version)] } : {}),
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

/**
 * One event as a streaming result: v1.0 wraps it in a `StreamResponse` (`task`, `statusUpdate`,
 * `artifactUpdate`); v0.3 sends the Task or a `status-update` / `artifact-update` with `kind`.
 */
export function streamEventView(event: TaskEvent, version: Version, historyLength?: number) {
  if (event.type === 'task') {
    const task = taskView(event.task, version, historyLength);
    return version === '1.0' ? { task } : task;
  }
  if (event.type === 'status') {
    const update = {
      taskId: event.task.id,
      contextId: event.task.contextId,
      status: statusView(event.task, version),
    };
    return version === '1.0'
      ? { statusUpdate: update }
      : { kind: 'status-update', ...update, final: TERMINAL.has(event.task.state) };
  }
  const update = {
    taskId: event.taskId,
    contextId: event.contextId,
    artifact: artifactView(event.taskId, event.text, version),
    append: event.append,
    lastChunk: event.lastChunk,
  };
  return version === '1.0' ? { artifactUpdate: update } : { kind: 'artifact-update', ...update };
}

/** `data:` payloads of an SSE body, as they arrive. */
async function* sseData(stream: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  }
}

export interface A2aOptions {
  store: ConfigStore;
  pepper: string;
  logger: Logger;
  instance: string;
  /** Signs push notifications and encrypts their stored configurations. */
  keyring: Keyring;
  redis?: Redis | undefined;
  record?: (call: McpCallRecord) => void;
  /** Tests only: delays between push retries. */
  pushRetryDelaysMs?: readonly number[];
}

/** What the model call needs from the original request, kept for background runs. */
interface Caller {
  authorization: string;
  ip: string;
}

export class A2aAgent {
  /** In-memory fallback when there is no Valkey (single node). */
  readonly #local = new Map<string, { value: string; until: number }>();
  readonly #listeners = new Map<string, Set<(event: TaskEvent) => void>>();
  readonly #running = new Map<string, AbortController>();
  readonly #pushChains = new Map<string, Promise<void>>();
  readonly #origin = randomUUID();
  readonly #signer: PushSigner;
  #subscriber: Redis | undefined;
  readonly stats = {
    messages: 0,
    proxied: 0,
    denied: 0,
    streams: 0,
    pushSent: 0,
    pushFailed: 0,
  };

  constructor(
    private readonly app: FastifyInstance,
    private readonly options: A2aOptions,
  ) {
    this.#signer = new PushSigner(options.keyring);
  }

  register(): void {
    this.app.get('/.well-known/agent-card.json', (req, reply) => this.#card(req, reply));
    // v0.3 clients look here first.
    this.app.get('/.well-known/agent.json', (req, reply) => this.#card(req, reply));
    // Public key of the push notification signatures.
    this.app.get('/.well-known/jwks.json', (_req, reply) => {
      void reply.header('cache-control', 'public, max-age=300');
      return { keys: [this.#signer.jwk] };
    });
    this.app.post('/a2a', (req, reply) => this.#rpc(req, reply));
    this.app.get<{ Params: { slug: string } }>(
      '/a2a/agents/:slug/.well-known/agent-card.json',
      (req, reply) => this.#remoteCard(req, reply),
    );
    this.app.post<{ Params: { slug: string } }>('/a2a/agents/:slug', (req, reply) =>
      this.#proxy(req, reply),
    );
    this.app.addHook('onClose', async () => {
      for (const controller of this.#running.values()) controller.abort();
      this.#subscriber?.disconnect();
      await Promise.allSettled([...this.#pushChains.values()]);
    });
  }

  /** Resolves when every push notification queued so far has been attempted (tests). */
  async pushesSettled(): Promise<void> {
    await Promise.allSettled([...this.#pushChains.values()]);
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
      version: '1.1.0',
      capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: false },
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

  /** `A2A-Version` from the header or the query parameter; Major.Minor, patch ignored. */
  #requestedVersion(req: FastifyRequest): { ok: boolean; raw: string } {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const header = req.headers['a2a-version'];
    const param = query['A2A-Version'];
    const raw = (
      typeof header === 'string' ? header : typeof param === 'string' ? param : ''
    ).trim();
    if (!raw) return { ok: true, raw };
    const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(raw);
    return { ok: Boolean(match && SUPPORTED_VERSIONS.has(`${match[1]}.${match[2]}`)), raw };
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
    const requested = this.#requestedVersion(req);
    if (!requested.ok)
      return reply.send(
        rpcError(message.id, -32009, `A2A version ${requested.raw} is not supported`),
      );
    void reply.header('a2a-version', version);
    try {
      if (!operation) throw new A2aError(-32601, `Method not found: ${message.method}`);
      if (operation === 'stream' || operation === 'subscribe')
        return await this.#streaming(operation, version, message, auth.key, req, reply);
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
    const configuration = (params.configuration ?? {}) as {
      historyLength?: number;
      returnImmediately?: boolean;
      blocking?: boolean;
    };
    switch (operation) {
      case 'send': {
        const { task, model } = await this.#prepare(params, version, owner, req);
        const caller = this.#caller(req);
        const background =
          version === '1.0'
            ? configuration.returnImmediately === true
            : configuration.blocking === false;
        let result = task;
        if (!model) result = await this.#reject(task);
        else if (background) {
          // Answered at once; the task finishes on its own (watch it with GetTask, a
          // subscription or a push notification).
          void this.#execute(task, model, caller, false).catch((error: unknown) => {
            this.options.logger.error({ err: error, task: task.id }, 'A2A background task failed');
          });
        } else result = await this.#execute(task, model, caller, false);
        const view = taskView(result, version, configuration.historyLength);
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
      case 'cancel':
        return taskView(
          await this.#cancel(typeof params.id === 'string' ? params.id : '', owner),
          version,
        );
      case 'list':
        return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 };
      case 'pushSet':
        return this.#pushSet(params, version, owner, req);
      case 'pushGet':
      case 'pushList':
      case 'pushDelete':
        return this.#pushRead(operation, params, version, owner);
      default:
        throw new A2aError(-32007, 'Extended agent card is not configured');
    }
  }

  #caller(req: FastifyRequest): Caller {
    return {
      authorization: req.headers.authorization ?? `Bearer ${extractApiKey(req.headers) ?? ''}`,
      ip: req.ip,
    };
  }

  /** Validates a send, stores its push configuration and the submitted task. */
  async #prepare(
    params: Record<string, unknown>,
    version: Version,
    owner: StoredTask['owner'],
    req: FastifyRequest,
  ): Promise<{ task: StoredTask; model: string | undefined }> {
    this.stats.messages++;
    const message = params.message as Record<string, unknown> | undefined;
    const text = messageText(message);
    if (!message || !text)
      throw new A2aError(-32602, 'message with at least one text part is required');
    const configuration = (params.configuration ?? {}) as Record<string, unknown>;
    const pushRaw =
      version === '1.0'
        ? configuration.taskPushNotificationConfig
        : configuration.pushNotificationConfig;
    const push = pushRaw ? await this.#validPush(pushRaw, version, owner, req) : undefined;
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
    } as { model?: unknown };
    const model =
      typeof metadata.model === 'string' && metadata.model
        ? metadata.model
        : this.options.store.current?.snapshot.settings.a2a?.defaultModel;
    const task: StoredTask = {
      id: randomUUID(),
      contextId,
      state: 'submitted',
      history: [...history, userMessage].slice(-MAX_CONTEXT_MESSAGES),
      timestamp: new Date().toISOString(),
      owner,
    };
    await this.#save(task);
    if (push) await this.#savePushConfigs(task.id, [push]);
    return { task, model };
  }

  async #setState(task: StoredTask, state: State, statusText?: string): Promise<void> {
    task.state = state;
    task.timestamp = new Date().toISOString();
    if (statusText) task.statusText = statusText;
    else delete task.statusText;
    await this.#save(task);
    this.#emit({ type: 'status', task });
  }

  async #reject(task: StoredTask): Promise<StoredTask> {
    await this.#setState(
      task,
      'rejected',
      'No model: set metadata.model (or the gateway default in settings.a2a.defaultModel).',
    );
    return task;
  }

  /**
   * Runs the model for a submitted task and finishes it. With `stream`, the answer is streamed
   * and every chunk becomes an artifact update (the last one marked `lastChunk`).
   */
  async #execute(
    task: StoredTask,
    model: string,
    caller: Caller,
    stream: boolean,
  ): Promise<StoredTask> {
    const controller = new AbortController();
    this.#running.set(task.id, controller);
    try {
      await this.#setState(task, 'working');
      const outcome = await this.#callModel(task, model, caller, stream, controller.signal).catch(
        (error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
          answer: undefined,
        }),
      );
      // Canceled meanwhile (here or on another replica): the cancellation stands.
      const current = await this.#peek(task.id);
      if (current?.state === 'canceled' || controller.signal.aborted)
        return current ?? { ...task, state: 'canceled' };
      if (typeof outcome.answer === 'string') {
        task.answer = outcome.answer;
        task.history.push({ role: 'agent', text: outcome.answer, messageId: `${task.id}-answer` });
        await this.#setState(task, 'completed');
      } else {
        await this.#setState(task, 'failed', outcome.error ?? 'The model call failed');
      }
      return task;
    } finally {
      this.#running.delete(task.id);
    }
  }

  async #callModel(
    task: StoredTask,
    model: string,
    caller: Caller,
    stream: boolean,
    signal: AbortSignal,
  ): Promise<{ answer?: string | undefined; error?: string }> {
    // Through the gateway's own endpoint, with the caller's key: every rule applies.
    const request = {
      method: 'POST' as const,
      url: '/v1/chat/completions',
      headers: {
        authorization: caller.authorization,
        'content-type': 'application/json',
        'x-forwarded-for': caller.ip,
      },
      payload: {
        model,
        messages: task.history.map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.text,
        })),
        ...(stream ? { stream: true } : {}),
      },
      signal,
    };
    const failure = (text: string, status: number) => {
      let message: string | undefined;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
      } catch {
        message = undefined;
      }
      return { error: message ?? `The model call failed (HTTP ${String(status)})` };
    };
    if (!stream) {
      const res = await this.app.inject(request);
      const answer = res.json<{ choices?: { message?: { content?: string } }[] }>().choices?.[0]
        ?.message?.content;
      return res.statusCode === 200 && typeof answer === 'string'
        ? { answer }
        : failure(res.body, res.statusCode);
    }
    const res = await this.app.inject({ ...request, payloadAsStream: true });
    const body = res.stream();
    if (res.statusCode !== 200) {
      let text = '';
      for await (const chunk of body) text += String(chunk);
      return failure(text, res.statusCode);
    }
    let answer = '';
    let held: string | undefined;
    let sent = 0;
    const flush = (text: string, lastChunk: boolean) => {
      this.#emit({
        type: 'artifact',
        taskId: task.id,
        contextId: task.contextId,
        text,
        append: sent > 0,
        lastChunk,
      });
      sent++;
    };
    for await (const data of sseData(body as AsyncIterable<Buffer>)) {
      if (data === '[DONE]') break;
      let event: { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        continue;
      }
      if (event.error) return { error: event.error.message ?? 'The model stream failed' };
      const delta = event.choices?.[0]?.delta?.content;
      if (!delta) continue;
      answer += delta;
      // One chunk is held back so the last one can say it is the last.
      if (held !== undefined) flush(held, false);
      held = delta;
    }
    flush(held ?? '', true);
    return { answer };
  }

  async #cancel(id: string, owner: StoredTask['owner']): Promise<StoredTask> {
    const task = await this.#load(id, owner);
    if (TERMINAL.has(task.state)) throw new A2aError(-32002, 'Task is already in a terminal state');
    this.#running.get(task.id)?.abort();
    await this.#setState(task, 'canceled', 'Canceled by the client');
    return task;
  }

  // ───────────── Streaming (SSE) ─────────────

  async #streaming(
    operation: 'stream' | 'subscribe',
    version: Version,
    message: Rpc,
    key: VirtualKeyConfig,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const owner = { organizationId: key.organizationId, projectId: key.projectId };
    const params = message.params ?? {};
    const historyLength = (params.configuration as { historyLength?: number } | undefined)
      ?.historyLength;
    // Everything that can be refused is checked before the stream opens (a JSON-RPC error then).
    let prepared: { task: StoredTask; model: string | undefined } | undefined;
    let taskId: string;
    if (operation === 'stream') {
      prepared = await this.#prepare(params, version, owner, req);
      taskId = prepared.task.id;
    } else {
      const existing = await this.#load(typeof params.id === 'string' ? params.id : '', owner);
      if (TERMINAL.has(existing.state))
        throw new A2aError(-32004, 'Task is in a terminal state and has no updates to stream');
      taskId = existing.id;
    }
    this.stats.streams++;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'a2a-version': version,
    });
    let open = true;
    const write = (event: TaskEvent) => {
      if (!open) return;
      raw.write(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result: streamEventView(event, version, historyLength) })}\n\n`,
      );
      if (event.type !== 'artifact' && TERMINAL.has(event.task.state)) close();
    };
    // Events that arrive before the first one (the Task) is written wait for it.
    let queue: TaskEvent[] | undefined = [];
    const unlisten = this.#listen(taskId, (event) => {
      if (queue) queue.push(event);
      else write(event);
    });
    const heartbeat = setInterval(() => {
      if (open) raw.write(': keep-alive\n\n');
    }, HEARTBEAT_MS);
    function close() {
      if (!open) return;
      open = false;
      clearInterval(heartbeat);
      unlisten();
      raw.end();
    }
    // The client going away ends the stream, not the task.
    req.raw.on('close', close);

    const first = prepared?.task ?? (await this.#peek(taskId));
    if (!first) {
      close();
      return reply;
    }
    write({ type: 'task', task: structuredClone(first) });
    const pending = queue;
    queue = undefined;
    for (const event of pending) write(event);
    if (prepared) {
      if (!prepared.model) await this.#reject(prepared.task);
      else await this.#execute(prepared.task, prepared.model, this.#caller(req), true);
    }
    return reply;
  }

  // ───────────── Events ─────────────

  /** Delivers an event here and, through Valkey, to subscribers on other replicas. */
  #emit(event: TaskEvent): void {
    const snapshot: TaskEvent =
      event.type === 'artifact' ? event : { ...event, task: structuredClone(event.task) };
    this.#deliver(snapshot);
    const taskId = snapshot.type === 'artifact' ? snapshot.taskId : snapshot.task.id;
    void this.options.redis
      ?.publish(`a2a:events:${taskId}`, JSON.stringify({ origin: this.#origin, event: snapshot }))
      .catch(() => undefined);
    if (snapshot.type === 'status') this.#notify(snapshot.task);
  }

  #deliver(event: TaskEvent): void {
    const taskId = event.type === 'artifact' ? event.taskId : event.task.id;
    for (const listener of this.#listeners.get(taskId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger.warn({ err: error }, 'A2A event listener failed');
      }
    }
  }

  #listen(taskId: string, listener: (event: TaskEvent) => void): () => void {
    let set = this.#listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.#listeners.set(taskId, set);
      void this.#remoteSubscribe(taskId, true);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.#listeners.get(taskId) === set) {
        this.#listeners.delete(taskId);
        void this.#remoteSubscribe(taskId, false);
      }
    };
  }

  async #remoteSubscribe(taskId: string, on: boolean): Promise<void> {
    const redis = this.options.redis;
    if (!redis) return;
    if (!this.#subscriber) {
      if (!on) return;
      const subscriber = redis.duplicate();
      subscriber.on('message', (_channel: string, raw: string) => {
        try {
          const { origin, event } = JSON.parse(raw) as { origin: string; event: TaskEvent };
          if (origin !== this.#origin) this.#deliver(event);
        } catch {
          // Not ours.
        }
      });
      subscriber.on('error', (error: unknown) => {
        this.options.logger.warn({ err: error }, 'A2A event subscriber error');
      });
      this.#subscriber = subscriber;
    }
    const channel = `a2a:events:${taskId}`;
    await (on ? this.#subscriber.subscribe(channel) : this.#subscriber.unsubscribe(channel)).catch(
      () => undefined,
    );
  }

  // ───────────── Push notifications ─────────────

  async #validPush(
    raw: unknown,
    version: Version,
    owner: StoredTask['owner'],
    req: FastifyRequest,
  ): Promise<PushConfig & { issuer: string }> {
    const { config } = readPushConfig(raw, version);
    const url = await checkWebhookUrl(config.url, guardedOrganization(owner.organizationId));
    return { ...config, url, id: config.id ?? randomUUID(), issuer: this.#base(req) };
  }

  async #pushSet(
    params: Record<string, unknown>,
    version: Version,
    owner: StoredTask['owner'],
    req: FastifyRequest,
  ) {
    const { taskId } = readPushConfig(params, version);
    const task = await this.#load(taskId ?? '', owner);
    const config = await this.#validPush(params, version, owner, req);
    const configs = (await this.#pushConfigs(task.id)).filter((c) => c.id !== config.id);
    if (configs.length >= MAX_PUSH_CONFIGS)
      throw new A2aError(-32602, `at most ${String(MAX_PUSH_CONFIGS)} push configs per task`);
    await this.#savePushConfigs(task.id, [...configs, config]);
    return pushConfigView(task.id, config, version);
  }

  async #pushRead(
    operation: 'pushGet' | 'pushList' | 'pushDelete',
    params: Record<string, unknown>,
    version: Version,
    owner: StoredTask['owner'],
  ) {
    // v1.0: {taskId, id}; v0.3: {id: <task id>, pushNotificationConfigId}.
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const taskId = (version === '1.0' ? str(params.taskId) : str(params.id)) ?? '';
    const configId = version === '1.0' ? str(params.id) : str(params.pushNotificationConfigId);
    const task = await this.#load(taskId, owner);
    const configs = await this.#pushConfigs(task.id);
    if (operation === 'pushList') {
      const views = configs.map((c) => pushConfigView(task.id, c, version));
      return version === '1.0' ? { configs: views, nextPageToken: '' } : views;
    }
    if (operation === 'pushDelete') {
      if (!configId) throw new A2aError(-32602, 'push notification config id is required');
      // Idempotent: deleting a missing config succeeds.
      await this.#savePushConfigs(
        task.id,
        configs.filter((c) => c.id !== configId),
      );
      return version === '1.0' ? {} : null;
    }
    const config = configId ? configs.find((c) => c.id === configId) : configs[0];
    if (!config) throw new A2aError(-32602, 'push notification config not found');
    return pushConfigView(task.id, config, version);
  }

  /** Sends the task's status change to its webhooks, in order, without holding anyone up. */
  #notify(task: StoredTask): void {
    const previous = this.#pushChains.get(task.id) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const configs = await this.#pushConfigs(task.id);
        for (const config of configs) {
          const terminal = TERMINAL.has(task.state);
          const payload =
            config.version === '1.0'
              ? terminal
                ? { task: taskView(task, '1.0') }
                : streamEventView({ type: 'status', task }, '1.0')
              : taskView(task, '0.3');
          const result = await deliverPush(
            {
              config,
              body: JSON.stringify(payload),
              taskId: task.id,
              issuer: config.issuer ?? '',
            },
            this.#signer,
            tenantFetch(task.owner.organizationId),
            this.options.pushRetryDelaysMs,
          );
          if (result.ok) this.stats.pushSent++;
          else {
            this.stats.pushFailed++;
            this.options.logger.warn(
              { task: task.id, status: result.status, error: result.error },
              'A2A push notification failed',
            );
          }
        }
      })
      .catch((error: unknown) => {
        this.options.logger.warn({ err: error, task: task.id }, 'A2A push notification failed');
      })
      .finally(() => {
        if (this.#pushChains.get(task.id) === next) this.#pushChains.delete(task.id);
      });
    this.#pushChains.set(task.id, next);
  }

  async #pushConfigs(taskId: string): Promise<(PushConfig & { issuer?: string })[]> {
    const raw = await this.#get(`a2a:push:${taskId}`);
    if (!raw) return [];
    try {
      return JSON.parse(decrypt(this.options.keyring, raw, `a2a-push:${taskId}`)) as (PushConfig & {
        issuer?: string;
      })[];
    } catch {
      return [];
    }
  }

  async #savePushConfigs(taskId: string, configs: PushConfig[]): Promise<void> {
    // Webhook credentials are secrets: stored encrypted, like everything else from tenants.
    await this.#set(
      `a2a:push:${taskId}`,
      encrypt(this.options.keyring, JSON.stringify(configs), `a2a-push:${taskId}`),
    );
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

  async #peek(id: string): Promise<StoredTask | undefined> {
    const raw = await this.#get(`a2a:task:${id}`);
    return raw ? (JSON.parse(raw) as StoredTask) : undefined;
  }

  /** A task the caller's project owns; anything else does not exist for it. */
  async #load(id: string, owner: StoredTask['owner']): Promise<StoredTask> {
    const task = id ? await this.#peek(id) : undefined;
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
      accept: 'application/json, text/event-stream',
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
    // A streaming answer (SendStreamingMessage, SubscribeToTask) is passed through as it comes.
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body) {
      record(res.ok ? 'success' : 'error');
      reply.hijack();
      reply.raw.writeHead(res.status, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      });
      try {
        for await (const chunk of res.body) reply.raw.write(chunk);
      } catch (error) {
        this.options.logger.warn({ err: error, agent: agent.slug }, 'A2A agent stream broke');
      }
      reply.raw.end();
      return reply;
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
