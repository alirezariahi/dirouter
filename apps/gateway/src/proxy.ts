/**
 * Hot path: /v1/chat/completions and /v1/messages (card 4.9).
 * auth → validation → canonical → resolve → retry/fallback → response translation → usage event.
 */
import { createHash } from 'node:crypto';

import {
  AnthropicMessagesRequest,
  type CanonicalRequest,
  type CanonicalResponse,
  type CanonicalStreamEvent,
  type CanonicalUsage,
  type GuardrailPolicy,
  type InboundApi,
  OpenAIChatCompletionRequest,
  USAGE_EVENT_SCHEMA_VERSION,
  type UsageEvent,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import {
  computeCostUsd,
  estimateRequestTokens,
  estimateUsage,
  roughTokens,
} from '@dirouter/model-catalog';
import {
  type ClassifiedError,
  adapterForProvider,
  classified,
  classifyNetworkError,
} from '@dirouter/providers';
import {
  type AttemptResult,
  type BulkheadRegistry,
  type Candidate,
  classifyRequest,
  decideAuto,
  executeWithFallback,
  executeWithHedging,
  HedgeBudget,
  isAutoAlias,
  isRouteError,
  type ResolvedRoute,
  type RetryBudget,
  type TaskType,
} from '@dirouter/routing';
import {
  DiRouterError,
  type Logger,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
  ForbiddenError,
  ulid,
} from '@dirouter/shared';
import {
  AnthropicStreamEncoder,
  GeminiInboundStreamEncoder,
  OpenAIStreamEncoder,
  ResponsesStreamEncoder,
  SSE_HEARTBEAT,
  SseParser,
  anthropicRequestToCanonical,
  canonicalToAnthropicResponse,
  canonicalToGeminiResponse,
  canonicalToOpenAIResponse,
  canonicalToResponsesResponse,
  geminiRequestToCanonical,
  openAIRequestToCanonical,
  responsesRequestToCanonical,
} from '@dirouter/translator';
import { GeminiGenerateContentRequest, ResponsesRequest } from '@dirouter/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

import { authenticate, extractApiKey } from './auth.js';
import type { ConfigStore, LoadedConfig } from './config-store.js';
import type { GatewayMetrics } from './metrics.js';
import type { BudgetGuard, ScopedBudget } from './budget-guard.js';
import { chargeUsd } from './pricing.js';
import { type WalletGuard, worstCaseChargeUsd } from './wallet-guard.js';
import type { LimitScope, RateLimiter } from './rate-limiter.js';
import {
  cacheKeyFor,
  type ExactCache,
  isCacheable,
  isSemanticCacheable,
  type SemanticCacheClient,
  semanticSettingsFor,
  semanticText,
  StreamAssembler,
} from './cache.js';
import { compressRequest } from './compress.js';
import { evaluateGuardrails, policiesFor, StreamGuardrailBuffer } from './guardrails.js';
import type { Tracer, TraceSpan } from './tracing.js';
import { callUpstream, mergeTimeouts, readErrorBody, UpstreamTimeout } from './upstream.js';

export interface ProxyDeps {
  store: ConfigStore;
  budget: RetryBudget;
  /** Concurrency cap per provider and per key (card 5.7). */
  bulkheads?: BulkheadRegistry;
  /** Budget for key, project and team (card 6.3). */
  budgets?: BudgetGuard;
  /** Prepaid wallet reservations (card 19.1). */
  wallets?: WalletGuard;
  /** Distributed rate limiter (card 6.1). */
  limiter?: RateLimiter;
  /** Shutdown state (card 5.8): during drain, connections are closed after the response. */
  lifecycle?: { readonly draining: boolean; readonly signal: AbortSignal };
  pepper: string;
  logger: Logger;
  instance: string;
  /** Usage event destination (queue or outbox); never awaited. */
  emitUsage: (event: UsageEvent) => void;
  /** Shared rolling hedge budgets, keyed by ratio:window. */
  hedgeBudgets?: Map<string, HedgeBudget>;
  /** Hot-path metrics; can be omitted in unit tests. */
  metrics?: GatewayMetrics;
  /** End-of-request log, even for rejections before the usage event. */
  onRequestComplete?: (event: UsageEvent) => void;
  heartbeatMs?: number;
  /** Exact response cache (card 13.1). */
  cache?: ExactCache;
  /** pgvector semantic cache client (card 13.2); fail-open. */
  semanticCache?: SemanticCacheClient;
  /** Valkey client for previous_response_id conversation state and cache bypass bookkeeping. */
  stateRedis?: Redis;
  /** OTLP tracer (card 17.2). */
  tracer?: Tracer;
  /** Asks a small model for the task type when the rules are unsure (card 20.4). */
  classifyWithModel?: (
    model: string,
    request: CanonicalRequest,
    req: FastifyRequest,
  ) => Promise<TaskType | undefined>;
}

interface StreamOutcome {
  usage: CanonicalUsage;
  /** Provider gave no usage and the value was estimated with the tokenizer. */
  usageEstimated: boolean;
  ttftMs: number;
  /** Complete response rebuilt from the stream; present only for a clean, unmodified stream. */
  response?: CanonicalResponse | undefined;
  /** What the provider said, for `previous_response_id` continuation (set even when guarded). */
  conversation?: CanonicalResponse | undefined;
}

type Outcome =
  | {
      kind: 'json';
      response: CanonicalResponse & { usage: CanonicalUsage };
      usageEstimated: boolean;
    }
  | { kind: 'stream'; result: StreamOutcome };

export function toClientError(error: ClassifiedError | undefined, reason: string): DiRouterError {
  if (!error)
    return new UpstreamError('no_available_provider', {
      message: 'No provider could serve the request',
    });
  switch (error.class) {
    case 'rate_limit':
      return new RateLimitError({
        message: error.message,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      });
    // Network error messages may contain the internal address of the provider or proxy; the client only
    // gets a generic message, and details (with the masked password) are only in the server log.
    case 'timeout':
      return new UpstreamError('upstream_timeout', { message: 'Upstream request timed out' });
    case 'connection':
      return new UpstreamError('upstream_error', {
        message: 'Could not connect to the upstream provider',
      });
    case 'overloaded':
      return new UpstreamError('upstream_overloaded', { message: error.message });
    case 'bad_request':
    case 'content_filter':
      return new DiRouterError('invalid_request', {
        message: error.message,
        status: error.status ?? 400,
      });
    case 'context_length':
      return new DiRouterError('context_length_exceeded', { message: error.message });
    default:
      return new UpstreamError('upstream_error', {
        message:
          reason === 'budget' ? 'Upstream unavailable (retry budget exhausted)' : error.message,
        ...(error.status !== undefined ? { upstreamStatus: error.status } : {}),
      });
  }
}

function sendError(
  reply: FastifyReply,
  api: InboundApi,
  error: DiRouterError,
  requestId: string,
): void {
  if (error instanceof RateLimitError && error.retryAfterMs !== undefined)
    void reply.header('retry-after', String(Math.ceil(error.retryAfterMs / 1000)));
  void reply.status(error.status).send(errorPayload(api, error, requestId));
}

const GOOGLE_STATUS: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'ABORTED',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

/** Error shape per inbound API: Gemini-native clients do not understand OpenAI error JSON. */
export function errorPayload(api: InboundApi, error: DiRouterError, requestId: string): unknown {
  if (api === 'gemini.generate')
    return {
      error: {
        code: error.status,
        message: error.message,
        status: GOOGLE_STATUS[error.status] ?? 'INTERNAL',
      },
    };
  if (api === 'anthropic.messages') return error.toAnthropic(requestId);
  return error.toOpenAI();
}

function parseInbound(api: InboundApi, body: unknown, logger: Logger): CanonicalRequest {
  const onDrop = (field: string, reason: string) => {
    logger.debug({ field, reason }, 'field dropped in translation');
  };
  if (api === 'gemini.generate') {
    const parsed = GeminiGenerateContentRequest.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    return geminiRequestToCanonical(parsed.data, {
      onDrop,
      ...(typeof (body as { model?: unknown }).model === 'string'
        ? { model: (body as { model: string }).model }
        : {}),
    });
  }
  if (api === 'openai.responses') {
    const parsed = ResponsesRequest.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    return responsesRequestToCanonical(parsed.data, { onDrop });
  }
  const schema = api === 'openai.chat' ? OpenAIChatCompletionRequest : AnthropicMessagesRequest;
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error);
  return api === 'openai.chat'
    ? openAIRequestToCanonical(parsed.data as OpenAIChatCompletionRequest, { onDrop })
    : anthropicRequestToCanonical(parsed.data as AnthropicMessagesRequest, { onDrop });
}

