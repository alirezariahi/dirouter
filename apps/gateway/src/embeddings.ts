/**
 * `/v1/embeddings` (card 11.4): OpenAI-compatible embeddings through the routing and fallback
 * pipeline. Gemini's `:embedContent` reuses the same core and only changes the response shape.
 */
import type { EmbeddingsRequest } from '@dirouter/contracts';
import { USAGE_EVENT_SCHEMA_VERSION, type UsageEvent } from '@dirouter/contracts';
import { computeCostUsd } from '@dirouter/model-catalog';
import { adapterFor, classifyNetworkError, maxEmbeddingBatch } from '@dirouter/providers';
import { type Candidate, executeWithFallback, isRouteError } from '@dirouter/routing';
import {
  DiRouterError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ulid,
  ValidationError,
} from '@dirouter/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { authenticate, extractApiKey } from './auth.js';
import { budgetScopes, limitScopes, type ProxyDeps, toClientError } from './proxy.js';
import { callUpstream, mergeTimeouts, readErrorBody, UpstreamTimeout } from './upstream.js';

interface EmbedOutcome {
  vectors: number[][];
  usage: { inputTokens: number };
  candidate: Candidate;
  estimated: boolean;
}

type EmbedResult =
  | { ok: true; value: EmbedOutcome; headers?: Record<string, string> }
  | { ok: false; error: DiRouterError; headers?: Record<string, string> };

function parseTexts(body: EmbeddingsRequest): string[] {
  if (typeof body.input === 'string') return [body.input];
  if (body.input.every((x): x is string => typeof x === 'string')) return body.input;
  throw new ValidationError([
    {
      path: 'input',
      message: 'token-array embeddings input is not supported; send text or an array of texts',
    },
  ]);
}

