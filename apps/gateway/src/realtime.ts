/**
 * Realtime API over WebSocket (card 30.5): `GET /v1/realtime?model=…` with an upgrade, relayed to
 * a provider that serves realtime sessions, plus short-lived client secrets for browsers
 * (`POST /v1/realtime/client_secrets`, and the beta `POST /v1/realtime/sessions`).
 *
 * Opening a session runs the same checks as any request, answered with an HTTP status on the
 * handshake like OpenAI does: the virtual key (Bearer or `x-api-key` header, or the
 * `openai-insecure-api-key.<key>` subprotocol a browser uses with a client secret), the model and
 * its realtime capability, the per-replica session cap, the rate limit (the session counts as one
 * request), budgets, a wallet hold and the key's concurrency cap, which the session occupies for
 * its whole life. Targets are tried in order until one accepts the upgrade; once the session is
 * established there is no fallback.
 *
 * Events are relayed both ways unchanged, except that the model name is translated (DiRouter's
 * name to the client, the provider's to the upstream). Every `response.done` is metered from its
 * usage: text tokens as usual, audio tokens at the model's audio prices, and the event records
 * both shares of the cost. It goes to the usage pipeline at once (one usage event per response),
 * is added to budgets and the rate limit's token count, and is charged against the wallet, after
 * which the session must still be able to pay for another response. When a budget, the wallet or
 * a limit runs out the client gets an `error` event naming it and the session is closed.
 *
 * Closing is never a cut: a session that reaches its maximum length, runs out of budget, or is
 * still open when a draining gateway's deadline arrives lets the response in progress finish
 * (or cancels it, and still bills what it produced), sends the reason as an `error` event and
 * closes with a close frame. When the client goes away the response in progress is cancelled and
 * billed before the upstream socket is closed.
 */
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type {
  CanonicalUsage,
  MediaUsage,
  RetryPolicy,
  UpstreamErrorClass,
  UsageAttempt,
  UsageEvent,
  VirtualKeyConfig,
} from '@dirouter/contracts';
import { USAGE_EVENT_SCHEMA_VERSION } from '@dirouter/contracts';
import { audioTokenCost, computeCost } from '@dirouter/model-catalog';
import { realtimeTarget, supportsRealtime } from '@dirouter/providers';
import {
  type AttemptRecord,
  type Candidate,
  executeWithFallback,
  isRouteError,
} from '@dirouter/routing';
import {
  DiRouterError,
  ForbiddenError,
  formatUsd,
  NotFoundError,
  prefixedId,
  RateLimitError,
  ulid,
  ValidationError,
} from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Gauge } from 'prom-client';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

import { authenticate, extractApiKey } from './auth.js';
import type { LoadedConfig } from './config-store.js';
import { resolveCredentialKey, tokenFailure } from './credential-tokens.js';
import { chargeUnits, chargeUsd } from './pricing.js';
import { type ProxyDeps, toClientError } from './proxy.js';
import { budgetScopes, limitScopes } from './spend-guard.js';
import { MAX_REALTIME_MESSAGE_BYTES, openUpstream } from './realtime-upstream.js';
import {
  type ClientSecretClaims,
  DEFAULT_SECRET_TTL_SECONDS,
  isClientSecret,
  issueClientSecret,
  MAX_SECRET_SESSION_BYTES,
  MAX_SECRET_TTL_SECONDS,
  MIN_SECRET_TTL_SECONDS,
  verifyClientSecret,
} from './realtime-secrets.js';
import { mergeTimeouts } from './upstream.js';

export interface RealtimeSettings {
  /** Longest a session may last; OpenAI's own limit is 30 minutes. */
  maxSessionSeconds: number;
  /** Open sessions per gateway replica. */
  maxSessions: number;
  /** How long a closing session waits for the response in progress. */
  closeGraceMs: number;
}

export const DEFAULT_REALTIME_SETTINGS: RealtimeSettings = {
  maxSessionSeconds: 1_800,
  maxSessions: 1_000,
  closeGraceMs: 2_000,
};

/**
 * Wallet headroom a session keeps reserved, so it can always pay for the response it is producing:
 * this many audio tokens in and out at the most expensive candidate's price.
 */
const HEADROOM_INPUT_TOKENS = 8_192;
const HEADROOM_OUTPUT_TOKENS = 4_096;
const PING_INTERVAL_MS = 30_000;
const KEY_PROTOCOL = 'openai-insecure-api-key.';
const BETA_PROTOCOL = 'openai-beta.realtime-v1';

type Json = Record<string, unknown>;

const holdId = (sessionId: string) => `${sessionId}_hold`;

/** A frame as one text payload (`ws` hands over fragmented frames as a list). */
const text = (data: RawData | string): string | Buffer =>
  typeof data === 'string'
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);

const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;

// ───────────── Usage ─────────────

export interface RealtimeMetering {
  usage: CanonicalUsage;
  media: MediaUsage;
  /** The provider sent no usage; nothing could be counted. */
  estimated: boolean;
}

/**
 * Splits a `response.done` usage into text tokens (the canonical usage, images included) and audio
 * tokens (media). Without token details every token is text.
 */
