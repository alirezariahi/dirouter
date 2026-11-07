/**
 * مسیر داغ: /v1/chat/completions و /v1/messages (کارت ۴.۹).
 * auth → اعتبارسنجی → canonical → resolve → retry/فال‌بک → ترجمهٔ پاسخ → رویداد مصرف.
 */
import {
  AnthropicMessagesRequest,
  type CanonicalRequest,
  type CanonicalResponse,
  type CanonicalUsage,
  type InboundApi,
  OpenAIChatCompletionRequest,
  USAGE_EVENT_SCHEMA_VERSION,
  type UsageEvent,
} from '@dirouter/contracts';
import { computeCostUsd, estimateRequestTokens, roughTokens } from '@dirouter/model-catalog';
import { type ClassifiedError, adapterFor, classifyNetworkError } from '@dirouter/providers';
import {
  type AttemptResult,
  type Candidate,
  executeWithFallback,
  isRouteError,
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
import { callUpstream, mergeTimeouts, readErrorBody, UpstreamTimeout } from './upstream.js';

export interface ProxyDeps {
  store: ConfigStore;
  budget: RetryBudget;
  pepper: string;
  logger: Logger;
  instance: string;
  /** مقصد رویداد مصرف (صف یا outbox)؛ هرگز await نمی‌شود. */
  emitUsage: (event: UsageEvent) => void;
  heartbeatMs?: number;
}

interface StreamOutcome {
  usage: CanonicalUsage | undefined;
  ttftMs: number;
}

type Outcome =
  { kind: 'json'; response: CanonicalResponse } | { kind: 'stream'; result: StreamOutcome };

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
    case 'timeout':
      return new UpstreamError('upstream_timeout', { message: error.message });
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

export async function handleProxy(
  api: InboundApi,
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  const requestId = req.id;
  const started = Date.now();
  const config = deps.store.current;
  if (!config) {
    sendError(
      reply,
      api,
      new DiRouterError('service_unavailable', { message: 'Gateway has no configuration yet' }),
      requestId,
    );
    return;
  }

  let canonical: CanonicalRequest;
  let key;
  try {
    key = authenticate(config, extractApiKey(req.headers), deps.pepper, req.ip);
    canonical = parseInbound(api, req.body, deps.logger);
  } catch (error) {
    sendError(
      reply,
      api,
      error instanceof DiRouterError ? error : new DiRouterError('invalid_request'),
      requestId,
    );
    return;
  }

  const route = config.router.resolve(key, canonical.model, {
    estimatedInputTokens: estimateRequestTokens(canonical, roughTokens),
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
          : new UpstreamError('no_available_provider');
    deps.logger.debug({ requestId, skipped: route.skipped }, 'route failed');
    sendError(reply, api, error, requestId);
    return;
  }

  // قطع کلاینت → abort همهٔ تلاش‌ها و upstream.
  const clientGone = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) clientGone.abort(new Error('client disconnected'));
  });

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
      call = await callUpstream(candidate.provider, up, timeouts, signal, canonical.stream);
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
        return { ok: true, value: { kind: 'json', response: adapter.parseResponse(json) } };
      }
      return await pipeStream(
        api,
        canonical,
        candidate,
        adapter.createStreamDecoder(),
        call,
        reply,
        { includeUsage, started, requestId, heartbeatMs: deps.heartbeatMs ?? 15_000 },
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
  });

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
  } else if (!reply.raw.headersSent && result.reason !== 'aborted') {
    sendError(reply, api, toClientError(result.error, result.reason), requestId);
  }

  // رویداد مصرف: هرگز در مسیر پاسخ منتظر نمی‌مانیم.
  const usage = result.ok
    ? result.value.kind === 'json'
      ? result.value.response.usage
      : result.value.result.usage
    : undefined;
  emitUsageEvent(deps, config, {
    api,
    requestId,
    key,
    canonical,
    started,
    candidate,
    usage,
    ok: result.ok,
    httpStatus: result.ok ? 200 : reply.statusCode,
    ttftMs: result.ok && result.value.kind === 'stream' ? result.value.result.ttftMs : undefined,
    errorCode: result.ok ? undefined : (result.error?.class ?? result.reason),
    attempts: result.attempts,
  });
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
  opts: { includeUsage: boolean; started: number; requestId: string; heartbeatMs: number },
): Promise<AttemptResult<Outcome>> {
  const encoder =
    api === 'openai.chat'
      ? new OpenAIStreamEncoder({ model: canonical.model, includeUsage: opts.includeUsage })
      : new AnthropicStreamEncoder({ model: canonical.model });
  const parser = new SseParser();
  const raw = reply.raw;
  // در state نگه داشته می‌شود چون داخل closureِ commit تغییر می‌کند.
  const state = { committed: false, ttftMs: 0 };
  let heartbeat: NodeJS.Timeout | undefined;

  const write = async (text: string) => {
    if (text === '' || raw.destroyed) return;
    if (!raw.write(text)) await new Promise<void>((resolve) => raw.once('drain', resolve));
  };
  const commit = () => {
    state.committed = true;
    state.ttftMs = Date.now() - opts.started;
    reply.hijack();
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
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
          await write(encoder.push(ev));
        }
      }
    }
    for (const event of parser.flush())
      for (const ev of decoder.push(event)) {
        if (!state.committed) commit();
        await write(encoder.push(ev));
      }
    if (!state.committed) commit();
    await write(encoder.end());
    raw.end();
    return {
      ok: true,
      value: { kind: 'stream', result: { usage: encoder.usage, ttftMs: state.ttftMs } },
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
          message: 'upstream stream interrupted',
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
    ok: boolean;
    httpStatus: number;
    ttftMs: number | undefined;
    errorCode: string | undefined;
    attempts: Awaited<ReturnType<typeof executeWithFallback>>['attempts'];
  },
): void {
  try {
    const estimated = e.usage === undefined && e.ok;
    const usage: CanonicalUsage = e.usage ?? {
      inputTokens: e.ok ? estimateRequestTokens(e.canonical, roughTokens) : 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const costUsd = e.candidate && e.ok ? computeCostUsd(usage, e.candidate.model.pricing) : '0';
    deps.emitUsage({
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
      usageEstimated: estimated,
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
    });
  } catch (error) {
    deps.logger.error({ err: error, requestId: e.requestId }, 'failed to build usage event');
  }
}