async function embed(
  req: FastifyRequest,
  deps: ProxyDeps,
  input: { model: string; texts: string[]; dimensions?: number },
): Promise<EmbedResult> {
  const requestId = req.id;
  const started = Date.now();
  const config = deps.store.current;
  if (!config)
    return {
      ok: false,
      error: new DiRouterError('service_unavailable', {
        message: 'Gateway has no configuration yet',
      }),
    };

  let key;
  try {
    key = authenticate(
      config,
      extractApiKey(req.headers, (req.query as { key?: string } | undefined)?.key),
      deps.pepper,
      req.ip,
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof DiRouterError ? error : new DiRouterError('unauthenticated'),
    };
  }

  const estimatedInputTokens = input.texts.reduce(
    (sum, text) => sum + Math.ceil(text.length / 4),
    0,
  );
  const route = config.router.resolve(key, input.model, { estimatedInputTokens });
  if (isRouteError(route))
    return {
      ok: false,
      error:
        route.error === 'model_not_found'
          ? new NotFoundError('model_not_found', {
              message: `Model '${input.model}' not found`,
              param: 'model',
            })
          : route.error === 'model_not_allowed'
            ? new ForbiddenError('model_not_allowed', { param: 'model' })
            : new DiRouterError('service_unavailable', {
                message: 'No provider can serve this embedding model',
              }),
    };

  // Each provider caps the number of inputs per call. Targets that cannot take this batch are
  // skipped; when none can, the client gets a clear 400 instead of an upstream error.
  const fits = route.candidates.filter(
    (c) => input.texts.length <= maxEmbeddingBatch(c.provider, c.model.upstreamModel),
  );
  if (fits.length === 0) {
    const largest = Math.max(
      ...route.candidates.map((c) => maxEmbeddingBatch(c.provider, c.model.upstreamModel)),
    );
    return {
      ok: false,
      error: new DiRouterError('invalid_request', {
        message: `too many inputs (${String(input.texts.length)}); '${input.model}' accepts at most ${String(largest)} per request`,
        param: 'input',
        status: 400,
      }),
    };
  }

  // Embeddings are metered like chat requests: rate limit (RPM and TPM on the input estimate),
  // budgets and the key's concurrency cap all apply before any provider is called.
  const admission = deps.limiter
    ? await deps.limiter.acquire(limitScopes(config, key), estimatedInputTokens, requestId)
    : undefined;
  if (admission && !admission.ok) {
    deps.metrics?.reject('rate_limit', admission.unavailable ? 'unavailable' : admission.kind);
    return {
      ok: false,
      headers: admission.headers,
      error: new RateLimitError({
        message: admission.unavailable
          ? 'Rate limiter unavailable (fail-closed), retry shortly'
          : `Rate limit exceeded for ${admission.scope.split(':')[0] ?? 'key'} (${admission.kind})`,
        retryAfterMs: admission.retryAfterMs,
      }),
    };
  }
  const budgets = budgetScopes(config, key);
  const budgetCheck = deps.budgets ? await deps.budgets.check(budgets) : { ok: true as const };
  if (!budgetCheck.ok) {
    admission?.settle(0);
    admission?.release();
    deps.metrics?.reject('budget', budgetCheck.unavailable ? 'unavailable' : budgetCheck.kind);
    const what =
      budgetCheck.kind === 'usd' ? `USD ${budgetCheck.limit}` : `${budgetCheck.limit} tokens`;
    return {
      ok: false,
      headers: {
        'retry-after': String(
          Math.max(1, Math.ceil((budgetCheck.resetAt.getTime() - Date.now()) / 1000)),
        ),
      },
      error: new DiRouterError('budget_exceeded', {
        message: budgetCheck.unavailable
          ? 'Budget check unavailable (fail-closed), retry shortly'
          : `${budgetCheck.period === 'daily' ? 'Daily' : 'Monthly'} ${budgetCheck.scope} budget exceeded (${what})`,
      }),
    };
  }

  // Client disconnect or drain deadline: stop the upstream call instead of paying for it.
  const clientGone = new AbortController();
  req.raw.socket.once('close', () => {
    if (!req.raw.socket.writableFinished) clientGone.abort(new Error('client disconnected'));
  });
  const onShutdown = () => {
    clientGone.abort(new Error('gateway shutting down'));
  };
  deps.lifecycle?.signal.addEventListener('abort', onShutdown, { once: true });

  const keyBulkhead = deps.bulkheads?.get(`key:${key.id}`, key.rateLimit?.maxConcurrency, {});
  const releaseKey = keyBulkhead ? await keyBulkhead.acquire(clientGone.signal) : () => undefined;
  if (!releaseKey) {
    admission?.settle(0);
    admission?.release();
    deps.lifecycle?.signal.removeEventListener('abort', onShutdown);
    deps.metrics?.reject('concurrency', 'key');
    return {
      ok: false,
      error: new RateLimitError({
        message: `Too many concurrent requests for this key (limit ${String(keyBulkhead?.limit)})`,
        retryAfterMs: 1_000,
      }),
    };
  }

  const settings = config.snapshot.settings;
  const timeouts = mergeTimeouts(settings.defaultTimeouts, undefined);
  const attempt = async (candidate: Candidate, signal: AbortSignal) => {
    const adapter = adapterFor(candidate.provider.type);
    if (!adapter.buildEmbeddingsRequest || !adapter.parseEmbeddingsResponse)
      return {
        ok: false as const,
        error: {
          class: 'bad_request' as const,
          retryable: false,
          fallbackAllowed: true,
          message: `provider ${candidate.provider.slug} does not support embeddings`,
        },
      };
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
    const upstream = adapter.buildEmbeddingsRequest({
      provider: candidate.provider,
      model: candidate.model,
      apiKey,
      texts: input.texts,
      ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
      encodingFormat: 'float',
      credentialHeaders: candidate.credential.headers,
    });
    try {
      const call = await callUpstream(
        candidate.provider,
        upstream,
        timeouts,
        signal,
        false,
        candidate.credential.proxy?.url ?? candidate.provider.proxy?.url ?? settings.proxy?.url,
      );
      try {
        if (!call.response.ok)
          return {
            ok: false as const,
            error: adapter.classifyError({
              status: call.response.status,
              headers: call.response.headers,
              body: await readErrorBody(call.response),
            }),
          };
        const json: unknown = await call.response.json();
        return { ok: true as const, value: adapter.parseEmbeddingsResponse(json) };
      } finally {
        call.done();
      }
    } catch (error) {
      return {
        ok: false as const,
        error: classifyNetworkError(error, error instanceof UpstreamTimeout),
      };
    }
  };

  let spent = { tokens: 0, costUsd: '0' };
  try {
    const result = await executeWithFallback(fits, attempt, {
      retry: settings.defaultRetry,
      fallbackOn: route.fallbackOn,
      deadline: started + timeouts.totalMs,
      budget: deps.budget,
      health: deps.store.healthRegistry,
      signal: clientGone.signal,
    });

    const usage = {
      inputTokens: result.ok ? (result.value.usage?.inputTokens ?? estimatedInputTokens) : 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const failure = result.ok ? undefined : toClientError(result.error, result.reason);
    const costUsd = result.ok ? computeCostUsd(usage, result.candidate.model.pricing) : '0';
    spent = { tokens: usage.inputTokens, costUsd };
    const event: UsageEvent = {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: ulid(),
      idempotencyKey: requestId,
      requestId,
      occurredAt: new Date(started).toISOString(),
      gatewayInstance: deps.instance,
      configVersion: config.version,
      organizationId: key.organizationId,
      teamId: key.teamId,
      projectId: key.projectId,
      virtualKeyId: key.id,
      inboundApi: 'openai.embeddings',
      requestedModel: input.model,
      resolvedModelId: result.candidate?.model.id ?? null,
      providerId: result.candidate?.provider.id ?? null,
      credentialId: result.candidate?.credential.id ?? null,
      stream: false,
      status: result.ok ? 'success' : 'error',
      httpStatus: failure ? failure.status : 200,
      ...(result.ok ? {} : { errorCode: result.error?.class ?? result.reason }),
      usage,
      costUsd,
      usageEstimated: result.ok && result.value.usage === undefined,
      latencyMs: Date.now() - started,
      attempts: result.attempts
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
    deps.metrics?.observe(event);
    deps.onRequestComplete?.(event);
    deps.emitUsage(event);

    if (!result.ok || failure) {
      deps.logger.warn(
        { requestId, reason: result.ok ? undefined : result.reason, error: failure?.message },
        'embedding request failed upstream',
      );
      return {
        ok: false,
        error:
          failure ??
          new DiRouterError('service_unavailable', { message: 'Embedding request failed' }),
      };
    }
    return {
      ok: true,
      ...(admission ? { headers: admission.headers } : {}),
      value: {
        vectors: result.value.vectors,
        usage: { inputTokens: usage.inputTokens },
        candidate: result.candidate,
        estimated: result.value.usage === undefined,
      },
    };
  } finally {
    deps.lifecycle?.signal.removeEventListener('abort', onShutdown);
    releaseKey();
    admission?.settle(spent.tokens);
    admission?.release();
    deps.budgets?.record(budgets, spent.costUsd, spent.tokens);
  }
}

/** OpenAI's base64 embedding format: little-endian float32 values, base64-encoded. */
export function encodeEmbeddingBase64(vector: readonly number[]): string {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString('base64');
}

export async function handleEmbeddings(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  let body: EmbeddingsRequest;
  let texts: string[];
  try {
    // The body is client input: nothing about its shape is known until it is checked.
    const parsed = (req.body ?? {}) as Partial<EmbeddingsRequest>;
    if (typeof parsed.model !== 'string' || parsed.input === undefined)
      throw new ValidationError([{ path: 'model', message: 'model and input are required' }]);
    body = parsed as EmbeddingsRequest;
    texts = parseTexts(body);
  } catch (error) {
    const e = error instanceof DiRouterError ? error : new DiRouterError('invalid_request');
    reply.status(e.status).send(e.toOpenAI());
    return;
  }

  const result = await embed(req, deps, {
    model: body.model,
    texts,
    ...(body.dimensions !== undefined ? { dimensions: body.dimensions } : {}),
  });
  for (const [name, value] of Object.entries(result.headers ?? {})) void reply.header(name, value);
  if (!result.ok) {
    reply.status(result.error.status).send(result.error.toOpenAI());
    return;
  }
  void reply
    .header('x-dirouter-model', result.value.candidate.model.slug)
    .header('x-dirouter-provider', result.value.candidate.provider.slug);
  // The official OpenAI SDKs ask for base64 by default and decode it client-side. Upstreams are
  // always called with floats (not every provider supports base64), and the gateway encodes.
  const base64 = body.encoding_format === 'base64';
  reply.status(200).send({
    object: 'list',
    data: result.value.vectors.map((embedding, index) => ({
      object: 'embedding',
      index,
      embedding: base64 ? encodeEmbeddingBase64(embedding) : embedding,
    })),
    model: body.model,
    usage: {
      prompt_tokens: result.value.usage.inputTokens,
      total_tokens: result.value.usage.inputTokens,
    },
  });
}

/** Gemini `:embedContent` / `:batchEmbedContents` → Google's response shape, same pipeline. */
export async function handleGeminiEmbeddings(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  const param = (req.params as { modelAction?: string }).modelAction ?? '';
  const [model = '', action = 'embedContent'] = param.split(':');
  const body = (req.body ?? {}) as {
    content?: { parts?: { text?: string }[] };
    requests?: { content?: { parts?: { text?: string }[] } }[];
  };
  const textOf = (parts?: { text?: string }[]) => (parts ?? []).map((p) => p.text ?? '').join('\n');
  const texts =
    action === 'batchEmbedContents'
      ? (body.requests ?? []).map((r) => textOf(r.content?.parts))
      : [textOf(body.content?.parts)];

  if (texts.length === 0 || texts.every((text) => text === '')) {
    reply.status(400).send({
      error: {
        code: 400,
        message: 'content with text parts is required',
        status: 'INVALID_ARGUMENT',
      },
    });
    return;
  }
  const result = await embed(req, deps, { model, texts });
  for (const [name, value] of Object.entries(result.headers ?? {})) void reply.header(name, value);
  if (!result.ok) {
    const status = result.error.status;
    reply.status(status).send({
      error: {
        code: status,
        message: result.error.message,
        status:
          status === 429
            ? 'RESOURCE_EXHAUSTED'
            : status === 401
              ? 'UNAUTHENTICATED'
              : status === 403
                ? 'PERMISSION_DENIED'
                : status === 404
                  ? 'NOT_FOUND'
                  : status >= 500
                    ? 'UNAVAILABLE'
                    : 'INVALID_ARGUMENT',
      },
    });
    return;
  }
  void reply.header('x-dirouter-model', result.value.candidate.model.slug);
  reply
    .status(200)
    .send(
      action === 'batchEmbedContents'
        ? { embeddings: result.value.vectors.map((values) => ({ values })) }
        : { embedding: { values: result.value.vectors[0] ?? [] } },
    );
}