export function realtimeUsage(raw: unknown): RealtimeMetering {
  const u = record(raw);
  const inDetails = record(u.input_token_details);
  const outDetails = record(u.output_token_details);
  const cachedDetails = record(inDetails.cached_tokens_details);
  const hasIn = Object.keys(inDetails).length > 0;
  const hasOut = Object.keys(outDetails).length > 0;
  const audioIn = hasIn ? count(inDetails.audio_tokens) : 0;
  const audioOut = hasOut ? count(outDetails.audio_tokens) : 0;
  const textIn = hasIn
    ? count(inDetails.text_tokens) + count(inDetails.image_tokens)
    : count(u.input_tokens);
  const textOut = hasOut ? count(outDetails.text_tokens) : count(u.output_tokens);
  const cachedTotal = count(inDetails.cached_tokens);
  const audioCached = Math.min(audioIn, count(cachedDetails.audio_tokens));
  const textCached = Math.min(
    textIn,
    Object.keys(cachedDetails).length > 0
      ? count(cachedDetails.text_tokens) + count(cachedDetails.image_tokens)
      : cachedTotal,
  );
  return {
    usage: {
      inputTokens: textIn,
      outputTokens: textOut,
      cacheReadTokens: textCached,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    media: {
      audioInputTokens: audioIn,
      audioOutputTokens: audioOut,
      ...(audioCached > 0 ? { audioCachedTokens: audioCached } : {}),
    },
    estimated: raw === undefined || raw === null,
  };
}

// ───────────── Handshake helpers ─────────────

/** An HTTP answer on the raw socket, for a handshake that is refused. */
function refuse(
  socket: Duplex,
  error: DiRouterError,
  requestId: string,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(error.toOpenAI());
  const extra = Object.entries({ ...headers, 'x-request-id': requestId })
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  if (socket.writable)
    socket.end(
      `HTTP/1.1 ${String(error.status)} ${STATUS_CODES[error.status] ?? 'Error'}\r\n` +
        `content-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\n` +
        `connection: close\r\n${extra}\r\n${body}`,
    );
  else socket.destroy();
}

interface Credential {
  value: string | undefined;
  beta: boolean;
}

function credentialOf(req: IncomingMessage): Credential {
  const protocols = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const fromProtocol = protocols
    .find((p) => p.startsWith(KEY_PROTOCOL))
    ?.slice(KEY_PROTOCOL.length);
  const azureKey = req.headers['api-key'];
  return {
    value:
      extractApiKey(req.headers) ??
      (typeof azureKey === 'string' ? azureKey.trim() : undefined) ??
      fromProtocol,
    beta:
      /realtime=v1/.test(String(req.headers['openai-beta'] ?? '')) ||
      protocols.includes(BETA_PROTOCOL),
  };
}

/** The client address as Fastify reports it with `trustProxy: true`. */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || '';
}

const errorEvent = (error: DiRouterError, eventId?: string): Json => ({
  type: 'error',
  event_id: `event_${ulid()}`,
  error: { ...error.toOpenAI().error, ...(eventId ? { event_id: eventId } : {}) },
});

/** Model names inside `session.*` events: DiRouter's to the client, the provider's upstream. */
function withModel(event: Json, model: string): Json | undefined {
  const session = record(event.session);
  if (typeof session.model !== 'string' || session.model === model) return undefined;
  return { ...event, session: { ...session, model } };
}

// ───────────── Session ─────────────

interface SessionContext {
  id: string;
  key: VirtualKeyConfig;
  config: LoadedConfig;
  requested: string;
  candidate: Candidate;
  connectAttempts: AttemptRecord[];
  started: number;
}

type EndKind = 'wait' | 'cancel';