function validationError(error: {
  issues: { path: PropertyKey[]; message: string }[];
}): ValidationError {
  return new ValidationError(
    error.issues
      .slice(0, 20)
      .map((i) => ({ path: i.path.map(String).join('.') || '(body)', message: i.message })),
  );
}

/**
 * `POST /v1/messages/count_tokens` (Anthropic-compatible, card 4.9): local estimate with the tokenizer
 * and no upstream call. Claude Code and the SDK use it to manage context.
 */
/** JSON response in the shape of the inbound API. */
export function encodeResponse(
  api: InboundApi,
  response: CanonicalResponse,
  model: string,
): unknown {
  switch (api) {
    case 'gemini.generate':
      return canonicalToGeminiResponse(response, { model });
    case 'openai.responses':
      return canonicalToResponsesResponse(response, { model });
    case 'anthropic.messages':
      return canonicalToAnthropicResponse(response, { model });
    default:
      return canonicalToOpenAIResponse(response, { model });
  }
}

function replayEvents(response: CanonicalResponse): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = [
    { type: 'start', id: response.id, model: response.model, created: response.created },
  ];
  response.content.forEach((part, index) => {
    if (part.type === 'text' && part.text)
      events.push({ type: 'text_delta', index, text: part.text });
    else if (part.type === 'reasoning' && part.text)
      events.push({ type: 'reasoning_delta', index, text: part.text });
    else if (part.type === 'tool_call') {
      events.push({ type: 'tool_call_start', index, id: part.id, name: part.name });
      if (part.arguments)
        events.push({ type: 'tool_call_delta', index, argumentsDelta: part.arguments });
    }
    events.push({ type: 'content_end', index });
  });
  events.push({
    type: 'finish',
    finishReason: response.finishReason,
    ...(response.rawFinishReason ? { rawFinishReason: response.rawFinishReason } : {}),
  });
  return events;
}

function streamEncoderFor(
  api: InboundApi,
  canonical: CanonicalRequest,
  includeUsage: boolean,
):
  | OpenAIStreamEncoder
  | AnthropicStreamEncoder
  | GeminiInboundStreamEncoder
  | ResponsesStreamEncoder {
  if (api === 'gemini.generate') return new GeminiInboundStreamEncoder({ model: canonical.model });
  if (api === 'openai.responses') return new ResponsesStreamEncoder({ model: canonical.model });
  if (api === 'anthropic.messages') return new AnthropicStreamEncoder({ model: canonical.model });
  return new OpenAIStreamEncoder({ model: canonical.model, includeUsage });
}

export function handleCountTokens(req: FastifyRequest, reply: FastifyReply, deps: ProxyDeps): void {
  const api: InboundApi = 'anthropic.messages';
  const config = deps.store.current;
  if (!config) {
    sendError(reply, api, new DiRouterError('service_unavailable'), req.id);
    return;
  }
  try {
    const key = authenticate(config, extractApiKey(req.headers), deps.pepper, req.ip);
    // count_tokens is a messages body without max_tokens.
    const body = { max_tokens: 1, ...(req.body as Record<string, unknown> | undefined) };
    const canonical = parseInbound(api, body, deps.logger);
    if (key.allowedModels.length > 0 && !key.allowedModels.includes(canonical.model))
      throw new ForbiddenError('model_not_allowed');
    void reply.send({ input_tokens: estimateRequestTokens(canonical) });
  } catch (error) {
    sendError(
      reply,
      api,
      error instanceof DiRouterError ? error : new DiRouterError('invalid_request'),
      req.id,
    );
  }
}

