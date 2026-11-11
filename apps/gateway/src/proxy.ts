/**
 * مسیر داغ: /v1/chat/completions و /v1/messages (کارت ۴.۹).
 * auth → اعتبارسنجی → canonical → resolve → retry/فال‌بک → ترجمهٔ پاسخ → رویداد مصرف.
 */
import {
  AnthropicMessagesRequest,
  type CanonicalRequest,
  type CanonicalResponse,
  type CanonicalStreamEvent,
  type CanonicalUsage,
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
  adapterFor,
  classified,
  classifyNetworkError,
} from '@dirouter/providers';
import {
  type AttemptResult,
  type BulkheadRegistry,
  type Candidate,
  executeWithFallback,
  isRouteError,
  type ResolvedRoute,
  type RetryBudget,
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
  OpenAIStreamEncoder,
  SSE_HEARTBEAT,
  SseParser,
  anthropicRequestToCanonical,
  canonicalToAnthropicResponse,
  canonicalToOpenAIResponse,
  openAIRequestToCanonical,
} from '@dirouter/translator';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { authenticate, extractApiKey } from './auth.js';
import type { ConfigStore, LoadedConfig } from './config-store.js';
import type { GatewayMetrics } from './metrics.js';
import type { BudgetGuard, ScopedBudget } from './budget-guard.js';
import type { LimitScope, RateLimiter } from './rate-limiter.js';
import { callUpstream, mergeTimeouts, readErrorBody, UpstreamTimeout } from './upstream.js';

export interface ProxyDeps {
  store: ConfigStore;
  budget: RetryBudget;
  /** سقف همزمانی هر provider و هر کلید (کارت ۵.۷). */
  bulkheads?: BulkheadRegistry;
  /** بودجهٔ کلید، پروژه و تیم (کارت ۶.۳). */
  budgets?: BudgetGuard;
  /** rate limiter توزیع‌شده (کارت ۶.۱). */
  limiter?: RateLimiter;
  /** وضعیت خاموشی (کارت ۵.۸): در drain، اتصال‌ها بعد از پاسخ بسته می‌شوند. */
  lifecycle?: { readonly draining: boolean; readonly signal: AbortSignal };
  pepper: string;
  logger: Logger;
  instance: string;
  /** مقصد رویداد مصرف (صف یا outbox)؛ هرگز await نمی‌شود. */
  emitUsage: (event: UsageEvent) => void;
  /** متریک‌های مسیر داغ؛ در تست‌های واحد قابل حذف است. */
  metrics?: GatewayMetrics;
  /** لاگ پایان هر درخواست، حتی رد پیش از usage event. */
  onRequestComplete?: (event: UsageEvent) => void;
  heartbeatMs?: number;
}

interface StreamOutcome {
  usage: CanonicalUsage;
  /** provider usage نداد و مقدار با tokenizer تخمین زده شد. */
  usageEstimated: boolean;
  ttftMs: number;
}

type Outcome =
  | {
      kind: 'json';
      response: CanonicalResponse & { usage: CanonicalUsage };
      usageEstimated: boolean;
    }
  | { kind: 'stream'; result: StreamOutcome };

function toClientError(error: ClassifiedError | undefined, reason: string): DiRouterError {
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
    // پیام خطای شبکه ممکن است آدرس داخلی provider یا پروکسی را داشته باشد؛ کلاینت فقط
    // متن عمومی می‌گیرد و جزئیات (با رمز ماسک‌شده) فقط در لاگ سرور است.
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
  void reply
    .status(error.status)
    .send(api === 'openai.chat' ? error.toOpenAI() : error.toAnthropic(requestId));
}