class RealtimeSession {
  readonly id: string;
  #responses = 0;
  /** response id → started at, first delta at. */
  readonly #active = new Map<string, { started: number; firstDelta?: number }>();
  #idle: (() => void)[] = [];
  #ending: Promise<void> | undefined;
  #finalized = false;
  #timer: NodeJS.Timeout | undefined;
  #ping: NodeJS.Timeout | undefined;
  /** Bills of responses that are still being checked against budgets and the wallet. */
  #pendingChecks = 0;

  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly ctx: SessionContext,
    private readonly client: WebSocket,
    private readonly upstream: WebSocket,
    early: RawData[],
    private readonly cleanup: () => void,
    initial?: Json,
  ) {
    this.id = ctx.id;
    upstream.removeAllListeners('message');
    upstream.on('message', (data) => {
      this.#fromUpstream(data);
    });
    upstream.on('error', (error) => {
      this.gateway.logger.warn(
        { requestId: this.id, error: error.message },
        'realtime upstream socket error',
      );
    });
    upstream.once('close', (code, reason) => {
      this.#upstreamClosed(code, reason.toString());
    });
    client.on('message', (data) => {
      this.#fromClient(data);
    });
    client.on('error', () => undefined);
    client.once('close', () => {
      void this.end({ kind: 'cancel', code: 1000, reason: 'client closed' });
    });
    const max = gateway.settings.maxSessionSeconds;
    this.#timer = setTimeout(() => {
      void this.end({
        kind: 'wait',
        code: 1000,
        reason: 'session expired',
        error: new DiRouterError('invalid_request', {
          message: `Your session hit the maximum duration of ${String(max)} seconds.`,
          status: 400,
        }),
        errorCode: 'session_expired',
      });
    }, max * 1000);
    this.#timer.unref();
    this.#ping = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) client.ping();
      if (upstream.readyState === WebSocket.OPEN) upstream.ping();
    }, PING_INTERVAL_MS);
    this.#ping.unref();
    if (initial) this.#sendUpstream(initial);
    for (const data of early) this.#fromUpstream(data);
  }

  get activeResponses(): number {
    return this.#active.size;
  }

  /** Events are JSON text frames in both directions. */
  #send(ws: WebSocket, event: Json | RawData) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const raw =
      Buffer.isBuffer(event) || Array.isArray(event) || event instanceof ArrayBuffer
        ? text(event)
        : JSON.stringify(event);
    ws.send(raw, { binary: false });
  }

  #sendUpstream(event: Json | RawData) {
    this.#send(this.upstream, event);
  }

  #sendClient(event: Json | RawData) {
    this.#send(this.client, event);
  }

  #fromClient(data: RawData) {
    // A closing session takes no new work from the client.
    if (this.#ending) return;
    let event: Json;
    try {
      event = record(JSON.parse(text(data).toString()));
    } catch {
      this.#sendClient(
        errorEvent(
          new DiRouterError('invalid_request', {
            message: 'Events must be JSON objects with a type',
            status: 400,
          }),
        ),
      );
      return;
    }
    const rewritten =
      event.type === 'session.update'
        ? withModel(event, this.ctx.candidate.model.upstreamModel)
        : undefined;
    this.#sendUpstream(rewritten ?? data);
  }

  #fromUpstream(data: RawData) {
    let event: Json | undefined;
    try {
      event = record(JSON.parse(text(data).toString()));
    } catch {
      event = undefined;
    }
    if (!event) {
      this.#sendClient(data);
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    let out: Json | undefined;
    if (type === 'session.created' || type === 'session.updated')
      out = withModel(event, this.ctx.requested);
    else if (type === 'response.created') {
      const raw = record(event.response).id;
      const id = typeof raw === 'string' ? raw : '';
      this.#active.set(id, { started: Date.now() });
    } else if (type === 'response.done') {
      this.#sendClient(data);
      this.#responseDone(record(event.response));
      return;
    } else if (type.endsWith('.delta')) {
      const id = typeof event.response_id === 'string' ? event.response_id : undefined;
      const active = id ? this.#active.get(id) : undefined;
      if (active && active.firstDelta === undefined) active.firstDelta = Date.now();
    }
    this.#sendClient(out ?? data);
  }

  #responseDone(response: Json) {
    const id = typeof response.id === 'string' ? response.id : '';
    const timing = this.#active.get(id) ?? { started: Date.now() };
    this.#active.delete(id);
    const index = ++this.#responses;
    const { candidate, key, config } = this.ctx;
    const metering = realtimeUsage(response.usage);
    const model = candidate.model;
    const breakdown = computeCost(metering.usage, model.pricing, metering.media);
    const audio = audioTokenCost(metering.media, model.pricing);
    const media: MediaUsage = {
      ...metering.media,
      audioCostUsd: formatUsd(audio),
      textCostUsd: formatUsd(breakdown.total - audio),
      sessionId: this.id,
    };
    const costUsd = formatUsd(breakdown.total);
    const charged = chargeUsd(metering.usage, model, {
      groupMultiplier: key.priceMultiplier,
      media: metering.media,
    });
    const requestId = `${this.id}_${String(index)}`;
    const finished = Date.now();
    const status = response.status === 'failed' ? 'error' : 'success';
    const attempt: UsageAttempt = {
      providerId: candidate.provider.id,
      modelId: model.id,
      credentialId: candidate.credential.id,
      outcome: status === 'success' ? 'success' : 'error',
      latencyMs: finished - timing.started,
      startedAt: new Date(timing.started).toISOString(),
    };
    const event: UsageEvent = {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: ulid(),
      idempotencyKey: requestId,
      requestId,
      occurredAt: new Date(timing.started).toISOString(),
      gatewayInstance: this.gateway.deps.instance,
      configVersion: config.version,
      organizationId: key.organizationId,
      teamId: key.teamId,
      projectId: key.projectId,
      virtualKeyId: key.id,
      ...(key.walletId ? { walletId: key.walletId } : {}),
      inboundApi: 'openai.realtime',
      requestedModel: this.ctx.requested,
      resolvedModelId: model.id,
      providerId: candidate.provider.id,
      credentialId: candidate.credential.id,
      stream: true,
      status,
      httpStatus: 200,
      ...(status === 'error' ? { errorCode: 'response_failed' } : {}),
      usage: metering.usage,
      costUsd,
      chargeUsd: charged,
      usageEstimated: metering.estimated,
      media,
      latencyMs: finished - timing.started,
      ...(timing.firstDelta !== undefined ? { ttftMs: timing.firstDelta - timing.started } : {}),
      attempts: [
        ...(index === 1
          ? this.ctx.connectAttempts
              .filter((a) => a.outcome !== 'skipped' && a.outcome !== 'success')
              .map((a) => ({
                providerId: a.providerId,
                modelId: a.modelId,
                credentialId: a.credentialId,
                outcome: 'error' as const,
                ...(a.status !== undefined ? { httpStatus: a.status } : {}),
                ...(a.errorClass ? { errorCode: a.errorClass } : {}),
                latencyMs: a.latencyMs,
                startedAt: new Date(a.startedAt).toISOString(),
              }))
          : []),
        attempt,
      ],
    };
    const deps = this.gateway.deps;
    deps.metrics?.observe(event);
    deps.onRequestComplete?.(event);
    deps.emitUsage(event);
    if (metering.estimated)
      this.gateway.logger.warn(
        { requestId, provider: candidate.provider.slug },
        'realtime response without usage',
      );
    const tokens =
      metering.usage.inputTokens +
      metering.usage.outputTokens +
      (media.audioInputTokens ?? 0) +
      (media.audioOutputTokens ?? 0);
    this.#pendingChecks++;
    void this.gateway
      .settleResponse(this.ctx, requestId, { costUsd, charged, tokens })
      .then((stop) => {
        if (stop) void this.end({ kind: 'cancel', code: 1008, ...stop });
      })
      .catch((error: unknown) => {
        this.gateway.logger.warn(
          { requestId, error: error instanceof Error ? error.message : String(error) },
          'realtime response settlement failed',
        );
      })
      .finally(() => {
        this.#pendingChecks--;
        if (this.#active.size === 0) this.#notifyIdle();
      });
    if (this.#active.size === 0) this.#notifyIdle();
  }

  #notifyIdle() {
    if (this.#pendingChecks > 0) return;
    const waiting = this.#idle;
    this.#idle = [];
    for (const resolve of waiting) resolve();
  }

  /** Resolves once no response is in progress and every bill is checked, or after `ms`. */
  #waitIdle(ms: number): Promise<boolean> {
    if (this.#active.size === 0 && this.#pendingChecks === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, ms);
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Ends the session without cutting it: `wait` lets the response in progress finish (cancelling
   * it only if it outlasts the grace period), `cancel` cancels it at once; either way its usage is
   * billed before the sockets close.
   */
  end(options: {
    kind: EndKind;
    code: number;
    reason: string;
    error?: DiRouterError;
    errorCode?: string;
  }): Promise<void> {
    this.#ending ??= (async () => {
      clearTimeout(this.#timer);
      const grace = this.gateway.settings.closeGraceMs;
      if (this.#active.size > 0 && options.kind === 'cancel')
        this.#sendUpstream({ type: 'response.cancel', event_id: `event_${ulid()}` });
      if (!(await this.#waitIdle(grace)) && options.kind === 'wait') {
        this.#sendUpstream({ type: 'response.cancel', event_id: `event_${ulid()}` });
        await this.#waitIdle(grace);
      }
      if (options.error) {
        const event = errorEvent(options.error);
        if (options.errorCode) record(event.error).code = options.errorCode;
        this.#sendClient(event);
      }
      await Promise.all([
        closeSocket(this.client, options.code, options.reason),
        closeSocket(this.upstream, 1000, 'session closed'),
      ]);
      this.#finalize();
    })();
    return this.#ending;
  }

  #upstreamClosed(code: number, reason: string) {
    // The provider ended the session (its own limit, an error, or our close): pass it on.
    if (this.#ending) {
      // A closing session waits for the bill of a response the provider just finished.
      this.#active.clear();
      this.#notifyIdle();
      return;
    }
    this.#active.clear();
    const forwardable = code >= 1000 && code < 5000 && ![1005, 1006, 1015].includes(code);
    this.#ending = (async () => {
      clearTimeout(this.#timer);
      await closeSocket(this.client, forwardable ? code : 1011, reason || 'upstream closed');
      this.#finalize();
    })();
  }

  #finalize() {
    if (this.#finalized) return;
    this.#finalized = true;
    clearTimeout(this.#timer);
    clearInterval(this.#ping);
    this.cleanup();
  }

  /** Last resort (a plain `app.close()`): close both sockets now. */
  terminate() {
    this.client.terminate();
    this.upstream.terminate();
    this.#finalize();
  }
}

function closeSocket(ws: WebSocket, code: number, reason: string): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 1_000);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    if (ws.readyState === WebSocket.OPEN) ws.close(code, reason.slice(0, 120));
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  });
}

