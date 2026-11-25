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
  type ExternalVerdict,
  type GuardrailHit,
  guardrailText,
  type GuardrailPolicy,
  type InboundApi,
  type RouteDecision,
  OpenAIChatCompletionRequest,
  USAGE_EVENT_SCHEMA_VERSION,
  type UsageEvent,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import {
  computeCostUsd,
  estimateRequestTokens,
  pricingForServiceTier,
  estimateUsage,
  roughTokens,
} from '@dirouter/model-catalog';
import {
  type ClassifiedError,
  acceptsMedia,
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
  encodeExplanation,
  type ExplainAttempt,
  explainPlan,
  isPlanError,
  parseModelSuffixes,
  planRoute,
  type ResolvedRoute,
  type RetryBudget,
  type RouteExplanation,
  withAttempts,
  type SplitHealth,
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
  mediaNeeds,
  openAIRequestToCanonical,
  responsesRequestToCanonical,
  UnsupportedContentError,
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
import {
  aliasPolicyFor,
  dropParamsFor,
  dropReporterFor,
  PARAMS_HEADER,
  repairAnswer,
  repairKindsFor,
  repairRequest,
  shapeForCandidate,
  withoutDropParams,
} from './shaping.js';
import { externalVerdicts } from './classifiers.js';
import { type BodyCapture, type RecordBody, startBodyCapture } from './body-capture.js';
import {
  evaluateGuardrails,
  MAX_HELD_ANSWER,
  policiesFor,
  StreamGuardrailBuffer,
} from './guardrails.js';
import type { Tracer, TraceSpan } from './tracing.js';
import type { WebServices } from './web/service.js';
import {
  type Attributes,
  genAiOperation,
  genAiProviderName,
  genAiRequestAttributes,
  genAiResponseAttributes,
  serverAttributes,
} from './genai.js';
import { resolveCredentialKey, tokenFailure } from './credential-tokens.js';
import { callUpstream, mergeTimeouts, readErrorBody, UpstreamTimeout } from './upstream.js';
import { applyRoutingRules, applyTrafficSplit } from './routing-policy.js';
import { type AutoControls, autoControls } from './auto-controls.js';
import { type ShadowRunner, shadowPolicyFor } from './shadow.js';
import type { WebSearchExtension } from './web-search.js';
import {
  planErrorToClient,
  type RequestRouting,
  routingFromRequest,
  suffixedRequest,
  withoutRoutingFields,
  withSuffixes,
} from './route-request.js';

export interface ProxyDeps {
  store: ConfigStore;
  /** Web search for the `:online` suffix (card 31.5); provided by card 30.8. */
  webSearch?: WebSearchExtension;
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
  /** Destination of captured request bodies (card 24.1); never the usage path. */
  recordBody?: RecordBody;
  /** Shadow copies of sampled requests, sent after the answer (card 32.4). */
  shadow?: ShadowRunner;
  /** Canary error rates and rollbacks, kept across snapshots (card 32.3). */
  splitHealth?: SplitHealth;
  /**
   * Web search and fetch (card 30.8). `web.serveOnline(api, req, reply)` answers a chat request in
   * online mode (search, inject the results, return the sources) for the `:online` suffix.
   */
  web?: WebServices;
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
  /** The whole answer as the provider streamed it, before stream guardrails (body capture). */
  assembled?: CanonicalResponse | undefined;
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

/**
 * Leaves a trail for guardrail hits (policy ids, actions and counts, never the text) and reports
 * enabled policies of a type this gateway does not enforce (card 23.1): they used to be skipped
 * silently.
 */
function reportGuardrails(
  deps: Pick<ProxyDeps, 'logger' | 'metrics'>,
  requestId: string,
  stage: 'request' | 'response',
  result: { hits: readonly GuardrailHit[]; unknown: readonly GuardrailPolicy[] },
): void {
  if (result.hits.length > 0)
    deps.logger.info(
      {
        requestId,
        stage,
        guardrails: result.hits.map((hit) => ({
          policyId: hit.policyId,
          type: hit.type,
          action: hit.action,
          matches: hit.matches,
        })),
      },
      'guardrail hits',
    );
  for (const policy of result.unknown) {
    deps.metrics?.guardrailUnknown(policy.type);
    deps.logger.warn(
      { requestId, stage, policyId: policy.id, type: policy.type },
      'guardrail policy of an unknown type was not enforced',
    );
  }
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
  /** The request's tools: Responses clients get their coding-tool calls back (card 31.2). */
  tools?: CanonicalRequest['tools'],
): unknown {
  switch (api) {
    case 'gemini.generate':
      return canonicalToGeminiResponse(response, { model });
    case 'openai.responses':
      return canonicalToResponsesResponse(response, { model, tools });
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
  if (api === 'openai.responses')
    return new ResponsesStreamEncoder({ model: canonical.model, tools: canonical.tools });
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
  const state: { capture?: BodyCapture } = {};
  try {
    await proxyRequest(api, req, reply, deps, state);
  } finally {
    // A stream's answer is handed over after the response has already closed.
    state.capture?.handlerDone();
  }
}

async function proxyRequest(
  api: InboundApi,
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
  state: { capture?: BodyCapture },
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
  let requestRouting: RequestRouting;
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
    canonical = withoutRoutingFields(parseInbound(api, req.body, deps.logger));
    // Provider preferences and fallback models (card 32.1), merged with the key's policy.
    requestRouting = routingFromRequest(config.snapshot.routingPolicies, key, req.body);
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

  // Model suffixes (card 31.5): `:nitro`, `:floor`, `:free`, `:online` and reasoning effort. A
  // name that exists as written (an `auto*` alias too) is never split.
  const suffix = parseModelSuffixes(
    canonical.model,
    (name) => isAutoAlias(name) || config.router.modelsFor(key, name) !== undefined,
  );
  if (suffix.suffixes.length > 0) {
    canonical = suffixedRequest(canonical, suffix);
    requestRouting = withSuffixes(requestRouting, suffix);
    if (suffix.webSearch && (!deps.webSearch || deps.webSearch.available?.() === false)) {
      sendError(
        reply,
        api,
        new DiRouterError('web_search_unavailable', {
          message:
            'The :online suffix needs web search, which is not enabled on this gateway; remove the suffix to send the request without search',
          param: 'model',
        }),
        requestId,
      );
      observeEarly(reply.statusCode);
      return;
    }
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

  // Request body capture (card 24.1): nothing runs unless the key's level asks for it. The answer
  // is taken from the reply as it is sent; the record is built and queued once the response has
  // closed and this handler has finished, whichever comes last.
  const capture = deps.recordBody
    ? startBodyCapture(
        {
          snapshot: config.snapshot,
          key,
          api,
          requestId,
          started,
          body: req.body,
          canonical,
          contentLength: Number(req.headers['content-length']) || undefined,
        },
        deps.recordBody,
        (error) => {
          deps.logger.warn({ err: error, requestId }, 'request body capture failed');
        },
      )
    : undefined;
  if (capture) {
    state.capture = capture;
    const send = reply.send.bind(reply);
    reply.send = (payload?: unknown) => {
      capture.setResponse(payload);
      return send(payload);
    };
    reply.raw.once('close', () => {
      capture.responseClosed();
    });
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
          // GenAI semantic conventions (card 24.3); usage is on the upstream CLIENT spans.
          ...genAiRequestAttributes(api, canonical),
        },
        req.headers.traceparent,
      )
    : undefined;
  const finishSpan = (status: 'ok' | 'error', extra?: Attributes) => {
    if (!span) return;
    span.end(status, extra ?? {});
  };

  // Guardrails (card 15.1) run before routing so a blocked request never reaches a provider.
  pageGuard: {
    const policies = policiesFor(config.snapshot.guardrails, key);
    if (policies.length === 0) break pageGuard;
    // Moderation and classifier policies (cards 23.2 and 23.3) need a model call first.
    const external = await externalVerdicts(
      req,
      deps,
      policies,
      'request',
      guardrailText({ stage: 'request', request: canonical }),
    );
    const guard = evaluateGuardrails(policies, {
      stage: 'request',
      request: canonical,
      estimatedInputTokens: estimateRequestTokens(canonical, roughTokens),
      external,
    });
    reportGuardrails(deps, requestId, 'request', guard);
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

  // Tool-call repair of the replayed history (card 31.1), when the key or header asks for it.
  canonical = repairRequest(
    withoutDropParams(canonical),
    repairKindsFor(req.headers, key),
    deps,
    requestId,
  );

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
  // Conditional routing rules (card 32.2) run before automatic routing and candidate selection.
  // A `route` rule replaces the name the rest of the pipeline resolves; the client-facing name in
  // the answer stays what the client sent.
  let routeName = canonical.model;
  let policy: UsageEvent['policy'];
  let ruleDecided: { id: string; name: string } | undefined;
  const budgetGuard = deps.budgets;
  const rules = await applyRoutingRules(
    config,
    key,
    req,
    canonical,
    estimatedInputTokens,
    budgetGuard ? () => budgetGuard.usage(budgetScopes(config, key)) : undefined,
  );
  if (rules && rules.trace.matched.length > 0) {
    policy = { rules: rules.trace };
    const decidedBy = rules.decision.decidedBy;
    if (decidedBy) {
      void reply.header('x-dirouter-rule', decidedBy.id);
      ruleDecided = { id: decidedBy.id, name: decidedBy.name };
    }
    if (rules.decision.reject) {
      sendError(
        reply,
        api,
        new DiRouterError('forbidden', {
          message: rules.decision.reject.message,
          status: rules.decision.reject.status,
        }),
        requestId,
      );
      deps.metrics?.reject('routing_rule', 'reject');
      finishSpan('error', { 'gateway.error': 'routing_rule' });
      observeEarly(reply.statusCode);
      return;
    }
    if (rules.decision.target) routeName = rules.decision.target;
  }
  // Canary and percentage split (card 32.3) of the name the rules left; the branch is sticky per
  // key or session, and a failing canary rolls itself back.
  const split = applyTrafficSplit(config, deps.splitHealth, key, routeName, req, reply);
  if (split) {
    policy = { ...policy, split: split.trace };
    routeName = split.target;
  }
  // The rule's or split's target is the organization's choice: the key's allow-list applied to the
  // name the client sent (checked before the rules ran), not to where a policy sends it.
  const ruleRouted = routeName !== canonical.model;

  // Automatic model choice for the `auto*` aliases (card 20.4), unless the organization defines a
  // model, alias or combo of that name itself, or the key may not use the alias.
  let routing: UsageEvent['routing'];
  // Cost tier and model sets of automatic routing (card 32.8), with the classification they use.
  let controls: AutoControls | undefined;
  let autoClassification: ReturnType<typeof classifyRequest> | undefined;
  const autoRouting = settings.autoRouting;
  if (
    autoRouting?.enabled &&
    isAutoAlias(routeName) &&
    !config.router.modelsFor(key, routeName) &&
    (ruleRouted || key.allowedModels.length === 0 || key.allowedModels.includes(routeName))
  ) {
    const alias = routeName;
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
    const held = autoControls(config, key);
    controls = held;
    autoClassification = classification;
    const decision = decideAuto(
      alias,
      autoRouting,
      classification,
      {
        modelsOf: (name) => held.permitted(config.router.modelsFor(key, name)),
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
    routing = {
      ...decision,
      reasons: [...decision.reasons, ...held.reasons()],
      classifierMicros: Math.round(classifierElapsed * 1_000),
      ...(held.policy?.costTier ? { costTier: held.policy.costTier } : {}),
    };
    void reply.header('x-dirouter-auto', `${decision.target}; type=${classification.taskType}`);
    deps.logger.debug({ requestId, routing }, 'auto routing decision');
  }
  // The alias was checked against the key above; the target is the gateway's choice, not the client's.
  if (requestRouting.clientIgnored) void reply.header('x-dirouter-preferences', 'locked');
  // Routing explanation (card 32.7): only for keys whose policy allows it, and only on request.
  const explainAllowed = requestRouting.policy.explain && wantsExplanation(req.headers);
  // Same planner as the routing simulator (cards 12.5 and 32.1): resolve, fallback models, then
  // provider preferences.
  const route = planRoute(config.router, {
    key: routing || ruleRouted ? { ...key, allowedModels: [] } : key,
    model: routing?.target ?? routeName,
    fallbackModels: requestRouting.fallbackModels,
    preferences: requestRouting.preferences,
    dataPolicy: requestRouting.dataPolicy,
    freeOnly: suffix.freeOnly,
    resolve: {
      estimatedInputTokens,
      ...(canonical.maxOutputTokens !== undefined
        ? { maxOutputTokens: canonical.maxOutputTokens }
        : {}),
      ...(sessionKey ? { sessionKey } : {}),
      // Power-of-two-choices for `latency` combos (card 12.1); other strategies ignore it.
      p2c: true,
    },
  });
  if (isPlanError(route)) {
    const error = planErrorToClient(route, routeName);
    if (route.error === 'no_provider_matches_data_policy')
      deps.logger.info(
        { requestId, dataPolicy: requestRouting.dataPolicy, skipped: route.skipped },
        'no provider satisfies the data policy',
      );
    else deps.logger.debug({ requestId, skipped: route.skipped }, 'route failed');
    if (explainAllowed)
      void reply.header(
        EXPLAIN_HEADER,
        Buffer.from(
          JSON.stringify({
            requested: canonical.model,
            error: route.error,
            skipped: route.skipped,
          }),
        ).toString('base64url'),
      );
    sendError(reply, api, error, requestId);
    finishSpan('error', { 'gateway.error': route.error });
    // A request on a split branch is always logged with its branch, so the split report counts the
    // canary requests that failed before reaching a provider (its breaker open, say) as errors too.
    if (policy?.split) {
      observed = true;
      emitUsageEvent(deps, config, {
        api,
        requestId,
        key,
        canonical,
        started,
        candidate: undefined,
        usage: undefined,
        usageEstimated: false,
        ok: false,
        httpStatus: reply.statusCode,
        ttftMs: undefined,
        errorCode: route.error,
        attempts: [],
        policy,
      });
    } else observeEarly(reply.statusCode);
    return;
  }

  // The automatic routing policy (card 32.8) holds every candidate, so a combo's fallback cannot
  // bring an expensive or excluded model back; `auto` also picks a reasoning effort.
  if (routing && controls && autoClassification) {
    const problem = controls.restrict(route);
    if (problem) {
      sendError(
        reply,
        api,
        new ForbiddenError('model_not_allowed', { message: problem, param: 'model' }),
        requestId,
      );
      finishSpan('error', { 'gateway.error': 'auto_policy' });
      observeEarly(reply.statusCode);
      return;
    }
    const effort = controls.effort(autoClassification, route, canonical.reasoning?.effort);
    if (effort) {
      canonical = { ...canonical, reasoning: { ...canonical.reasoning, effort } };
      routing = {
        ...routing,
        reasoningEffort: effort,
        reasons: [...routing.reasons, `reasoning effort ${effort}`],
      };
    }
  }

  // Documents and audio (card 27.2) only go to targets that can take them; when none can, the
  // client gets a 400 that says so instead of an answer to a request with its files removed.
  const needs = mediaNeeds(canonical);
  if (needs.documents || needs.audio) {
    const fits = route.candidates.filter((c) =>
      acceptsMedia(c.provider.type, c.model.capabilities, needs),
    );
    if (fits.length === 0) {
      const what = [needs.documents && 'document (PDF or file)', needs.audio && 'audio']
        .filter(Boolean)
        .join(' and ');
      sendError(
        reply,
        api,
        new DiRouterError('invalid_request', {
          message: `Model '${canonical.model}' cannot take ${what} input: no provider behind it supports it`,
          param: 'messages',
          status: 400,
        }),
        requestId,
      );
      finishSpan('error', { 'gateway.error': 'unsupported_content' });
      observeEarly(reply.statusCode);
      return;
    }
    route.candidates.splice(0, route.candidates.length, ...fits);
  }

  // The routing decision (card 32.7): the same view as the simulator's, kept with the request log
  // and, when allowed and asked for, returned in the x-dirouter-routing header.
  const explanation = explainPlan(route, {
    estimatedInputTokens,
    maxOutputTokens: canonical.maxOutputTokens,
    priceMultiplier: key.priceMultiplier,
    priced: (m) => ({ ...m, pricing: pricingForServiceTier(m.pricing, canonical.serviceTier) }),
    suffixes: suffix.suffixes,
    ...(ruleDecided
      ? { rule: ruleDecided }
      : routing
        ? {
            rule: {
              id: `auto:${routing.alias}`,
              name: `${routing.alias} → ${routing.target}${routing.taskType ? ` (${routing.taskType})` : ''}`,
            },
          }
        : {}),
  });
  if (explainAllowed) void reply.header(EXPLAIN_HEADER, encodeExplanation(explanation));

  // Web search for the `:online` suffix (card 31.5): the extension (card 30.8) adds the results to
  // the request once the route is known, so a request that cannot be routed is never searched.
  if (suffix.webSearch && deps.webSearch) {
    try {
      canonical = await deps.webSearch.augment(canonical, {
        organizationId: key.organizationId,
        projectId: key.projectId,
        virtualKeyId: key.id,
        requestId,
      });
    } catch (error) {
      sendError(
        reply,
        api,
        error instanceof DiRouterError
          ? error
          : new DiRouterError('service_unavailable', { message: 'Web search failed' }),
        requestId,
      );
      finishSpan('error', { 'gateway.error': 'web_search' });
      observeEarly(reply.statusCode);
      return;
    }
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
        // A service tier (card 31.5) is reserved at its own price.
        route.candidates.map((c) => ({
          model: {
            ...c.model,
            pricing: pricingForServiceTier(c.model.pricing, canonical.serviceTier),
          },
        })),
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
      const external = await externalVerdicts(
        req,
        deps,
        policies,
        'response',
        guardrailText({ stage: 'response', response: copy }),
      );
      const guard = evaluateGuardrails(policies, { stage: 'response', response: copy, external });
      reportGuardrails(deps, requestId, 'response', guard);
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
      reply.status(200).send(encodeResponse(api, cached, canonical.model, canonical.tools));
    }
    // A replayed stream is kept as the one JSON answer it was built from, like a live stream.
    capture?.setResponse(encodeResponse(api, cached, canonical.model, canonical.tools), {
      streamed: canonical.stream,
      finishReason: cached.finishReason,
    });
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
      ...(policy ? { policy } : {}),
      ...(firstCandidate
        ? {
            metricProvider: firstCandidate.provider.slug,
            metricModel: firstCandidate.model.slug,
          }
        : {}),
    });
    // Cached answers cost nothing upstream but may be sold (sale.cacheMultiplier, card 19.4).
    settleWallet(cachedCharge.chargeUsd);
    finishSpan('ok', {
      'gateway.cache': cacheKind ?? 'exact',
      ...(firstCandidate
        ? { 'gen_ai.provider.name': genAiProviderName(firstCandidate.provider.type) }
        : {}),
      // A cache hit has no upstream span, so its usage (zero cost) is reported here.
      ...genAiResponseAttributes(cached, cached.usage),
    });
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
        ...(policy ? { policy } : {}),
        routeDecision: routeDecisionOf(explanation),
        ...(explainAllowed ? { explanation } : {}),
        finishSpan,
        ...(span ? { span } : {}),
        ...(capture ? { capture } : {}),
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
    // Shadow traffic (card 32.4): only now, with the answer (or the whole stream) already out,
    // and detached from this request; it never touches the limits, budget or wallet above.
    if (deps.shadow && config.snapshot.shadowPolicies.length > 0) {
      const shadowPolicy = shadowPolicyFor(config.snapshot, key, canonical.model);
      if (shadowPolicy) {
        const served = reply.getHeader('x-dirouter-model');
        deps.shadow.mirror(config, shadowPolicy, key, canonical, {
          requestId,
          model: typeof served === 'string' ? served : null,
          status: reply.statusCode,
          latencyMs: Date.now() - started,
          costUsd: spent.costUsd,
        });
      }
    }
  }
}

/**
 * What the request log keeps of a route plan (card 32.5): the data policy and every target removed
 * while planning. Undefined when there is nothing to tell.
 */
function routeDecisionOf(e: RouteExplanation): RouteDecision {
  return {
    ...(e.suffixes ? { suffixes: e.suffixes } : {}),
    ...(e.models.length > 1 || e.models[0] !== e.requested ? { models: e.models } : {}),
    ...(e.rule ? { rule: e.rule } : {}),
    ...(e.dataPolicy ? { dataPolicy: e.dataPolicy } : {}),
    ...(e.preferences ? { preferences: e.preferences } : {}),
    candidates: e.candidates.map((c) => ({
      modelId: c.modelId,
      providerId: c.providerId,
      credentialId: c.credentialId,
      estimatedCostUsd: c.estimatedCostUsd,
    })),
    ...(e.skipped.length > 0 ? { skipped: e.skipped } : {}),
    ...(e.estimatedCostUsd ? { estimatedCostUsd: e.estimatedCostUsd } : {}),
  };
}

/** Response header with the routing explanation (card 32.7). */
const EXPLAIN_HEADER = 'x-dirouter-routing';

/** The client asks for the explanation with `x-dirouter-explain: 1` (or `true`). */
function wantsExplanation(headers: FastifyRequest['headers']): boolean {
  const value = headers['x-dirouter-explain'];
  return typeof value === 'string' && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
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
    /** What the organization's routing policies did (sprint 5). */
    policy?: UsageEvent['policy'];
    /** How the route was planned (cards 32.5 and 32.7), for the request log. */
    routeDecision?: RouteDecision | undefined;
    /** Set when the client may and did ask for the routing explanation (card 32.7). */
    explanation?: RouteExplanation;
    finishSpan: (status: 'ok' | 'error', extra?: Attributes) => void;
    /** Request span; every upstream attempt becomes a child of it. */
    span?: TraceSpan;
    /** Request body capture (card 24.1); a stream's answer is handed over here. */
    capture?: BodyCapture;
  },
): Promise<{ tokens: number; costUsd: string; chargeUsd: string }> {
  const { config, key, canonical, route, requestId, started, clientGone } = ctx;

  const settings = config.snapshot.settings;
  const repairKinds = repairKindsFor(req.headers, key);
  const aliasPolicy = aliasPolicyFor(config.snapshot, key, route.requested);
  const dropParams = dropParamsFor(req.headers, req.body, key);
  const retry = route.combo?.retry ?? settings.defaultRetry;
  const baseTimeouts = mergeTimeouts(settings.defaultTimeouts, route.combo?.timeouts);
  const includeUsage =
    api === 'anthropic.messages' ||
    (req.body as { stream_options?: { include_usage?: boolean } } | undefined)?.stream_options
      ?.include_usage === true;

  // Attempts finished so far, for the explanation header of a stream (card 32.7): a stream sends
  // its headers when it starts, before the executor's own record is complete.
  const tried: ExplainAttempt[] = [];
  const explainHeaders = (candidate: Candidate): Record<string, string> =>
    ctx.explanation
      ? {
          [EXPLAIN_HEADER]: encodeExplanation(
            withAttempts(ctx.explanation, [
              ...tried,
              {
                modelId: candidate.model.id,
                providerId: candidate.provider.id,
                credentialId: candidate.credential.id,
                outcome: 'streaming',
                latencyMs: Date.now() - started,
              },
            ]),
          ),
        }
      : {};

  // One client span per upstream attempt (retry, fallback or hedge), with its own traceparent.
  const attempt = async (
    candidate: Candidate,
    signal: AbortSignal,
    _attempt?: number,
    claim?: () => boolean,
  ): Promise<AttemptResult<Outcome>> => {
    // A GenAI inference CLIENT span (card 24.3): `{operation} {upstream model}`.
    const attemptSpan = ctx.span?.child(
      'gateway.upstream',
      {
        'gateway.provider': candidate.provider.slug,
        'gateway.resolved_model': candidate.model.slug,
        'gateway.credential': candidate.credential.id,
        ...genAiRequestAttributes(api, canonical),
        'gen_ai.request.model': candidate.model.upstreamModel,
        'gen_ai.provider.name': genAiProviderName(candidate.provider.type),
        ...serverAttributes(candidate.provider.baseUrl),
      },
      `${genAiOperation(api)} ${candidate.model.upstreamModel}`,
    );
    const attemptStarted = Date.now();
    try {
      const result = await attemptOnce(candidate, signal, attemptSpan?.traceparent, claim);
      if (ctx.explanation)
        tried.push({
          modelId: candidate.model.id,
          providerId: candidate.provider.id,
          credentialId: candidate.credential.id,
          outcome: result.ok ? 'success' : 'error',
          ...(!result.ok && result.error.status !== undefined
            ? { status: result.error.status }
            : {}),
          ...(!result.ok ? { errorClass: result.error.class } : {}),
          latencyMs: Date.now() - attemptStarted,
        });
      attemptSpan?.end(
        result.ok ? 'ok' : 'error',
        result.ok
          ? result.value.kind === 'json'
            ? genAiResponseAttributes(result.value.response, result.value.response.usage)
            : genAiResponseAttributes(
                result.value.result.assembled,
                result.value.result.usage,
                candidate.model.upstreamModel,
              )
          : { 'gateway.error_class': result.error.class },
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
    const proxyUrl =
      candidate.credential.proxy?.url ?? candidate.provider.proxy?.url ?? settings.proxy?.url;
    try {
      apiKey = await resolveCredentialKey(candidate.provider, candidate.credential, apiKey, {
        signal,
        proxyUrl,
      });
    } catch (error) {
      deps.logger.warn(
        {
          requestId,
          provider: candidate.provider.slug,
          credential: candidate.credential.id,
          error: (error as Error).message,
        },
        'credential token refresh failed',
      );
      return { ok: false, error: tokenFailure(error) };
    }
    let up;
    try {
      // Model and alias policy (epic 31); a refused parameter is a 400 like refused content.
      const shaped = shapeForCandidate(
        canonical,
        candidate,
        aliasPolicy,
        deps,
        requestId,
        dropParams,
      );
      if (shaped.paramsHeader) void reply.header(PARAMS_HEADER, shaped.paramsHeader);
      up = adapter.buildRequest({
        provider: candidate.provider,
        model: candidate.model,
        apiKey,
        request: shaped.request,
        credentialHeaders: candidate.credential.headers,
        clientHeaders: {
          'anthropic-beta':
            typeof req.headers['anthropic-beta'] === 'string'
              ? req.headers['anthropic-beta']
              : undefined,
        },
        onDrop: dropReporterFor(candidate, dropParams, deps, requestId),
      });
    } catch (error) {
      // Content this provider cannot carry (card 27.2): a clear 400, never a silent drop.
      if (error instanceof UnsupportedContentError)
        return {
          ok: false,
          error: classified('bad_request', { status: 400, message: error.message }),
        };
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
        proxyUrl,
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
        const parsed = repairAnswer(
          adapter.parseResponse(json, candidate.model.upstreamModel),
          canonical,
          repairKinds,
          deps,
          requestId,
        );
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
          judge: (policies, text) => externalVerdicts(req, deps, policies, 'response', text),
          onGuardrails: (result) => {
            reportGuardrails(deps, requestId, 'response', result);
          },
          ...(claim ? { claim } : {}),
          ...(ctx.explanation ? { extraHeaders: () => explainHeaders(candidate) } : {}),
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
    // GenAI client metrics (card 24.3): every upstream call, with tokens on the one that answered.
    const answered =
      result.ok && item.outcome === 'success' && item.modelId === result.candidate.model.id;
    const usage = answered
      ? result.value.kind === 'json'
        ? result.value.response.usage
        : result.value.result.usage
      : undefined;
    deps.metrics?.observeGenAi({
      operation: genAiOperation(api),
      provider: provider ? genAiProviderName(provider.type) : item.providerId,
      requestModel: model?.upstreamModel ?? item.modelId,
      responseModel:
        answered && result.value.kind === 'json' ? result.value.response.model : undefined,
      durationMs: item.latencyMs,
      errorType: item.outcome === 'success' ? undefined : (item.errorClass ?? item.outcome),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });
  }

  // The explanation with every attempt (card 32.7), for JSON answers and errors; a stream already
  // sent its own when it started.
  if (ctx.explanation && !reply.raw.headersSent)
    void reply.header(
      EXPLAIN_HEADER,
      encodeExplanation(withAttempts(ctx.explanation, result.attempts)),
    );

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
      ctx.capture?.setFinishReason(outcome.response.finishReason);
      // Response guardrails (stage=response) run on the canonical answer before it is encoded.
      const policies = policiesFor(config.snapshot.guardrails, key);
      const guard = policies.length
        ? evaluateGuardrails(policies, {
            stage: 'response',
            response: outcome.response,
            external: await externalVerdicts(
              req,
              deps,
              policies,
              'response',
              guardrailText({ stage: 'response', response: outcome.response }),
            ),
          })
        : undefined;
      if (guard) reportGuardrails(deps, requestId, 'response', guard);
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
        reply
          .status(200)
          .send(encodeResponse(api, outcome.response, canonical.model, canonical.tools));
        ctx.finishSpan('ok', {
          'gateway.provider': result.candidate.provider.slug,
          'gateway.resolved_model': result.candidate.model.slug,
          'gateway.attempts': result.attempts.length,
          'gen_ai.provider.name': genAiProviderName(result.candidate.provider.type),
          'gen_ai.response.model': outcome.response.model,
          'gen_ai.response.finish_reasons': [outcome.response.finishReason],
        });
      }
    } else {
      // A cleanly finished stream populates the exact cache too, so agent clients (which always
      // stream) get hits; the entry is replayed in whichever format the next client uses.
      const streamCache = config.snapshot.settings.cache;
      if (outcome.result.conversation) rememberResponse(outcome.result.conversation);
      // The streamed answer is stored as the one JSON answer it adds up to (card 24.1).
      const assembled = outcome.result.assembled;
      if (assembled)
        ctx.capture?.setResponse(encodeResponse(api, assembled, canonical.model, canonical.tools), {
          streamed: true,
          finishReason: assembled.finishReason,
        });
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
        'gen_ai.provider.name': genAiProviderName(result.candidate.provider.type),
        'gen_ai.response.model': assembled?.model ?? result.candidate.model.upstreamModel,
        ...(assembled ? { 'gen_ai.response.finish_reasons': [assembled.finishReason] } : {}),
      });
    }
    // Routing statistics (cards 12.1 and 12.4): EWMA latency, recent volume and session pinning.
    config.router.stats.recordRequest(result.candidate.model.id);
    config.router.stats.recordLatency(
      result.candidate.model.id,
      outcome.kind === 'json' ? Date.now() - started : outcome.result.ttftMs,
    );
    // Live generation speed per model and provider (card 32.1): output tokens over the time spent
    // generating them (after the first token for a stream).
    const answered = result.attempts.findLast((a) => a.outcome === 'success');
    config.router.stats.recordThroughput(
      result.candidate.model.id,
      outcome.kind === 'json'
        ? outcome.response.usage.outputTokens
        : outcome.result.usage.outputTokens,
      outcome.kind === 'json'
        ? (answered?.latencyMs ?? Date.now() - started)
        : Date.now() - started - outcome.result.ttftMs,
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
    ...(ctx.policy ? { policy: ctx.policy } : {}),
    ...(ctx.routeDecision ? { routeDecision: ctx.routeDecision } : {}),
    // The tier the provider says it used, else the one requested (streams, card 31.5).
    serviceTier:
      (result.ok && result.value.kind === 'json' ? result.value.response.serviceTier : undefined) ??
      canonical.serviceTier,
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
    /** Headers added when the stream starts (the routing explanation, card 32.7). */
    extraHeaders?: () => Record<string, string>;
    guardrails?: readonly GuardrailPolicy[];
    /** Makes the model calls of moderation and classifier policies on the held answer. */
    judge?: (
      policies: readonly GuardrailPolicy[],
      text: string,
    ) => Promise<ReadonlyMap<string, ExternalVerdict>>;
    /** Called once the stream ends with the response guardrail hits and unknown policies. */
    onGuardrails?: (result: {
      hits: readonly GuardrailHit[];
      unknown: readonly GuardrailPolicy[];
    }) => void;
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
      ...opts.extraHeaders?.(),
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
  const releaseHeld = async (final = false) => {
    if (!streamGuard.active) return;
    const pending = streamGuard.pendingJudgement(final);
    if (pending && opts.judge)
      streamGuard.setVerdicts(await opts.judge(pending.policies, pending.text));
    const tail = streamGuard.finish(final);
    if (tail.blocked) await blockStream(tail.blocked);
    if (tail.text === '') return;
    if (!state.committed) commit();
    await write(encoder.push({ type: 'text_delta', index: lastTextIndex, text: tail.text }));
  };
  // A blocking policy that judges the whole answer (json_schema, moderation, a classifier):
  // every event is held, not only text, and replayed in order once the full answer passed.
  // Releasing anything earlier would let text in a later block (Anthropic citations, text after a
  // tool call) reach the client without the verdict.
  const holdWhole = streamGuard.holdsWholeAnswer;
  const held: CanonicalStreamEvent[] = [];
  let heldChars = 0;
  const emit = async (ev: CanonicalStreamEvent) => {
    if (!state.committed) commit();
    collect(ev);
    await write(encoder.push(ev));
  };
  const replayHeld = async () => {
    const text = held.map((ev) => (ev.type === 'text_delta' ? ev.text : '')).join('');
    const external = streamGuard.externalPolicies;
    if (external.length > 0 && opts.judge && text.length <= MAX_HELD_ANSWER)
      streamGuard.setVerdicts(await opts.judge(external, text));
    const verdict = streamGuard.judgeWhole(text);
    if (verdict.blocked) await blockStream(verdict.blocked);
    for (let i = 0; i < held.length;) {
      const ev = held[i];
      if (!ev) break;
      if (ev.type !== 'text_delta') {
        await emit(ev);
        i++;
        continue;
      }
      // One text block at a time through the chunk policies (redaction, secrets).
      let block = '';
      let j = i;
      for (
        let next = held[j];
        next?.type === 'text_delta' && next.index === ev.index;
        next = held[++j]
      )
        block += next.text;
      const guarded = streamGuard.guardBlock(block);
      if (guarded.blocked) await blockStream(guarded.blocked);
      if (guarded.text !== '')
        await emit({ type: 'text_delta', index: ev.index, text: guarded.text });
      i = j;
    }
    held.length = 0;
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
    if (holdWhole) {
      // Headers and heartbeats go out at once so the client does not time out while it waits.
      if (!state.committed) commit();
      if (ev.type === 'text_delta') {
        heldChars += ev.text.length;
        if (heldChars > MAX_HELD_ANSWER)
          await blockStream(
            'Response blocked: the answer is too long to be checked by the guardrails',
          );
      }
      held.push(ev);
      return undefined;
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
    if (holdWhole) await replayHeld();
    else await releaseHeld(true);
    if (streamGuard.active)
      opts.onGuardrails?.({ hits: streamGuard.hits, unknown: streamGuard.unknown });
    if (!state.committed) commit();
    const usageEstimated = encoder.usage === undefined;
    const usage = encoder.usage ?? estimateUsage(canonical, output.join(''));
    if (usageEstimated) await write(encoder.push({ type: 'usage', usage }));
    await write(encoder.end());
    raw.end();
    const assembled = assembler.result(usage);
    return {
      ok: true,
      value: {
        kind: 'stream',
        result: {
          usage,
          usageEstimated,
          ttftMs: state.ttftMs,
          // Never cache text that a stream guardrail rewrote: a replay would skip that guardrail.
          ...(streamGuard.active ? {} : { response: assembled }),
          ...(api === 'openai.responses' ? { conversation: assembled } : {}),
          assembled,
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
    policy?: UsageEvent['policy'];
    routeDecision?: RouteDecision;
    serviceTier?: string | undefined;
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
    // Flex and priority requests are priced at the tier's rates (card 31.5).
    const tier =
      e.serviceTier === 'flex' || e.serviceTier === 'priority' ? e.serviceTier : undefined;
    const priced = e.candidate
      ? { ...e.candidate.model, pricing: pricingForServiceTier(e.candidate.model.pricing, tier) }
      : undefined;
    const costUsd =
      priced && e.ok && e.cacheHit !== true ? computeCostUsd(usage, priced.pricing) : '0';
    // Sale price (card 19.4): what the customer pays for this request.
    const charge =
      priced && e.ok
        ? chargeUsd(usage, priced, {
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
      ...(e.policy ? { policy: e.policy } : {}),
      ...(e.routeDecision ? { routeDecision: e.routeDecision } : {}),
      ...(tier && e.cacheHit !== true ? { serviceTier: tier } : {}),
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