function parseInbound(api: InboundApi, body: unknown, logger: Logger): CanonicalRequest {
  const schema = api === 'openai.chat' ? OpenAIChatCompletionRequest : AnthropicMessagesRequest;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.map(String).join('.') || '(body)', message: i.message })),
    );
  }
  const onDrop = (field: string, reason: string) => {
    logger.debug({ field, reason }, 'field dropped in translation');
  };
  return api === 'openai.chat'
    ? openAIRequestToCanonical(parsed.data as OpenAIChatCompletionRequest, { onDrop })
    : anthropicRequestToCanonical(parsed.data as AnthropicMessagesRequest, { onDrop });
}

/**
 * `POST /v1/messages/count_tokens` (سازگار با Anthropic، کارت ۴.۹): تخمین محلی با tokenizer
 * و بدون فراخوانی upstream. Claude Code و SDK برای مدیریت context از آن استفاده می‌کنند.
 */
export function handleCountTokens(req: FastifyRequest, reply: FastifyReply, deps: ProxyDeps): void {
  const api: InboundApi = 'anthropic.messages';
  const config = deps.store.current;
  if (!config) {
    sendError(reply, api, new DiRouterError('service_unavailable'), req.id);
    return;
  }
  try {
    const key = authenticate(config, extractApiKey(req.headers), deps.pepper, req.ip);
    // count_tokens بدنهٔ messages بدون max_tokens است.
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
  // درخواست‌های ردشده پیش از usage event هم شمارش می‌شوند. درخواست موفق/ناموفق
  // upstream در runRoute ثبت می‌شود؛ finally برای خروج‌های غیرمنتظره تضمین است.
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
    key = authenticate(config, extractApiKey(req.headers), deps.pepper, req.ip);
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

  const estimatedInputTokens = estimateRequestTokens(canonical, roughTokens);
  model = canonical.model;
  const route = config.router.resolve(key, canonical.model, {
    estimatedInputTokens,
    ...(canonical.maxOutputTokens !== undefined
      ? { maxOutputTokens: canonical.maxOutputTokens }
      : {}),
  });
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
    observeEarly(reply.statusCode);
    return;
  }

  // قطع کلاینت → abort همهٔ تلاش‌ها و upstream.
  const clientGone = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) clientGone.abort(new Error('client disconnected'));
  });
  // پایان مهلت drain: درخواست‌های باقی‌مانده مثل قطع کلاینت لغو می‌شوند.
  const onShutdown = () => {
    clientGone.abort(new Error('gateway shutting down'));
  };
  deps.lifecycle?.signal.addEventListener('abort', onShutdown, { once: true });
  reply.raw.once('close', () => deps.lifecycle?.signal.removeEventListener('abort', onShutdown));

  // rate limit توزیع‌شده (کارت ۶.۱): کلید، پروژه و تیم. رزرو TPM = ورودی + سقف خروجی.
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
    observeEarly(reply.statusCode);
    return;
  }
  if (admission)
    for (const [name, value] of Object.entries(admission.headers)) void reply.header(name, value);

  // بودجه: رسیده به سقف یعنی 429 budget_exceeded تا شروع دورهٔ بعد.
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
    observeEarly(reply.statusCode);
    return;
  }

  const queue = config.snapshot.settings.bulkhead;
  const queueOverrides = {
    ...(queue?.queueSize !== undefined ? { queueSize: queue.queueSize } : {}),
    ...(queue?.queueTimeoutMs !== undefined ? { queueTimeoutMs: queue.queueTimeoutMs } : {}),
  };
  // سقف همزمانی کلید: پر بودن یعنی 429 فوری (بعد از صف کوتاه)، بدون تماس با upstream.
  const keyBulkhead = deps.bulkheads?.get(
    `key:${key.id}`,
    key.rateLimit?.maxConcurrency,
    queueOverrides,
  );
  const releaseKey = keyBulkhead ? await keyBulkhead.acquire(clientGone.signal) : () => undefined;
  if (!releaseKey) {
    admission?.settle(0);
    admission?.release();
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
  let spent = { tokens: 0, costUsd: '0' };
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
      },
    );
  } finally {
    if (canonical.stream) deps.metrics?.streamEnded();
    observeEarly(reply.raw.headersSent ? 200 : reply.statusCode);
    releaseKey();
    admission?.settle(spent.tokens);
    admission?.release();
    deps.budgets?.record(budgets, spent.costUsd, spent.tokens);
  }
}