export async function handleProxy(
  api: InboundApi,
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  const requestId = req.id;
  const started = Date.now();
  let model = 'unknown';
  // Rejected requests before the usage event are also counted. Successful/failed
  // upstream requests are recorded in runRoute; finally guarantees it for unexpected exits.
  let observed = false;
  const observeEarly = (status: number) => {
    if (observed) return;
    observed = true;
    const event: UsageEvent = {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: ulid(),
      idempotencyKey: requestId,
      requestId,
      occurredAt: new Date(started).toISOString(),
      gatewayInstance: deps.instance,
      configVersion: deps.store.current?.version ?? 0,
      organizationId: '',
      teamId: null,
      projectId: '',
      virtualKeyId: '',
      inboundApi: api,
      requestedModel: model,
      resolvedModelId: null,
      providerId: null,
      credentialId: null,
      stream: false,
      status: status >= 200 && status < 400 ? 'success' : 'error',
      httpStatus: status,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: '0.00000000',
      usageEstimated: false,
      latencyMs: Date.now() - started,
      attempts: [],
    };
    deps.metrics?.observe(event);
    deps.onRequestComplete?.(event);
  };
  const config = deps.store.current;
  if (!config) {
    sendError(
      reply,
      api,
      new DiRouterError('service_unavailable', { message: 'Gateway has no configuration yet' }),
      requestId,
    );
    observeEarly(503);
    return;
  }

  let canonical: CanonicalRequest;
  let key;
  try {
    key = authenticate(
      config,
      // Gemini clients may send the key as `?key=` instead of a header.
      extractApiKey(
        req.headers,
        api === 'gemini.generate' ? (req.query as { key?: string } | undefined)?.key : undefined,
      ),
      deps.pepper,
      req.ip,
    );
    const body = req.body as { model?: unknown } | undefined;
    if (typeof body?.model === 'string' && body.model.length <= 256) model = body.model;
    canonical = parseInbound(api, req.body, deps.logger);
  } catch (error) {
    sendError(
      reply,
      api,
      error instanceof DiRouterError ? error : new DiRouterError('invalid_request'),
      requestId,
    );
    observeEarly(reply.statusCode);
    return;
  }

  // `/v1/responses` conversation continuation (card 11.2): previous turn state lives in Valkey,
  // keyed by the public response id. Expired or unknown ids are an explicit client error.
  if (api === 'openai.responses' && deps.stateRedis) {
    const previous = (req.body as { previous_response_id?: unknown } | undefined)
      ?.previous_response_id;
    if (typeof previous === 'string' && previous.length > 0) {
      try {
        const raw = await deps.stateRedis.get(`resp:${previous}`);
        if (!raw)
          throw new DiRouterError('invalid_request', {
            message: `previous response '${previous}' was not found or has expired`,
            param: 'previous_response_id',
          });
        const stored = JSON.parse(raw) as {
          messages?: typeof canonical.messages;
          organizationId?: string;
          projectId?: string;
        };
        // A response id is only valid inside the project that produced it; for anyone else it
        // does not exist (same answer as an expired id, so ids cannot be probed).
        if (stored.organizationId !== key.organizationId || stored.projectId !== key.projectId)
          throw new DiRouterError('invalid_request', {
            message: `previous response '${previous}' was not found or has expired`,
            param: 'previous_response_id',
          });
        if (Array.isArray(stored.messages))
          canonical = { ...canonical, messages: [...stored.messages, ...canonical.messages] };
      } catch (error) {
        sendError(
          reply,
          api,
          error instanceof DiRouterError
            ? error
            : new DiRouterError('invalid_request', {
                message: 'previous response state is unreadable',
                param: 'previous_response_id',
              }),
          requestId,
        );
        observeEarly(reply.statusCode);
        return;
      }
    }
  }

  const settings = config.snapshot.settings;
  // Continues the caller's trace when a W3C `traceparent` header is present (card 17.2).
  // With tracing off there is no span at all, so nothing is injected into upstream requests.
  const span = deps.tracer?.enabled
    ? deps.tracer.startRequest(
        'gateway.request',
        {
          'gateway.inbound_api': api,
          'gateway.model': canonical.model,
          'gateway.stream': canonical.stream,
          'gateway.request_id': requestId,
        },
        req.headers.traceparent,
      )
    : undefined;
  const finishSpan = (status: 'ok' | 'error', extra?: Record<string, string | number>) => {
    if (!span) return;
    span.end(status, extra ?? {});
  };

  // Guardrails (card 15.1) run before routing so a blocked request never reaches a provider.
  pageGuard: {
    const policies = policiesFor(config.snapshot.guardrails, key);
    if (policies.length === 0) break pageGuard;
    const guard = evaluateGuardrails(policies, {
      stage: 'request',
      request: canonical,
      estimatedInputTokens: estimateRequestTokens(canonical, roughTokens),
    });
    // `flag` and `redact` hits leave a trail in the log (policy ids and counts, never the text).
    if (guard.hits.length > 0)
      deps.logger.info(
        {
          requestId,
          stage: 'request',
          guardrails: guard.hits.map((hit) => ({
            policyId: hit.policyId,
            action: hit.action,
            matches: hit.matches,
          })),
        },
        'guardrail hits',
      );
    if (guard.blocked) {
      sendError(
        reply,
        api,
        new DiRouterError('invalid_request', {
          message: guard.blocked.message,
          status: 400,
        }),
        requestId,
      );
      deps.metrics?.reject('guardrail', guard.blocked.policy.type);
      finishSpan('error', { 'gateway.guardrail': guard.blocked.policy.type });
      observeEarly(reply.statusCode);
      return;
    }
    if (guard.redactions > 0)
      deps.logger.info({ requestId, redactions: guard.redactions }, 'guardrail redactions applied');
  }

  // Context compression (card 13.3) shrinks the prompt before estimation and routing.
  let savedCompressedChars = 0;
  if (settings.compression?.enabled) {
    const compressed = compressRequest(canonical, settings.compression);
    canonical = compressed.request;
    savedCompressedChars = compressed.savedChars;
    if (compressed.savedChars > 0)
      deps.logger.debug({ requestId, ...compressed }, 'request compressed');
  }

  const estimatedInputTokens = estimateRequestTokens(canonical, roughTokens);
  model = canonical.model;
  // Sticky sessions (card 12.4): the configured header (default x-dirouter-session) identifies a
  // conversation; the pin is per key so two keys never share a target.
  const affinity = config.snapshot.settings.sessionAffinity;
  const affinityHeader = affinity?.enabled ? req.headers[affinity.header.toLowerCase()] : undefined;
  // Without the header, the stable prompt prefix (system prompt + first message) identifies the
  // conversation: agent CLIs resend it unchanged on every turn, which is exactly the part the
  // upstream prompt cache keys on.
  const sessionKey =
    typeof affinityHeader === 'string' && affinityHeader.length <= 200
      ? `${key.id}:${affinityHeader}`
      : affinity?.enabled
        ? promptPrefixSessionKey(key.id, canonical)
        : undefined;
  // Automatic model choice for the `auto*` aliases (card 20.4), unless the organization defines a
  // model, alias or combo of that name itself, or the key may not use the alias.
  let routing: UsageEvent['routing'];
  const autoRouting = settings.autoRouting;
  if (
    autoRouting?.enabled &&
    isAutoAlias(canonical.model) &&
    !config.router.modelsFor(key, canonical.model) &&
    (key.allowedModels.length === 0 || key.allowedModels.includes(canonical.model))
  ) {
    const alias = canonical.model;
    const startedAt = performance.now();
    const classification = classifyRequest(canonical, estimatedInputTokens);
    let source: 'rules' | 'model' = 'rules';
    let classifierElapsed = performance.now() - startedAt;
    if (
      alias === 'auto' &&
      autoRouting.classifierModel &&
      classification.confidence < autoRouting.classifierThreshold &&
      deps.classifyWithModel
    ) {
      const asked = await deps.classifyWithModel(autoRouting.classifierModel, canonical, req);
      if (asked) {
        classification.reasons.push(`${autoRouting.classifierModel} says ${asked}`);
        classification.taskType = asked;
        source = 'model';
      }
    }
    const decision = decideAuto(
      alias,
      autoRouting,
      classification,
      {
        modelsOf: (name) => config.router.modelsFor(key, name),
        stats: config.router.stats,
        estimatedInputTokens,
        maxOutputTokens: canonical.maxOutputTokens ?? 1_024,
      },
      source,
    );
    if (source === 'rules') classifierElapsed = performance.now() - startedAt;
    if ('error' in decision) {
      sendError(
        reply,
        api,
        new NotFoundError('model_not_found', { message: decision.error, param: 'model' }),
        requestId,
      );
      finishSpan('error', { 'gateway.error': 'auto_routing' });
      observeEarly(reply.statusCode);
      return;
    }
    routing = { ...decision, classifierMicros: Math.round(classifierElapsed * 1_000) };
    void reply.header('x-dirouter-auto', `${decision.target}; type=${classification.taskType}`);
    deps.logger.debug({ requestId, routing }, 'auto routing decision');
  }
  // The alias was checked against the key above; the target is the gateway's choice, not the client's.
  const route = config.router.resolve(
    routing ? { ...key, allowedModels: [] } : key,
    routing?.target ?? canonical.model,
    {
      estimatedInputTokens,
      ...(canonical.maxOutputTokens !== undefined
        ? { maxOutputTokens: canonical.maxOutputTokens }
        : {}),
      ...(sessionKey ? { sessionKey } : {}),
      // Power-of-two-choices for `latency` combos (card 12.1); other strategies ignore it.
      p2c: true,
    },
  );
  if (isRouteError(route)) {
    const error =
      route.error === 'model_not_found'
        ? new NotFoundError('model_not_found', {
            message: `Model '${canonical.model}' not found`,
            param: 'model',
          })
        : route.error === 'model_not_allowed'
          ? new ForbiddenError('model_not_allowed', { param: 'model' })
          : route.error === 'context_length_exceeded'
            ? new DiRouterError('context_length_exceeded', {
                message: `Request needs about ${String(route.neededTokens ?? 0)} tokens (input estimate + max output), more than any model for '${canonical.model}' supports`,
              })
            : new UpstreamError('no_available_provider');
    deps.logger.debug({ requestId, skipped: route.skipped }, 'route failed');
    sendError(reply, api, error, requestId);
    finishSpan('error', { 'gateway.error': route.error });
    observeEarly(reply.statusCode);
    return;
  }

  // Client disconnect → abort all attempts and upstream.
  const clientGone = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) clientGone.abort(new Error('client disconnected'));
  });
  // Drain deadline reached: remaining requests are cancelled like a client disconnect.
  const onShutdown = () => {
    clientGone.abort(new Error('gateway shutting down'));
  };
  deps.lifecycle?.signal.addEventListener('abort', onShutdown, { once: true });
  reply.raw.once('close', () => deps.lifecycle?.signal.removeEventListener('abort', onShutdown));

  // Distributed rate limit (card 6.1): key, project and team. TPM reservation = input + output cap.
  const admission = deps.limiter
    ? await deps.limiter.acquire(
        limitScopes(config, key),
        estimatedInputTokens + Math.min(canonical.maxOutputTokens ?? 1_024, 8_192),
        requestId,
      )
    : undefined;
  if (admission && !admission.ok) {
    for (const [name, value] of Object.entries(admission.headers)) void reply.header(name, value);
    sendError(
      reply,
      api,
      new RateLimitError({
        message: admission.unavailable
          ? 'Rate limiter unavailable (fail-closed), retry shortly'
          : `Rate limit exceeded for ${admission.scope.split(':')[0] ?? 'key'} (${admission.kind})`,
        retryAfterMs: admission.retryAfterMs,
      }),
      requestId,
    );
    deps.metrics?.reject('rate_limit', admission.unavailable ? 'unavailable' : admission.kind);
    finishSpan('error', { 'gateway.error': 'rate_limit' });
    observeEarly(reply.statusCode);
    return;
  }
  if (admission)
    for (const [name, value] of Object.entries(admission.headers)) void reply.header(name, value);

  // Budget: reaching the cap means 429 budget_exceeded until the next period starts.
  const budgets = budgetScopes(config, key);
  const budgetCheck = deps.budgets ? await deps.budgets.check(budgets) : { ok: true as const };
  if (!budgetCheck.ok) {
    admission?.settle(0);
    admission?.release();
    void reply.header(
      'retry-after',
      String(Math.max(1, Math.ceil((budgetCheck.resetAt.getTime() - Date.now()) / 1000))),
    );
    const what =
      budgetCheck.kind === 'usd' ? `USD ${budgetCheck.limit}` : `${budgetCheck.limit} tokens`;
    sendError(
      reply,
      api,
      new DiRouterError('budget_exceeded', {
        message: budgetCheck.unavailable
          ? 'Budget check unavailable (fail-closed), retry shortly'
          : `${budgetCheck.period === 'daily' ? 'Daily' : 'Monthly'} ${budgetCheck.scope} budget exceeded (${what})`,
      }),
      requestId,
    );
    deps.metrics?.reject('budget', budgetCheck.unavailable ? 'unavailable' : budgetCheck.kind);
    finishSpan('error', { 'gateway.error': 'budget_exceeded' });
    observeEarly(reply.statusCode);
    return;
  }

  // Prepaid wallet (card 19.1): reserve the worst-case charge so concurrent requests cannot spend
  // the same credit; the reservation becomes the real charge when the request ends.
  const walletId = key.walletId;
  if (walletId && deps.wallets) {
    const reservation = await deps.wallets.reserve(
      walletId,
      requestId,
      worstCaseChargeUsd(
        route.candidates,
        estimatedInputTokens,
        canonical.maxOutputTokens,
        key.priceMultiplier,
      ),
    );
    if (!reservation.ok) {
      admission?.settle(0);
      admission?.release();
      sendError(
        reply,
        api,
        new DiRouterError('insufficient_credit', {
          message: reservation.unavailable
            ? 'Wallet check unavailable (fail-closed), retry shortly'
            : `Insufficient credit: this request may cost up to USD ${reservation.neededUsd}, available USD ${reservation.availableUsd}`,
        }),
        requestId,
      );
      deps.metrics?.reject('wallet', reservation.unavailable ? 'unavailable' : 'insufficient');
      finishSpan('error', { 'gateway.error': 'insufficient_credit' });
      observeEarly(reply.statusCode);
      return;
    }
  }
  const settleWallet = (chargeUsd: string) => {
    if (walletId) deps.wallets?.settle(walletId, requestId, chargeUsd);
  };

  // Response caches (cards 13.1 and 13.2): exact first (cheap), then semantic (control-api,
  // fail-open and time-boxed). A hit skips the provider entirely and is billed at zero. The lookup
  // runs after the rate limit and the budget check, so a throttled or over-budget key gets no
  // answers from the cache either (a hit still counts as one request, with zero tokens).
  // Clients can opt out per request with `x-dirouter-cache: bypass` or `cache-control: no-cache`.
  const cacheBypass =
    String(req.headers['x-dirouter-cache'] ?? '').toLowerCase() === 'bypass' ||
    (req.headers['cache-control'] ?? '').toLowerCase().includes('no-cache');
  const firstCandidate = route.candidates[0];
  let cached: CanonicalResponse | undefined;
  let cacheKind: 'exact' | 'semantic' | undefined;
  if (!cacheBypass && firstCandidate) {
    if (isCacheable(canonical, settings.cache)) {
      const cacheKey = cacheKeyFor(key, canonical, firstCandidate.model.id);
      cached = await deps.cache?.get(cacheKey);
      if (cached) cacheKind = 'exact';
    }
    // Independent of the exact cache: a project can run the semantic cache alone.
    const semantic = semanticSettingsFor(settings.cache, key.projectId);
    if (!cached && semantic && deps.semanticCache && isSemanticCacheable(canonical)) {
      const hit = await deps.semanticCache.lookup({
        organizationId: key.organizationId,
        projectId: key.projectId,
        ...(semantic.embeddingModel ? { embeddingModel: semantic.embeddingModel } : {}),
        // Same name the entry was stored under (the client-facing model, alias or combo).
        model: canonical.model,
        texts: semanticText(canonical),
        threshold: semantic.threshold,
        timeoutMs: semantic.timeoutMs,
      });
      if (hit) {
        cached = hit.response;
        cacheKind = 'semantic';
      }
    }
  }
  // Response guardrails apply to cached answers too: the entry may come from another key of the
  // project, or predate a policy. A blocked entry is treated as a miss, and a redacted copy is
  // served without touching the stored one.
  if (cached) {
    const policies = policiesFor(config.snapshot.guardrails, key);
    if (policies.length > 0) {
      const copy = structuredClone(cached);
      const guard = evaluateGuardrails(policies, { stage: 'response', response: copy });
      cached = guard.blocked ? undefined : copy;
    }
  }
  if (cached) {
    admission?.settle(0);
    admission?.release();
    // A cached answer can be continued with previous_response_id like a fresh one.
    storeResponseState(deps, api, key, canonical, cached);
    deps.metrics?.cacheHit(cacheKind ?? 'exact');
    void reply
      .header('x-dirouter-cache', cacheKind ?? 'exact')
      .header('x-dirouter-model', firstCandidate?.model.slug ?? cached.model);
    // A streaming client gets a real SSE replay, never a JSON body (card 13.1).
    if (canonical.stream) {
      const includeUsage =
        api === 'anthropic.messages' ||
        (req.body as { stream_options?: { include_usage?: boolean } } | undefined)?.stream_options
          ?.include_usage === true;
      const encoder = streamEncoderFor(api, canonical, includeUsage);
      let body = '';
      for (const ev of replayEvents(cached)) body += encoder.push(ev);
      if (encoder.usage === undefined && cached.usage)
        body += encoder.push({ type: 'usage', usage: cached.usage });
      body += encoder.end();
      void reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache')
        .header('x-accel-buffering', 'no')
        .status(200)
        .send(body);
    } else {
      reply.status(200).send(encodeResponse(api, cached, canonical.model));
    }
    const cachedCharge = emitUsageEvent(deps, config, {
      api,
      requestId,
      key,
      canonical,
      started,
      candidate: firstCandidate,
      usage: cached.usage,
      usageEstimated: false,
      ok: true,
      httpStatus: 200,
      ttftMs: 0,
      errorCode: undefined,
      attempts: [],
      cacheHit: true,
      cacheKind,
      ...(firstCandidate
        ? {
            metricProvider: firstCandidate.provider.slug,
            metricModel: firstCandidate.model.slug,
          }
        : {}),
    });
    // Cached answers cost nothing upstream but may be sold (sale.cacheMultiplier, card 19.4).
    settleWallet(cachedCharge.chargeUsd);
    finishSpan('ok', { 'gateway.cache': cacheKind ?? 'exact' });
    return;
  }

  const queue = config.snapshot.settings.bulkhead;
  const queueOverrides = {
    ...(queue?.queueSize !== undefined ? { queueSize: queue.queueSize } : {}),
    ...(queue?.queueTimeoutMs !== undefined ? { queueTimeoutMs: queue.queueTimeoutMs } : {}),
  };
  // Key concurrency cap: if full, 429 immediately (after a short queue), without contacting upstream.
  const keyBulkhead = deps.bulkheads?.get(
    `key:${key.id}`,
    key.rateLimit?.maxConcurrency,
    queueOverrides,
  );
  const releaseKey = keyBulkhead ? await keyBulkhead.acquire(clientGone.signal) : () => undefined;
  if (!releaseKey) {
    admission?.settle(0);
    admission?.release();
    settleWallet('0');
    finishSpan('error', { 'gateway.error': 'concurrency' });
    if (clientGone.signal.aborted) {
      observeEarly(499);
      return;
    }
    deps.logger.info({ requestId, limit: keyBulkhead?.limit }, 'key concurrency limit');
    sendError(
      reply,
      api,
      new RateLimitError({
        message: `Too many concurrent requests for this key (limit ${String(keyBulkhead?.limit)})`,
        retryAfterMs: 1_000,
      }),
      requestId,
    );
    deps.metrics?.reject('concurrency', 'key');
    observeEarly(reply.statusCode);
    return;
  }
  let spent = { tokens: 0, costUsd: '0', chargeUsd: '0' };
  if (canonical.stream) deps.metrics?.streamStarted();
  try {
    spent = await runRoute(
      api,
      req,
      reply,
      {
        ...deps,
        emitUsage: (event) => {
          observed = true;
          deps.emitUsage(event);
        },
      },
      {
        config,
        key,
        canonical,
        route,
        requestId,
        started,
        clientGone,
        queueOverrides,
        ...(cacheBypass ? { cacheBypass: true } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(savedCompressedChars > 0
          ? { savedInputTokens: Math.round(savedCompressedChars / 4) }
          : {}),
        ...(routing ? { routing } : {}),
        finishSpan,
        ...(span ? { span } : {}),
      },
    );
  } finally {
    // Ends the span for every path that did not end it itself (upstream failure, a stream cut
    // after the first byte, an unexpected throw); ending twice is a no-op.
    finishSpan('error');
    if (canonical.stream) deps.metrics?.streamEnded();
    observeEarly(reply.raw.headersSent ? 200 : reply.statusCode);
    releaseKey();
    admission?.settle(spent.tokens);
    admission?.release();
    deps.budgets?.record(budgets, spent.costUsd, spent.tokens);
    settleWallet(spent.chargeUsd);
  }
}