// ───────────── Gateway ─────────────

export class RealtimeGateway {
  readonly #sessions = new Set<RealtimeSession>();
  readonly #wss: WebSocketServer;
  readonly logger: ProxyDeps['logger'];

  constructor(
    readonly deps: ProxyDeps,
    readonly settings: RealtimeSettings = DEFAULT_REALTIME_SETTINGS,
  ) {
    this.logger = deps.logger;
    this.#wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: MAX_REALTIME_MESSAGE_BYTES,
      // A browser offers `realtime` next to its key; the key itself is never echoed back.
      handleProtocols: (protocols) => {
        if (protocols.has('realtime')) return 'realtime';
        for (const p of protocols) if (!p.startsWith(KEY_PROTOCOL)) return p;
        return false;
      },
    });
    deps.lifecycle?.signal.addEventListener(
      'abort',
      () => {
        void this.closeAll('wait');
      },
      { once: true },
    );
    this.#gauge = deps.metrics
      ? new Gauge({
          name: 'dirouter_realtime_sessions',
          help: 'Open Realtime WebSocket sessions on this replica',
          registers: [deps.metrics.registry],
        })
      : undefined;
  }

  readonly #gauge: Gauge | undefined;

  /** Open sessions on this replica. */
  get size(): number {
    return this.#sessions.size;
  }

  register(app: FastifyInstance): void {
    app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => undefined);
      void this.#upgrade(req, socket, head).catch((error: unknown) => {
        this.logger.error({ err: error }, 'realtime upgrade failed');
        socket.destroy();
      });
    });
    app.post('/v1/realtime/client_secrets', (req, reply) => this.#clientSecret(req, reply, false));
    app.post('/v1/realtime/sessions', (req, reply) => this.#clientSecret(req, reply, true));
    // A plain close (tests, a crash path) must not hang on open sockets; a drain closes them
    // itself, gracefully, before the server goes away.
    app.addHook('preClose', async () => {
      if (!this.deps.lifecycle?.draining) await this.closeAll('cancel');
    });
    app.addHook('onClose', () => {
      for (const session of this.#sessions) session.terminate();
      this.#wss.close();
    });
  }

  /** Ends every session gracefully (drain deadline, shutdown). */
  async closeAll(kind: EndKind): Promise<void> {
    await Promise.all(
      [...this.#sessions].map((session) =>
        session.end({
          kind,
          code: 1001,
          reason: 'gateway shutting down',
          error: new DiRouterError('service_unavailable', {
            message: 'The gateway is restarting; reconnect to continue.',
          }),
          errorCode: 'gateway_shutting_down',
        }),
      ),
    );
  }

  // ── Handshake ──

  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const deps = this.deps;
    const incoming = req.headers['x-request-id'];
    const sessionId =
      typeof incoming === 'string' && /^[\w.-]{1,100}$/.test(incoming)
        ? incoming
        : prefixedId('req');
    const url = new URL(req.url ?? '/', 'http://gateway');
    if (url.pathname !== '/v1/realtime' && url.pathname !== '/realtime') {
      refuse(socket, new NotFoundError('not_found', { message: 'Not found' }), sessionId);
      return;
    }
    if (deps.lifecycle?.draining) {
      refuse(
        socket,
        new DiRouterError('service_unavailable', { message: 'Gateway is shutting down' }),
        sessionId,
        { 'retry-after': '1' },
      );
      return;
    }
    const config = deps.store.current;
    if (!config) {
      refuse(
        socket,
        new DiRouterError('service_unavailable', { message: 'Gateway has no configuration yet' }),
        sessionId,
      );
      return;
    }

    // Key: a virtual key, or a client secret minted for one.
    const credential = credentialOf(req);
    let key: VirtualKeyConfig;
    let claims: ClientSecretClaims | undefined;
    try {
      if (credential.value && isClientSecret(credential.value)) {
        claims = verifyClientSecret(credential.value, deps.pepper);
        const found = claims
          ? config.snapshot.virtualKeys.find((k) => k.id === claims?.keyId)
          : undefined;
        if (
          !claims ||
          !found?.enabled ||
          found.organizationId !== claims.organizationId ||
          (found.expiresAt && Date.parse(found.expiresAt) <= Date.now())
        )
          throw new DiRouterError('invalid_api_key', {
            message: 'Invalid or expired client secret',
          });
        key = found;
      } else key = authenticate(config, credential.value, deps.pepper, clientIp(req));
    } catch (error) {
      refuse(
        socket,
        error instanceof DiRouterError ? error : new DiRouterError('unauthenticated'),
        sessionId,
      );
      return;
    }
    const beta = credential.beta || claims?.beta === true;
    const model = url.searchParams.get('model') ?? claims?.model;
    if (!model) {
      refuse(
        socket,
        new DiRouterError('invalid_request', {
          message: 'model is required',
          param: 'model',
          status: 400,
        }),
        sessionId,
      );
      return;
    }
    if (claims?.model && claims.model !== model) {
      refuse(
        socket,
        new DiRouterError('invalid_request', {
          message: `This client secret is for '${claims.model}'`,
          param: 'model',
          status: 400,
        }),
        sessionId,
      );
      return;
    }

    const selected = this.#candidates(config, key, model);
    if (selected instanceof DiRouterError) {
      refuse(socket, selected, sessionId);
      return;
    }
    const { candidates, fallbackOn, retry } = selected;

    if (this.#sessions.size >= this.settings.maxSessions) {
      deps.metrics?.reject('concurrency', 'realtime');
      refuse(
        socket,
        new DiRouterError('service_unavailable', {
          message: `This gateway replica is at its limit of ${String(this.settings.maxSessions)} realtime sessions`,
        }),
        sessionId,
        { 'retry-after': '1' },
      );
      return;
    }

    // Rate limit: the session counts as one request; its tokens are counted per response.
    const admission = deps.limiter
      ? await deps.limiter.acquire(limitScopes(config, key), 0, sessionId)
      : undefined;
    if (admission && !admission.ok) {
      deps.metrics?.reject('rate_limit', admission.unavailable ? 'unavailable' : admission.kind);
      refuse(
        socket,
        new RateLimitError({
          message: `Rate limit exceeded for ${admission.scope.split(':')[0] ?? 'key'} (${admission.kind})`,
          retryAfterMs: admission.retryAfterMs,
        }),
        sessionId,
        admission.headers,
      );
      return;
    }
    admission?.settle(0);
    admission?.release();

    const budgets = budgetScopes(config, key);
    const budgetCheck = deps.budgets ? await deps.budgets.check(budgets) : { ok: true as const };
    if (!budgetCheck.ok) {
      deps.metrics?.reject('budget', budgetCheck.unavailable ? 'unavailable' : budgetCheck.kind);
      refuse(socket, budgetError(budgetCheck), sessionId);
      return;
    }

    // Wallet: a hold for one response at the most expensive candidate's price.
    const walletId = key.walletId;
    const headroom = walletId ? this.#headroom(candidates, key) : '0';
    if (walletId && deps.wallets) {
      const reservation = await deps.wallets.reserve(walletId, holdId(sessionId), headroom);
      if (!reservation.ok) {
        deps.metrics?.reject('wallet', reservation.unavailable ? 'unavailable' : 'insufficient');
        refuse(
          socket,
          new DiRouterError('insufficient_credit', {
            message: reservation.unavailable
              ? 'Wallet check unavailable (fail-closed), retry shortly'
              : `Insufficient credit: a realtime session needs USD ${reservation.neededUsd} available, the wallet has USD ${reservation.availableUsd}`,
          }),
          sessionId,
        );
        return;
      }
    }
    const releaseHold = () => {
      if (walletId) deps.wallets?.settle(walletId, holdId(sessionId), '0');
    };

    const connecting = new AbortController();
    const onSocketClose = () => {
      connecting.abort(new Error('client disconnected'));
    };
    socket.once('close', onSocketClose);
    const keyBulkhead = deps.bulkheads?.get(`key:${key.id}`, key.rateLimit?.maxConcurrency, {});
    const releaseKey = keyBulkhead ? await keyBulkhead.acquire(connecting.signal) : () => undefined;
    if (!releaseKey) {
      releaseHold();
      deps.metrics?.reject('concurrency', 'key');
      refuse(
        socket,
        new RateLimitError({
          message: `Too many concurrent requests for this key (limit ${String(keyBulkhead?.limit)})`,
          retryAfterMs: 1_000,
        }),
        sessionId,
      );
      return;
    }

    const started = Date.now();
    const settings = config.snapshot.settings;
    const timeouts = mergeTimeouts(settings.defaultTimeouts, undefined);
    const handshakeMs = timeouts.connectMs + Math.min(timeouts.firstByteMs, 10_000);
    const result = await executeWithFallback(
      candidates,
      async (candidate, signal) => {
        let apiKey: string;
        try {
          apiKey = config.secret(candidate.credential.id, candidate.credential.secret);
        } catch {
          return {
            ok: false as const,
            error: {
              class: 'auth' as const,
              retryable: false,
              fallbackAllowed: true,
              credentialAction: 'disable' as const,
              message: 'credential cannot be decrypted with MASTER_KEY',
            },
          };
        }
        const proxyUrl =
          candidate.credential.proxy?.url ?? candidate.provider.proxy?.url ?? settings.proxy?.url;
        try {
          apiKey = await resolveCredentialKey(candidate.provider, candidate.credential, apiKey, {
            signal,
            proxyUrl,
          });
        } catch (error) {
          return { ok: false as const, error: tokenFailure(error) };
        }
        const target = realtimeTarget(
          {
            provider: candidate.provider,
            model: candidate.model,
            apiKey,
            credentialHeaders: candidate.credential.headers,
          },
          { beta },
        );
        if (!target)
          return {
            ok: false as const,
            error: {
              class: 'bad_request' as const,
              retryable: false,
              fallbackAllowed: true,
              message: `provider ${candidate.provider.slug} does not serve realtime sessions`,
            },
          };
        const opened = await openUpstream(candidate.provider, target, {
          connectMs: timeouts.connectMs,
          handshakeMs,
          signal,
          ...(proxyUrl ? { proxyUrl } : {}),
        });
        return opened.ok
          ? { ok: true as const, value: opened }
          : { ok: false as const, error: opened.error };
      },
      {
        retry: retry ?? settings.defaultRetry,
        fallbackOn,
        deadline: started + handshakeMs * Math.max(1, candidates.length) + 5_000,
        budget: deps.budget,
        health: deps.store.healthRegistry,
        signal: connecting.signal,
      },
    );
    socket.off('close', onSocketClose);

    if (!result.ok) {
      releaseKey();
      releaseHold();
      const failure = toClientError(result.error, result.reason);
      this.#failedEvent(
        config,
        key,
        model,
        sessionId,
        started,
        failure,
        result.attempts,
        result.candidate,
      );
      deps.logger.warn(
        { requestId: sessionId, reason: result.reason, error: failure.message },
        'realtime session could not be opened',
      );
      refuse(socket, failure, sessionId);
      return;
    }
    const upstream = result.value.ws;
    if (socket.destroyed || !socket.writable) {
      releaseKey();
      releaseHold();
      upstream.terminate();
      return;
    }

    // Only now is the client upgraded: no session exists until a provider accepted one.
    const initial = claims?.session
      ? {
          type: 'session.update',
          event_id: `event_${ulid()}`,
          session:
            'model' in claims.session
              ? { ...claims.session, model: result.candidate.model.upstreamModel }
              : claims.session,
        }
      : undefined;
    this.#wss.handleUpgrade(req, socket, head, (client) => {
      const session = new RealtimeSession(
        this,
        {
          id: sessionId,
          key,
          config,
          requested: model,
          candidate: result.candidate,
          connectAttempts: result.attempts,
          started,
        },
        client,
        upstream,
        result.value.early,
        () => {
          this.#sessions.delete(session);
          this.#gauge?.set(this.#sessions.size);
          releaseKey();
          releaseHold();
          deps.logger.info(
            { requestId: sessionId, seconds: Math.round((Date.now() - started) / 1000) },
            'realtime session closed',
          );
        },
        initial,
      );
      this.#sessions.add(session);
      this.#gauge?.set(this.#sessions.size);
      deps.logger.info(
        {
          requestId: sessionId,
          provider: result.candidate.provider.slug,
          model: result.candidate.model.slug,
        },
        'realtime session opened',
      );
    });
  }

  #candidates(
    config: LoadedConfig,
    key: VirtualKeyConfig,
    model: string,
  ):
    | { candidates: Candidate[]; fallbackOn: UpstreamErrorClass[]; retry?: RetryPolicy }
    | DiRouterError {
    const route = config.router.resolve(key, model, { estimatedInputTokens: 0 });
    if (isRouteError(route))
      return route.error === 'model_not_found'
        ? new NotFoundError('model_not_found', {
            message: `Model '${model}' not found`,
            param: 'model',
          })
        : route.error === 'model_not_allowed'
          ? new ForbiddenError('model_not_allowed', { param: 'model' })
          : new DiRouterError('service_unavailable', {
              message: `No provider can serve '${model}'`,
            });
    const candidates = route.candidates.filter(
      (c) => c.model.capabilities.realtime === true && supportsRealtime(c.provider.type),
    );
    if (candidates.length === 0)
      return new DiRouterError('invalid_request', {
        message: `'${model}' does not support realtime sessions`,
        param: 'model',
        status: 400,
      });
    return {
      candidates,
      fallbackOn: route.fallbackOn,
      ...(route.combo?.retry ? { retry: route.combo.retry } : {}),
    };
  }

  #headroom(candidates: Candidate[], key: VirtualKeyConfig): string {
    let worst = 0n;
    for (const c of candidates) {
      const charge = chargeUnits(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        c.model,
        {
          groupMultiplier: key.priceMultiplier,
          media: {
            audioInputTokens: HEADROOM_INPUT_TOKENS,
            audioOutputTokens: HEADROOM_OUTPUT_TOKENS,
          },
        },
      );
      if (charge > worst) worst = charge;
    }
    return formatUsd(worst);
  }

  /**
   * After a response's usage event: charge the wallet, count tokens toward budgets and the rate
   * limit, and say whether the session has to stop (and why).
   */
  async settleResponse(
    ctx: SessionContext,
    requestId: string,
    bill: { costUsd: string; charged: string; tokens: number },
  ): Promise<{ reason: string; error: DiRouterError; errorCode: string } | undefined> {
    const deps = this.deps;
    const { key, config } = ctx;
    const budgets = budgetScopes(config, key);
    deps.budgets?.record(budgets, bill.costUsd, bill.tokens);

    let stop: { reason: string; error: DiRouterError; errorCode: string } | undefined;
    const walletId = key.walletId;
    if (walletId && deps.wallets) {
      // The headroom gives way to the response's real charge, then must fit again.
      deps.wallets.settle(walletId, holdId(ctx.id), '0');
      await deps.wallets.reserve(walletId, requestId, bill.charged);
      const again = await deps.wallets.reserve(
        walletId,
        holdId(ctx.id),
        this.#headroom([ctx.candidate], key),
      );
      if (!again.ok) {
        deps.metrics?.reject('wallet', again.unavailable ? 'unavailable' : 'insufficient');
        stop = {
          reason: 'insufficient credit',
          errorCode: 'insufficient_credit',
          error: new DiRouterError('insufficient_credit', {
            message: `Insufficient credit to continue this realtime session (available USD ${again.availableUsd})`,
          }),
        };
      }
    }
    if (!stop && deps.limiter) {
      const admission = await deps.limiter.acquire(
        limitScopes(config, key),
        bill.tokens,
        requestId,
      );
      if (admission.ok) {
        admission.settle(bill.tokens);
        admission.release();
      } else {
        deps.metrics?.reject('rate_limit', admission.unavailable ? 'unavailable' : admission.kind);
        stop = {
          reason: 'rate limit exceeded',
          errorCode: 'rate_limit_exceeded',
          error: new RateLimitError({
            message: `Rate limit exceeded for ${admission.scope.split(':')[0] ?? 'key'} (${admission.kind}); the realtime session is closed`,
            retryAfterMs: admission.retryAfterMs,
          }),
        };
      }
    }
    if (!stop && deps.budgets && budgets.length > 0) {
      const check = await deps.budgets.check(budgets);
      if (!check.ok) {
        deps.metrics?.reject('budget', check.unavailable ? 'unavailable' : check.kind);
        stop = {
          reason: 'budget exceeded',
          errorCode: 'budget_exceeded',
          error: budgetError(check),
        };
      }
    }
    return stop;
  }

  #failedEvent(
    config: LoadedConfig,
    key: VirtualKeyConfig,
    model: string,
    requestId: string,
    started: number,
    failure: DiRouterError,
    attempts: AttemptRecord[],
    candidate: Candidate | undefined,
  ) {
    const event: UsageEvent = {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: ulid(),
      idempotencyKey: requestId,
      requestId,
      occurredAt: new Date(started).toISOString(),
      gatewayInstance: this.deps.instance,
      configVersion: config.version,
      organizationId: key.organizationId,
      teamId: key.teamId,
      projectId: key.projectId,
      virtualKeyId: key.id,
      inboundApi: 'openai.realtime',
      requestedModel: model,
      resolvedModelId: candidate?.model.id ?? null,
      providerId: candidate?.provider.id ?? null,
      credentialId: candidate?.credential.id ?? null,
      stream: true,
      status: 'error',
      httpStatus: failure.status,
      errorCode: failure.code,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: '0',
      usageEstimated: false,
      latencyMs: Date.now() - started,
      attempts: attempts
        .filter((a) => a.outcome !== 'skipped')
        .map((a) => ({
          providerId: a.providerId,
          modelId: a.modelId,
          credentialId: a.credentialId,
          outcome: a.outcome === 'success' ? 'success' : 'error',
          ...(a.status !== undefined ? { httpStatus: a.status } : {}),
          ...(a.errorClass ? { errorCode: a.errorClass } : {}),
          latencyMs: a.latencyMs,
          startedAt: new Date(a.startedAt).toISOString(),
        })),
    };
    this.deps.metrics?.observe(event);
    this.deps.onRequestComplete?.(event);
    this.deps.emitUsage(event);
  }

  // ── Client secrets ──

  async #clientSecret(req: FastifyRequest, reply: FastifyReply, beta: boolean) {
    const deps = this.deps;
    const config = deps.store.current;
    if (!config)
      return reply.status(503).send(
        new DiRouterError('service_unavailable', {
          message: 'Gateway has no configuration yet',
        }).toOpenAI(),
      );
    try {
      const raw = extractApiKey(req.headers);
      // A client secret cannot mint another one.
      if (raw && isClientSecret(raw)) throw new DiRouterError('invalid_api_key');
      const key = authenticate(config, raw, deps.pepper, req.ip);
      const body = record(req.body);
      // GA: { expires_after, session: { type, model, … } }; beta: the session itself, 1 minute.
      const session = beta ? { ...body } : record(body.session);
      const expires = record(body.expires_after);
      const ttl = beta
        ? 60
        : expires.seconds === undefined
          ? DEFAULT_SECRET_TTL_SECONDS
          : Number(expires.seconds);
      if (!Number.isInteger(ttl) || ttl < MIN_SECRET_TTL_SECONDS || ttl > MAX_SECRET_TTL_SECONDS)
        throw new ValidationError([
          {
            path: 'expires_after.seconds',
            message: `must be an integer from ${String(MIN_SECRET_TTL_SECONDS)} to ${String(MAX_SECRET_TTL_SECONDS)}`,
          },
        ]);
      if (!beta && session.type !== undefined && session.type !== 'realtime')
        throw new ValidationError([
          { path: 'session.type', message: "only 'realtime' sessions are supported" },
        ]);
      const model = typeof session.model === 'string' ? session.model : undefined;
      if (beta && !model)
        throw new ValidationError([{ path: 'model', message: 'model is required' }]);
      if (model) {
        const selected = this.#candidates(config, key, model);
        if (selected instanceof DiRouterError) throw selected;
      }
      const applied = { ...session };
      delete applied.model;
      if (beta) {
        delete applied.client_secret;
      }
      if (JSON.stringify(applied).length > MAX_SECRET_SESSION_BYTES)
        throw new ValidationError([
          {
            path: 'session',
            message: `the session configuration is limited to ${String(MAX_SECRET_SESSION_BYTES)} bytes`,
          },
        ]);
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      const value = issueClientSecret(
        {
          keyId: key.id,
          organizationId: key.organizationId,
          expiresAt,
          ...(model ? { model } : {}),
          ...(Object.keys(applied).length > 0
            ? { session: beta ? applied : { type: 'realtime', ...applied } }
            : {}),
          ...(beta ? { beta: true } : {}),
        },
        deps.pepper,
      );
      const id = prefixedId('sess');
      void reply.header('cache-control', 'no-store');
      if (beta)
        return {
          id,
          object: 'realtime.session',
          ...applied,
          model,
          client_secret: { value, expires_at: expiresAt },
        };
      return {
        value,
        expires_at: expiresAt,
        session: {
          type: 'realtime',
          object: 'realtime.session',
          id,
          ...applied,
          ...(model ? { model } : {}),
        },
      };
    } catch (error) {
      const e = error instanceof DiRouterError ? error : new DiRouterError('invalid_request');
      return reply.status(e.status).send(e.toOpenAI());
    }
  }
}

function budgetError(check: {
  unavailable?: boolean;
  kind: string;
  limit: string;
  period: string;
  scope: string;
}): DiRouterError {
  const what = check.kind === 'usd' ? `USD ${check.limit}` : `${check.limit} tokens`;
  return new DiRouterError('budget_exceeded', {
    message: check.unavailable
      ? 'Budget check unavailable (fail-closed), retry shortly'
      : `${check.period === 'daily' ? 'Daily' : 'Monthly'} ${check.scope} budget exceeded (${what})`,
  });
}