/** بودجه‌های یک کلید: خودش، پروژه و تیمش (کارت ۶.۳). */
function budgetScopes(config: LoadedConfig, key: VirtualKeyConfig): ScopedBudget[] {
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

/** scopeهای limit یک کلید: خودش، پروژه و تیمش. */
function limitScopes(config: LoadedConfig, key: VirtualKeyConfig): LimitScope[] {
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
  },
): Promise<{ tokens: number; costUsd: string }> {
  const { config, key, canonical, route, requestId, started, clientGone } = ctx;

  const settings = config.snapshot.settings;
  const retry = route.combo?.retry ?? settings.defaultRetry;
  const baseTimeouts = mergeTimeouts(settings.defaultTimeouts, route.combo?.timeouts);
  const includeUsage =
    api === 'anthropic.messages' ||
    (req.body as { stream_options?: { include_usage?: boolean } } | undefined)?.stream_options
      ?.include_usage === true;

  const attempt = async (
    candidate: Candidate,
    signal: AbortSignal,
  ): Promise<AttemptResult<Outcome>> => {
    const adapter = adapterFor(candidate.provider.type);
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
    const up = adapter.buildRequest({
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

    let call;
    try {
      call = await callUpstream(
        candidate.provider,
        up,
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
        // بدون usage از provider: تخمین با tokenizer تا هم کلاینت و هم رویداد مصرف عدد بگیرند.
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

  const result = await executeWithFallback(route.candidates, attempt, {
    retry,
    fallbackOn: route.fallbackOn,
    deadline: started + baseTimeouts.totalMs,
    budget: deps.budget,
    health: deps.store.healthRegistry,
    signal: clientGone.signal,
    ...(deps.bulkheads ? { admit: admitProvider(deps.bulkheads, ctx.queueOverrides) } : {}),
  });
  // هر تلاش provider/model خودش را دارد؛ attribution نهایی request از event می‌آید.
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

  const candidate = result.candidate;
  if (result.ok) {
    const outcome = result.value;
    void reply
      .header('x-dirouter-model', result.candidate.model.slug)
      .header('x-dirouter-provider', result.candidate.provider.slug)
      .header('x-dirouter-attempts', String(result.attempts.length));
    if (outcome.kind === 'json') {
      const body =
        api === 'openai.chat'
          ? canonicalToOpenAIResponse(outcome.response, { model: canonical.model })
          : canonicalToAnthropicResponse(outcome.response, { model: canonical.model });
      void reply.status(200).send(body);
    }
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

  // رویداد مصرف: هرگز در مسیر پاسخ منتظر نمی‌مانیم.
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
  const costUsd = emitUsageEvent(deps, config, {
    api,
    requestId,
    key,
    canonical,
    started,
    candidate,
    usage,
    usageEstimated,
    ok: result.ok,
    httpStatus: result.ok ? 200 : reply.statusCode,
    ttftMs: result.ok && result.value.kind === 'stream' ? result.value.result.ttftMs : undefined,
    errorCode: result.ok ? undefined : (result.error?.class ?? result.reason),
    attempts: result.attempts,
    metricProvider: resolvedProvider?.slug ?? candidate?.provider.slug,
    metricModel: resolvedModel?.slug ?? candidate?.model.slug,
  });
  return { tokens: usage ? usage.inputTokens + usage.outputTokens : 0, costUsd };
}

/** bulkhead هر provider: پر بودن یعنی رفتن به کاندیدای بعدی (یا 429 اگر کاندیدایی نماند). */
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
  decoder: ReturnType<ReturnType<typeof adapterFor>['createStreamDecoder']>,
  call: Awaited<ReturnType<typeof callUpstream>>,
  reply: FastifyReply,
  opts: {
    includeUsage: boolean;
    started: number;
    requestId: string;
    heartbeatMs: number;
    draining: () => boolean;
    shuttingDown: () => boolean;
  },
): Promise<AttemptResult<Outcome>> {
  const encoder =
    api === 'openai.chat'
      ? new OpenAIStreamEncoder({ model: canonical.model, includeUsage: opts.includeUsage })
      : new AnthropicStreamEncoder({ model: canonical.model });
  const parser = new SseParser();
  const raw = reply.raw;
  // در state نگه داشته می‌شود چون داخل closureِ commit تغییر می‌کند.
  const state = { committed: false, ttftMs: 0 };
  // متن خروجی برای تخمین usage وقتی upstream آن را نفرستد.
  const output: string[] = [];
  const collect = (ev: CanonicalStreamEvent) => {
    if (ev.type === 'text_delta') output.push(ev.text);
    else if (ev.type === 'reasoning_delta' && ev.text) output.push(ev.text);
    else if (ev.type === 'tool_call_start') output.push(ev.name, ' ');
    else if (ev.type === 'tool_call_delta') output.push(ev.argumentsDelta);
  };
  let heartbeat: NodeJS.Timeout | undefined;

  const write = async (text: string) => {
    if (text === '' || raw.destroyed) return;
    if (!raw.write(text)) await new Promise<void>((resolve) => raw.once('drain', resolve));
  };
  const commit = () => {
    state.committed = true;
    state.ttftMs = Date.now() - opts.started;
    reply.hijack();
    // هدرهای سراسری (x-request-id، x-dirouter-instance) هم در stream بمانند.
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

  try {
    const body = call.response.body;
    if (!body) throw new Error('empty upstream body');
    for await (const chunk of body) {
      call.touch();
      for (const event of parser.feed(chunk as Uint8Array)) {
        for (const ev of decoder.push(event)) {
          if (ev.type === 'error') {
            const classified: ClassifiedError = /overload/i.test(ev.code)
              ? { class: 'overloaded', retryable: true, fallbackAllowed: true, message: ev.message }
              : { class: 'server', retryable: true, fallbackAllowed: true, message: ev.message };
            if (!state.committed) return { ok: false, error: classified };
            await write(encoder.push(ev));
            throw new CommittedFailure(classified);
          }
          if (!state.committed) commit();
          collect(ev);
          await write(encoder.push(ev));
        }
      }
    }
    for (const event of parser.flush())
      for (const ev of decoder.push(event)) {
        if (!state.committed) commit();
        collect(ev);
        await write(encoder.push(ev));
      }
    if (!state.committed) commit();
    const usageEstimated = encoder.usage === undefined;
    const usage = encoder.usage ?? estimateUsage(canonical, output.join(''));
    if (usageEstimated) await write(encoder.push({ type: 'usage', usage }));
    await write(encoder.end());
    raw.end();
    return {
      ok: true,
      value: { kind: 'stream', result: { usage, usageEstimated, ttftMs: state.ttftMs } },
    };
  } catch (error) {
    if (error instanceof CommittedFailure) {
      raw.end();
      throw error;
    }
    if (state.committed) {
      // قطع upstream بعد از ارسال بایت: خطای استاندارد و پایان (فال‌بک ممکن نیست).
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
    key: { id: string; organizationId: string; teamId: string | null; projectId: string };
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
  },
): string {
  try {
    // درخواست ناموفق upstream توکنی مصرف نکرده (یا خبری از آن نداریم)؛ هزینه صفر.
    const usage: CanonicalUsage = e.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const costUsd = e.candidate && e.ok ? computeCostUsd(usage, e.candidate.model.pricing) : '0';
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
      usageEstimated: e.usageEstimated,
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
    return costUsd;
  } catch (error) {
    deps.logger.error({ err: error, requestId: e.requestId }, 'failed to build usage event');
    return '0';
  }
}