/**
 * `/v1/responses` previous_response_id state (card 11.2): best effort, 7 days, and bound to the
 * project so no other tenant can continue (or read back) the conversation.
 */
function storeResponseState(
  deps: ProxyDeps,
  api: InboundApi,
  key: VirtualKeyConfig,
  canonical: CanonicalRequest,
  response: CanonicalResponse,
): void {
  if (api !== 'openai.responses' || !deps.stateRedis) return;
  void deps.stateRedis
    .set(
      `resp:resp_${response.id}`,
      JSON.stringify({
        organizationId: key.organizationId,
        projectId: key.projectId,
        messages: [...canonical.messages, { role: 'assistant', content: response.content }],
        model: response.model,
      }),
      'EX',
      7 * 24 * 3600,
    )
    .catch(() => undefined);
}

/** Budgets for a key: itself, its project and its team (card 6.3). */
export function budgetScopes(config: LoadedConfig, key: VirtualKeyConfig): ScopedBudget[] {
  const out: ScopedBudget[] = key.budgets.map((budget) => ({
    budget,
    scope: 'key',
    scopeId: key.id,
    organizationId: key.organizationId,
  }));
  for (const l of config.snapshot.limits) {
    if (l.organizationId !== key.organizationId || l.budgets.length === 0) continue;
    const match =
      (l.scope === 'project' && l.scopeId === key.projectId) ||
      (l.scope === 'team' && key.teamId !== null && l.scopeId === key.teamId);
    if (match)
      for (const budget of l.budgets)
        out.push({ budget, scope: l.scope, scopeId: l.scopeId, organizationId: l.organizationId });
  }
  return out;
}

/** Limit scopes for a key: itself, its project and its team. */
export function limitScopes(config: LoadedConfig, key: VirtualKeyConfig): LimitScope[] {
  const scopes: LimitScope[] = [];
  if (key.rateLimit) scopes.push({ name: `key:${key.id}`, limit: key.rateLimit });
  for (const l of config.snapshot.limits) {
    if (!l.rateLimit || l.organizationId !== key.organizationId) continue;
    if (l.scope === 'project' && l.scopeId === key.projectId)
      scopes.push({ name: `project:${l.scopeId}`, limit: l.rateLimit });
    else if (l.scope === 'team' && key.teamId && l.scopeId === key.teamId)
      scopes.push({ name: `team:${l.scopeId}`, limit: l.rateLimit });
  }
  return scopes;
}

async function runRoute(
  api: InboundApi,
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
  ctx: {
    config: LoadedConfig;
    key: VirtualKeyConfig;
    canonical: CanonicalRequest;
    route: ResolvedRoute;
    requestId: string;
    started: number;
    clientGone: AbortController;
    queueOverrides: { queueSize?: number; queueTimeoutMs?: number };
    sessionKey?: string;
    savedInputTokens?: number;
    cacheBypass?: boolean;
    /** How an `auto*` alias was resolved (card 20.4). */
    routing?: UsageEvent['routing'];
    finishSpan: (status: 'ok' | 'error', extra?: Record<string, string | number>) => void;
    /** Request span; every upstream attempt becomes a child of it. */
    span?: TraceSpan;
  },
): Promise<{ tokens: number; costUsd: string; chargeUsd: string }> {
  const { config, key, canonical, route, requestId, started, clientGone } = ctx;

  const settings = config.snapshot.settings;
  const retry = route.combo?.retry ?? settings.defaultRetry;
  const baseTimeouts = mergeTimeouts(settings.defaultTimeouts, route.combo?.timeouts);
  const includeUsage =
    api === 'anthropic.messages' ||
    (req.body as { stream_options?: { include_usage?: boolean } } | undefined)?.stream_options
      ?.include_usage === true;

  // One client span per upstream attempt (retry, fallback or hedge), with its own traceparent.
  const attempt = async (
    candidate: Candidate,
    signal: AbortSignal,
    _attempt?: number,
    claim?: () => boolean,
  ): Promise<AttemptResult<Outcome>> => {
    const attemptSpan = ctx.span?.child('gateway.upstream', {
      'gateway.provider': candidate.provider.slug,
      'gateway.resolved_model': candidate.model.slug,
      'gateway.credential': candidate.credential.id,
    });
    try {
      const result = await attemptOnce(candidate, signal, attemptSpan?.traceparent, claim);
      attemptSpan?.end(
        result.ok ? 'ok' : 'error',
        result.ok ? {} : { 'gateway.error_class': result.error.class },
      );
      return result;
    } catch (error) {
      attemptSpan?.end('error');
      throw error;
    }
  };

  const attemptOnce = async (
    candidate: Candidate,
    signal: AbortSignal,
    traceparent: string | undefined,
    claim: (() => boolean) | undefined,
  ): Promise<AttemptResult<Outcome>> => {
    const adapter = adapterForProvider(candidate.provider);
    const timeouts = mergeTimeouts(baseTimeouts, candidate.provider.timeouts);
    let apiKey: string;
    try {
      apiKey = config.secret(candidate.credential.id, candidate.credential.secret);
    } catch {
      return {
        ok: false,
        error: {
          class: 'auth',
          retryable: false,
          fallbackAllowed: true,
          credentialAction: 'disable',
          message: 'credential cannot be decrypted with MASTER_KEY',
        },
      };
    }
    let up;
    try {
      up = adapter.buildRequest({
        provider: candidate.provider,
        model: candidate.model,
        apiKey,
        request: canonical,
        credentialHeaders: candidate.credential.headers,
        clientHeaders: {
          'anthropic-beta':
            typeof req.headers['anthropic-beta'] === 'string'
              ? req.headers['anthropic-beta']
              : undefined,
        },
        onDrop: (field, reason) => {
          deps.logger.debug({ requestId, field, reason }, 'field dropped for provider');
        },
      });
    } catch (error) {
      // A request the adapter cannot build (a failing plugin, say) is a fault of this target, not
      // of the client: it counts as a server error, so the request falls back to the next target.
      deps.logger.warn(
        { requestId, provider: candidate.provider.slug, error: (error as Error).message },
        'provider request could not be built',
      );
      return {
        ok: false,
        error: {
          class: 'server',
          retryable: false,
          fallbackAllowed: true,
          message: (error as Error).message,
        },
      };
    }

    let call;
    try {
      call = await callUpstream(
        candidate.provider,
        traceparent ? { ...up, headers: { ...up.headers, traceparent } } : up,
        timeouts,
        signal,
        canonical.stream,
        candidate.credential.proxy?.url ?? candidate.provider.proxy?.url ?? settings.proxy?.url,
      );
    } catch (error) {
      return { ok: false, error: classifyNetworkError(error, error instanceof UpstreamTimeout) };
    }

    try {
      const { response } = call;
      if (!response.ok) {
        return {
          ok: false,
          error: adapter.classifyError({
            status: response.status,
            headers: response.headers,
            body: await readErrorBody(response),
          }),
        };
      }
      if (!canonical.stream) {
        const json: unknown = await response.json();
        const parsed = adapter.parseResponse(json, candidate.model.upstreamModel);
        // No usage from the provider: estimate with the tokenizer so both the client and the usage event get a number.
        const usage = parsed.usage ?? estimateUsage(canonical, parsed.content);
        return {
          ok: true,
          value: {
            kind: 'json',
            response: { ...parsed, usage },
            usageEstimated: parsed.usage === undefined,
          },
        };
      }
      return await pipeStream(
        api,
        canonical,
        candidate,
        adapter.createStreamDecoder(candidate.model.upstreamModel),
        call,
        reply,
        {
          includeUsage,
          started,
          requestId,
          heartbeatMs: deps.heartbeatMs ?? 15_000,
          draining: () => deps.lifecycle?.draining === true,
          shuttingDown: () => deps.lifecycle?.signal.aborted === true,
          guardrails: policiesFor(config.snapshot.guardrails, key),
          ...(claim ? { claim } : {}),
        },
      );
    } catch (error) {
      if (error instanceof CommittedFailure)
        return { ok: false, committed: true, error: error.classified };
      return {
        ok: false,
        error: classifyNetworkError(error, call.signal.reason instanceof UpstreamTimeout),
      };
    } finally {
      call.done();
    }
  };

  const hedging = route.combo?.hedging;
  const hedged = hedging?.enabled === true && route.candidates.length > 1;
  let hedgeBudget: HedgeBudget | undefined;
  if (hedging && hedged && deps.hedgeBudgets) {
    const budgetKey = `${String(hedging.maxRatio)}:${String(hedging.windowMs)}`;
    hedgeBudget = deps.hedgeBudgets.get(budgetKey);
    if (!hedgeBudget) {
      hedgeBudget = new HedgeBudget({ ratio: hedging.maxRatio, windowMs: hedging.windowMs });
      deps.hedgeBudgets.set(budgetKey, hedgeBudget);
    }
    hedgeBudget.recordRequest();
  }
  // Hedged attempts run in parallel against one client response. The first attempt that is about
  // to write claims it (a JSON answer is only written after the race, so this matters for
  // streams); every other attempt is aborted and no new one starts.
  let hedgeWinner: symbol | undefined;
  const hedgeLive = new Map<symbol, AbortController>();
  const admit = deps.bulkheads ? admitProvider(deps.bulkheads, ctx.queueOverrides) : undefined;
  const hedgedAttempt = async (
    candidate: Candidate,
    signal: AbortSignal,
  ): Promise<AttemptResult<Outcome>> => {
    const token = Symbol('hedge');
    const own = new AbortController();
    const onAbort = () => {
      own.abort(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    hedgeLive.set(token, own);
    // Provider concurrency caps apply to hedged attempts like to any other attempt.
    const admission = admit ? await admit(candidate, own.signal) : undefined;
    try {
      if (admission && !admission.ok) return { ok: false, error: admission.error };
      const result = await attempt(candidate, own.signal, 1, () => {
        if (hedgeWinner !== undefined) return hedgeWinner === token;
        hedgeWinner = token;
        for (const [other, controller] of hedgeLive)
          if (other !== token) controller.abort(new Error('superseded by another hedged attempt'));
        return true;
      });
      // An attempt that lost the race says nothing about the provider's health.
      const lost = hedgeWinner !== undefined && hedgeWinner !== token;
      const health = deps.store.healthRegistry;
      if (!lost && !signal.aborted) {
        const target = {
          providerId: candidate.provider.id,
          modelId: candidate.model.id,
          credentialId: candidate.credential.id,
        };
        health.providerBreaker(candidate.provider.id).begin();
        health.modelBreaker(candidate.model.id).begin();
        if (result.ok) health.recordSuccess(target);
        else health.recordFailure(target, result.error);
      }
      return result;
    } finally {
      signal.removeEventListener('abort', onAbort);
      hedgeLive.delete(token);
      if (admission?.ok) admission.release();
    }
  };
  const result =
    hedging && hedged
      ? await executeWithHedging(route.candidates, hedgedAttempt, {
          afterMs: hedging.afterMs,
          maxParallel: hedging.maxParallel,
          deadline: started + baseTimeouts.totalMs,
          signal: clientGone.signal,
          claimed: () => hedgeWinner !== undefined,
          ...(hedgeBudget ? { budget: hedgeBudget } : {}),
        })
      : await executeWithFallback(route.candidates, attempt, {
          retry,
          fallbackOn: route.fallbackOn,
          deadline: started + baseTimeouts.totalMs,
          budget: deps.budget,
          health: deps.store.healthRegistry,
          signal: clientGone.signal,
          ...(admit ? { admit } : {}),
        });
  // Each provider/model attempt has its own; the final request attribution comes from the event.
  for (const item of result.attempts) {
    if (item.outcome === 'skipped') continue;
    const provider = config.snapshot.providers.find((p) => p.id === item.providerId);
    const model = config.snapshot.models.find((m) => m.id === item.modelId);
    deps.metrics?.observeAttempt({
      provider: provider?.slug ?? item.providerId,
      model: model?.slug ?? item.modelId,
      outcome: item.outcome,
      latencyMs: item.latencyMs,
    });
  }

  const rememberResponse = (response: CanonicalResponse) => {
    storeResponseState(deps, api, key, canonical, response);
  };
  const candidate = result.candidate;
  // The provider answered (and is billed) but a response guardrail withheld the answer.
  let blockedByGuardrail = false;
  if (result.ok) {
    const outcome = result.value;
    void reply
      .header('x-dirouter-model', result.candidate.model.slug)
      .header('x-dirouter-provider', result.candidate.provider.slug)
      .header('x-dirouter-attempts', String(result.attempts.length));
    if (outcome.kind === 'json') {
      // Response guardrails (stage=response) run on the canonical answer before it is encoded.
      const policies = policiesFor(config.snapshot.guardrails, key);
      const guard = policies.length
        ? evaluateGuardrails(policies, { stage: 'response', response: outcome.response })
        : undefined;
      if (guard?.blocked) {
        sendError(
          reply,
          api,
          new DiRouterError('invalid_request', {
            message: guard.blocked.message,
            status: 400,
          }),
          requestId,
        );
        ctx.finishSpan('error', { 'gateway.guardrail': guard.blocked.policy.type });
        deps.metrics?.reject('guardrail', guard.blocked.policy.type);
        blockedByGuardrail = true;
      } else {
        // Exact cache store (card 13.1) only for deterministic, non-streaming responses.
        const cacheSettings = config.snapshot.settings.cache;
        // `/v1/responses` previous_response_id state (card 11.2); best effort, 7 days.
        rememberResponse(outcome.response);
        if (
          !ctx.cacheBypass &&
          cacheSettings?.exact?.enabled &&
          isCacheable(canonical, cacheSettings) &&
          deps.cache
        ) {
          const cacheKey = cacheKeyFor(key, canonical, result.candidate.model.id);
          void deps.cache.set(cacheKey, outcome.response, cacheSettings.exact.ttlSeconds);
        }
        const semantic = semanticSettingsFor(cacheSettings, key.projectId);
        if (
          semantic &&
          deps.semanticCache &&
          !ctx.cacheBypass &&
          !canonical.stream &&
          isSemanticCacheable(canonical)
        )
          void deps.semanticCache.store({
            organizationId: key.organizationId,
            projectId: key.projectId,
            ...(semantic.embeddingModel ? { embeddingModel: semantic.embeddingModel } : {}),
            modelId: result.candidate.model.id,
            model: canonical.model,
            text: semanticText(canonical),
            response: outcome.response,
            ttlSeconds: semantic.ttlSeconds,
          });
        reply.status(200).send(encodeResponse(api, outcome.response, canonical.model));
        ctx.finishSpan('ok', {
          'gateway.provider': result.candidate.provider.slug,
          'gateway.resolved_model': result.candidate.model.slug,
          'gateway.attempts': result.attempts.length,
        });
      }
    } else {
      // A cleanly finished stream populates the exact cache too, so agent clients (which always
      // stream) get hits; the entry is replayed in whichever format the next client uses.
      const streamCache = config.snapshot.settings.cache;
      if (outcome.result.conversation) rememberResponse(outcome.result.conversation);
      if (
        outcome.result.response &&
        !ctx.cacheBypass &&
        streamCache?.exact?.enabled &&
        isCacheable(canonical, streamCache) &&
        outcome.result.usage.outputTokens <= streamCache.exact.maxOutputTokens &&
        deps.cache
      ) {
        void deps.cache.set(
          cacheKeyFor(key, canonical, result.candidate.model.id),
          outcome.result.response,
          streamCache.exact.ttlSeconds,
        );
      }
      ctx.finishSpan('ok', {
        'gateway.provider': result.candidate.provider.slug,
        'gateway.resolved_model': result.candidate.model.slug,
        'gateway.attempts': result.attempts.length,
      });
    }
    // Routing statistics (cards 12.1 and 12.4): EWMA latency, recent volume and session pinning.
    config.router.stats.recordRequest(result.candidate.model.id);
    config.router.stats.recordLatency(
      result.candidate.model.id,
      outcome.kind === 'json' ? Date.now() - started : outcome.result.ttftMs,
    );
    if (route.combo?.sticky && ctx.sessionKey)
      config.router.pinSession(
        route.combo.id,
        ctx.sessionKey,
        result.candidate.model.id,
        result.candidate.credential.id,
      );
  } else if (!reply.raw.headersSent && deps.lifecycle?.signal.aborted) {
    sendError(
      reply,
      api,
      new DiRouterError('service_unavailable', { message: 'Gateway is shutting down, retry' }),
      requestId,
    );
  } else if (!reply.raw.headersSent && result.reason !== 'aborted') {
    deps.logger.warn(
      { requestId, reason: result.reason, error: result.error, attempts: result.attempts.length },
      'request failed upstream',
    );
    sendError(reply, api, toClientError(result.error, result.reason), requestId);
  }

  // Usage event: we never wait for it on the response path.
  const usage = result.ok
    ? result.value.kind === 'json'
      ? result.value.response.usage
      : result.value.result.usage
    : undefined;
  const usageEstimated = result.ok
    ? result.value.kind === 'json'
      ? result.value.usageEstimated
      : result.value.result.usageEstimated
    : false;
  const resolvedModel = config.snapshot.models.find((m) => m.id === candidate?.model.id);
  const resolvedProvider = config.snapshot.providers.find((p) => p.id === candidate?.provider.id);
  const { costUsd, chargeUsd } = emitUsageEvent(deps, config, {
    api,
    requestId,
    key,
    canonical,
    started,
    candidate,
    usage,
    usageEstimated,
    ok: result.ok && !blockedByGuardrail,
    httpStatus: result.ok && !blockedByGuardrail ? 200 : reply.statusCode,
    ttftMs: result.ok && result.value.kind === 'stream' ? result.value.result.ttftMs : undefined,
    errorCode: blockedByGuardrail
      ? 'content_filter'
      : result.ok
        ? undefined
        : (result.error?.class ?? result.reason),
    attempts: result.attempts,
    metricProvider: resolvedProvider?.slug ?? candidate?.provider.slug,
    metricModel: resolvedModel?.slug ?? candidate?.model.slug,
    savedInputTokens: ctx.savedInputTokens ?? 0,
    ...(ctx.routing ? { routing: ctx.routing } : {}),
    hedgeAttempts: result.ok ? ((result as { hedgeAttempts?: number }).hedgeAttempts ?? 0) : 0,
  });
  return { tokens: usage ? usage.inputTokens + usage.outputTokens : 0, costUsd, chargeUsd };
}

/** Each provider's bulkhead: if full, move to the next candidate (or 429 if no candidates remain). */
function admitProvider(
  bulkheads: BulkheadRegistry,
  overrides: { queueSize?: number; queueTimeoutMs?: number },
) {
  return async (candidate: Candidate, signal: AbortSignal | undefined) => {
    const bulkhead = bulkheads.get(
      `provider:${candidate.provider.id}`,
      candidate.provider.maxConcurrency,
      overrides,
    );
    if (!bulkhead) return { ok: true as const, release: () => undefined };
    const release = await bulkhead.acquire(signal);
    if (release) return { ok: true as const, release };
    return {
      ok: false as const,
      error: classified('rate_limit', {
        message: `Provider '${candidate.provider.slug}' is at its concurrency limit (${String(bulkhead.limit)})`,
        retryAfterMs: 1_000,
      }),
    };
  };
}

class CommittedFailure extends Error {
  constructor(readonly classified: ClassifiedError) {
    super(classified.message);
  }
}

async function pipeStream(
  api: InboundApi,
  canonical: CanonicalRequest,
  candidate: Candidate,
  decoder: ReturnType<ReturnType<typeof adapterForProvider>['createStreamDecoder']>,
  call: Awaited<ReturnType<typeof callUpstream>>,
  reply: FastifyReply,
  opts: {
    includeUsage: boolean;
    started: number;
    requestId: string;
    heartbeatMs: number;
    draining: () => boolean;
    shuttingDown: () => boolean;
    guardrails?: readonly GuardrailPolicy[];
    /** Hedging: claims the client response for this attempt; false when another one owns it. */
    claim?: () => boolean;
  },
): Promise<AttemptResult<Outcome>> {
  const encoder = streamEncoderFor(api, canonical, opts.includeUsage);
  const streamGuard = new StreamGuardrailBuffer(opts.guardrails ?? []);
  const parser = new SseParser();
  const raw = reply.raw;
  // Kept in state because it is changed inside the commit closure.
  const state = { committed: false, ttftMs: 0 };
  // Output text for estimating usage when upstream does not send it.
  const output: string[] = [];
  // Rebuilds the full response so a clean stream can be cached and replayed (card 13.1).
  const assembler = new StreamAssembler();
  const collect = (ev: CanonicalStreamEvent) => {
    assembler.push(ev);
    if (ev.type === 'text_delta') output.push(ev.text);
    else if (ev.type === 'reasoning_delta' && ev.text) output.push(ev.text);
    else if (ev.type === 'tool_call_start') output.push(ev.name, ' ');
    else if (ev.type === 'tool_call_delta') output.push(ev.argumentsDelta);
  };
  let heartbeat: NodeJS.Timeout | undefined;
  let lastTextIndex = 0;

  const write = async (text: string) => {
    if (text === '' || raw.destroyed) return;
    if (!raw.write(text)) await new Promise<void>((resolve) => raw.once('drain', resolve));
  };
  const commit = () => {
    // Hedged requests: only one attempt may write to the client; a loser stops here, before a
    // single byte is sent, and is reported as an ordinary (uncommitted) failure.
    if (opts.claim && !opts.claim()) throw new Error('superseded by another hedged attempt');
    state.committed = true;
    state.ttftMs = Date.now() - opts.started;
    reply.hijack();
    // Global headers (x-request-id, x-dirouter-instance) must also remain in the stream.
    const base = Object.fromEntries(
      Object.entries(reply.getHeaders()).filter(
        (e): e is [string, string | number | string[]] => e[1] !== undefined,
      ),
    );
    raw.writeHead(200, {
      ...base,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: opts.draining() ? 'close' : 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': opts.requestId,
      'x-dirouter-model': candidate.model.slug,
      'x-dirouter-provider': candidate.provider.slug,
    });
    heartbeat = setInterval(() => {
      void write(encoder instanceof AnthropicStreamEncoder ? encoder.ping() : SSE_HEARTBEAT);
    }, opts.heartbeatMs);
    heartbeat.unref();
  };

  const blockStream = async (message: string): Promise<never> => {
    if (!state.committed) commit();
    await write(encoder.push({ type: 'error', code: 'content_filter', message }));
    raw.end();
    throw new CommittedFailure({
      class: 'content_filter',
      retryable: false,
      fallbackAllowed: false,
      message,
    });
  };
  // Releases the text the stream guardrail is still holding back. It runs before every non-text
  // event: once a block is closed or the finish event is out, the client formats have no place
  // left for that text (an Anthropic block cannot be reopened, OpenAI already sent finish_reason).
  const releaseHeld = async () => {
    if (!streamGuard.active) return;
    const tail = streamGuard.finish();
    if (tail.blocked) await blockStream(tail.blocked);
    if (tail.text === '') return;
    if (!state.committed) commit();
    await write(encoder.push({ type: 'text_delta', index: lastTextIndex, text: tail.text }));
  };
  /** Forwards one canonical event; returns the error when upstream failed before any byte was sent. */
  const forward = async (ev: CanonicalStreamEvent): Promise<ClassifiedError | undefined> => {
    if (ev.type === 'error') {
      // Adapters name the failure in the event code; anything unknown is a server error.
      const classified: ClassifiedError = /overload/i.test(ev.code)
        ? { class: 'overloaded', retryable: true, fallbackAllowed: true, message: ev.message }
        : ev.code === 'rate_limit'
          ? { class: 'rate_limit', retryable: true, fallbackAllowed: true, message: ev.message }
          : ev.code === 'timeout'
            ? { class: 'timeout', retryable: true, fallbackAllowed: true, message: ev.message }
            : ev.code === 'bad_request'
              ? {
                  class: 'bad_request',
                  retryable: false,
                  fallbackAllowed: false,
                  message: ev.message,
                }
              : { class: 'server', retryable: true, fallbackAllowed: true, message: ev.message };
      if (!state.committed) return classified;
      await write(encoder.push(ev));
      throw new CommittedFailure(classified);
    }
    // Cross-chunk response redaction (card 15.1): text deltas are buffered briefly so a match
    // split across two SSE events is still caught before it reaches the client.
    if (streamGuard.active && ev.type === 'text_delta') {
      collect(ev);
      lastTextIndex = ev.index;
      const guarded = streamGuard.push(ev.text);
      if (guarded.blocked) await blockStream(guarded.blocked);
      if (!state.committed) commit();
      if (guarded.text !== '') await write(encoder.push({ ...ev, text: guarded.text }));
      return undefined;
    }
    if (ev.type !== 'usage') await releaseHeld();
    if (!state.committed) commit();
    collect(ev);
    await write(encoder.push(ev));
    return undefined;
  };

  try {
    const body = call.response.body;
    if (!body) throw new Error('empty upstream body');
    for await (const chunk of body) {
      call.touch();
      // Binary upstream framing (AWS event stream) is decoded by the adapter itself.
      const events = decoder.feedChunk
        ? decoder.feedChunk(chunk as Uint8Array)
        : parser.feed(chunk as Uint8Array).flatMap((event) => decoder.push(event));
      for (const ev of events) {
        const failed = await forward(ev);
        if (failed) return { ok: false, error: failed };
      }
    }
    const rest = decoder.feedChunk
      ? (decoder.flushChunks?.() ?? [])
      : parser.flush().flatMap((event) => decoder.push(event));
    for (const ev of rest) {
      const failed = await forward(ev);
      if (failed) return { ok: false, error: failed };
    }
    await releaseHeld();
    if (!state.committed) commit();
    const usageEstimated = encoder.usage === undefined;
    const usage = encoder.usage ?? estimateUsage(canonical, output.join(''));
    if (usageEstimated) await write(encoder.push({ type: 'usage', usage }));
    await write(encoder.end());
    raw.end();
    return {
      ok: true,
      value: {
        kind: 'stream',
        result: {
          usage,
          usageEstimated,
          ttftMs: state.ttftMs,
          // Never cache text that a stream guardrail rewrote: a replay would skip that guardrail.
          ...(streamGuard.active ? {} : { response: assembler.result(usage) }),
          ...(api === 'openai.responses' ? { conversation: assembler.result(usage) } : {}),
        },
      },
    };
  } catch (error) {
    if (error instanceof CommittedFailure) {
      raw.end();
      throw error;
    }
    if (state.committed) {
      // Upstream cut after bytes were sent: standard error and end (fallback is not possible).
      const classified = classifyNetworkError(error, call.signal.reason instanceof UpstreamTimeout);
      await write(
        encoder.push({
          type: 'error',
          code: classified.class,
          message: opts.shuttingDown()
            ? 'gateway shutting down, retry the request'
            : 'upstream stream interrupted',
        }),
      );
      raw.end();
      throw new CommittedFailure(classified);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

function emitUsageEvent(
  deps: ProxyDeps,
  config: LoadedConfig,
  e: {
    api: InboundApi;
    requestId: string;
    key: {
      id: string;
      organizationId: string;
      teamId: string | null;
      projectId: string;
      walletId?: string | undefined;
      priceMultiplier?: string | undefined;
    };
    canonical: CanonicalRequest;
    started: number;
    candidate: Candidate | undefined;
    usage: CanonicalUsage | undefined;
    usageEstimated: boolean;
    ok: boolean;
    httpStatus: number;
    ttftMs: number | undefined;
    errorCode: string | undefined;
    attempts: Awaited<ReturnType<typeof executeWithFallback>>['attempts'];
    metricProvider?: string;
    metricModel?: string;
    cacheHit?: boolean;
    cacheKind?: 'exact' | 'semantic';
    savedInputTokens?: number;
    hedgeAttempts?: number;
    routing?: UsageEvent['routing'];
  },
): { costUsd: string; chargeUsd: string } {
  try {
    // A failed upstream request consumed no tokens (or we have no record of it); cost is zero.
    const usage: CanonicalUsage = e.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const costUsd =
      e.candidate && e.ok && e.cacheHit !== true
        ? computeCostUsd(usage, e.candidate.model.pricing)
        : '0';
    // Sale price (card 19.4): what the customer pays for this request.
    const charge =
      e.candidate && e.ok
        ? chargeUsd(usage, e.candidate.model, {
            groupMultiplier: e.key.priceMultiplier,
            cacheHit: e.cacheHit === true,
          })
        : '0.00000000';
    const event: UsageEvent = {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: ulid(),
      idempotencyKey: e.requestId,
      requestId: e.requestId,
      occurredAt: new Date(e.started).toISOString(),
      gatewayInstance: deps.instance,
      configVersion: config.version,
      organizationId: e.key.organizationId,
      teamId: e.key.teamId,
      projectId: e.key.projectId,
      virtualKeyId: e.key.id,
      ...(e.key.walletId ? { walletId: e.key.walletId } : {}),
      ...(e.canonical.user ? { endUser: e.canonical.user } : {}),
      inboundApi: e.api,
      requestedModel: e.canonical.model,
      resolvedModelId: e.candidate?.model.id ?? null,
      providerId: e.candidate?.provider.id ?? null,
      credentialId: e.candidate?.credential.id ?? null,
      stream: e.canonical.stream,
      status: e.ok ? 'success' : 'error',
      httpStatus: e.httpStatus,
      ...(e.errorCode ? { errorCode: e.errorCode } : {}),
      usage,
      costUsd,
      chargeUsd: charge,
      usageEstimated: e.usageEstimated,
      ...(e.cacheHit ? { cacheHit: true } : {}),
      ...(e.cacheKind ? { cacheKind: e.cacheKind } : {}),
      ...(e.savedInputTokens && e.savedInputTokens > 0
        ? { savedInputTokens: e.savedInputTokens }
        : {}),
      ...(e.hedgeAttempts && e.hedgeAttempts > 0 ? { hedgeAttempts: e.hedgeAttempts } : {}),
      ...(e.routing ? { routing: e.routing } : {}),
      latencyMs: Date.now() - e.started,
      ...(e.ttftMs !== undefined ? { ttftMs: e.ttftMs } : {}),
      attempts: e.attempts
        .filter((a) => a.outcome !== 'skipped')
        .map((a) => ({
          providerId: a.providerId,
          modelId: a.modelId,
          credentialId: a.credentialId,
          outcome:
            a.outcome === 'success'
              ? 'success'
              : a.errorClass === 'timeout'
                ? 'timeout'
                : a.errorClass === 'rate_limit'
                  ? 'rate_limited'
                  : 'error',
          ...(a.status !== undefined ? { httpStatus: a.status } : {}),
          ...(a.errorClass ? { errorCode: a.errorClass } : {}),
          latencyMs: a.latencyMs,
          startedAt: new Date(a.startedAt).toISOString(),
        })),
    };
    deps.metrics?.observe({
      ...event,
      providerId: e.metricProvider ?? event.providerId,
      resolvedModelId: e.metricModel ?? event.resolvedModelId,
    });
    deps.onRequestComplete?.(event);
    deps.emitUsage(event);
    return { costUsd, chargeUsd: charge };
  } catch (error) {
    deps.logger.error({ err: error, requestId: e.requestId }, 'failed to build usage event');
    return { costUsd: '0', chargeUsd: '0' };
  }
}

/**
 * Session identity derived from the stable prefix of a conversation (card 12.4). Returns undefined
 * for requests without a system prompt and with a single message: those are one-off calls and
 * pinning them would only defeat load balancing.
 */
export function promptPrefixSessionKey(
  keyId: string,
  canonical: { system: unknown[]; messages: unknown[] },
): string | undefined {
  if (canonical.system.length === 0 && canonical.messages.length < 2) return undefined;
  const prefix = JSON.stringify([canonical.system, canonical.messages[0] ?? null]);
  return `${keyId}:p:${createHash('sha256').update(prefix).digest('hex').slice(0, 32)}`;
}
