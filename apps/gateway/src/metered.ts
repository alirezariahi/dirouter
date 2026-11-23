/**
 * The request pipeline shared by non-chat endpoints: embeddings (card 11.4) and media (card 21.1).
 *
 * Authentication, routing, rate limits, budgets, the prepaid wallet, the key's concurrency cap,
 * retries with fallback and the usage event all work as for chat. Each endpoint only says how to
 * build the upstream request for a candidate, how to read its response and what it consumed.
 */
import type { CanonicalUsage, InboundApi, MediaUsage, UsageEvent } from '@dirouter/contracts';
import { USAGE_EVENT_SCHEMA_VERSION } from '@dirouter/contracts';
import { computeCostUsd } from '@dirouter/model-catalog';
import {
  adapterForProvider,
  classifyNetworkError,
  type UpstreamRequest,
} from '@dirouter/providers';
import { type Candidate, executeWithFallback, isRouteError } from '@dirouter/routing';
import {
  DiRouterError,
  ForbiddenError,
  formatUsd,
  NotFoundError,
  RateLimitError,
  ulid,
} from '@dirouter/shared';
import type { FastifyRequest } from 'fastify';

import { authenticate, extractApiKey } from './auth.js';
import { chargeUnits, chargeUsd } from './pricing.js';
import { budgetScopes, limitScopes, type ProxyDeps, toClientError } from './proxy.js';
import { callUpstream, mergeTimeouts, readErrorBody, UpstreamTimeout } from './upstream.js';

type UpstreamResponse = Awaited<ReturnType<typeof callUpstream>>['response'];

/** What a successful request consumed; priced with the model's token and media prices. */
export interface Metering {
  usage: Partial<CanonicalUsage>;
  media?: MediaUsage;
  /** The provider reported no usage; it was estimated. */
  estimated: boolean;
}

export interface MeteredRequest<T> {
  inboundApi: InboundApi;
  model: string;
  /** Rate limit (TPM) and wallet estimate. */
  estimatedInputTokens: number;
  /** The most a request may consume, for the wallet reservation. */
  worstCase: Metering;
  /**
   * Narrows the routed candidates to those that can serve the request, or explains why none can
   * (returned to the client as is).
   */
  select(candidates: Candidate[]): Candidate[] | DiRouterError;
  /** The upstream request for a candidate, or undefined when its provider cannot serve it. */
  build(candidate: Candidate, apiKey: string): UpstreamRequest | undefined;
  read(response: UpstreamResponse, candidate: Candidate): Promise<T>;
  meter(value: T, candidate: Candidate): Metering;
}

export type MeteredResult<T> =
  | {
      ok: true;
      value: T;
      candidate: Candidate;
      metering: Metering;
      headers?: Record<string, string>;
    }
  | { ok: false; error: DiRouterError; headers?: Record<string, string> };

const fullUsage = (u: Partial<CanonicalUsage>): CanonicalUsage => ({
  inputTokens: u.inputTokens ?? 0,
  outputTokens: u.outputTokens ?? 0,
  cacheReadTokens: u.cacheReadTokens ?? 0,
  cacheWriteTokens: u.cacheWriteTokens ?? 0,
  reasoningTokens: u.reasoningTokens ?? 0,
});

/** The candidates whose model has a capability and whose provider type supports the service. */
export function capable(
  candidates: Candidate[],
  supports: (candidate: Candidate) => boolean,
  what: string,
  model: string,
): Candidate[] | DiRouterError {
  const fits = candidates.filter(supports);
  return fits.length > 0
    ? fits
    : new DiRouterError('invalid_request', {
        message: `'${model}' does not support ${what}`,
        param: 'model',
        status: 400,
      });
}

export async function runMetered<T>(
  req: FastifyRequest,
  deps: ProxyDeps,
  input: MeteredRequest<T>,
): Promise<MeteredResult<T>> {
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

  const route = config.router.resolve(key, input.model, {
    estimatedInputTokens: input.estimatedInputTokens,
  });
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
                message: `No provider can serve '${input.model}'`,
              }),
    };
  const candidates = input.select(route.candidates);
  if (candidates instanceof DiRouterError) return { ok: false, error: candidates };

  // Rate limit (RPM and TPM on the input estimate) and budgets apply before any provider is called.
  const admission = deps.limiter
    ? await deps.limiter.acquire(limitScopes(config, key), input.estimatedInputTokens, requestId)
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
  const releaseAdmission = () => {
    admission?.settle(0);
    admission?.release();
  };
  const budgets = budgetScopes(config, key);
  const budgetCheck = deps.budgets ? await deps.budgets.check(budgets) : { ok: true as const };
  if (!budgetCheck.ok) {
    releaseAdmission();
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

  // Prepaid wallet (card 19.1): reserve the worst case at the most expensive candidate's price.
  const walletId = key.walletId;
  if (walletId && deps.wallets) {
    let worst = 0n;
    for (const c of candidates) {
      const charge = chargeUnits(fullUsage(input.worstCase.usage), c.model, {
        groupMultiplier: key.priceMultiplier,
        media: input.worstCase.media,
      });
      if (charge > worst) worst = charge;
    }
    const reservation = await deps.wallets.reserve(walletId, requestId, formatUsd(worst));
    if (!reservation.ok) {
      releaseAdmission();
      deps.metrics?.reject('wallet', reservation.unavailable ? 'unavailable' : 'insufficient');
      return {
        ok: false,
        error: new DiRouterError('insufficient_credit', {
          message: reservation.unavailable
            ? 'Wallet check unavailable (fail-closed), retry shortly'
            : `Insufficient credit: this request may cost up to USD ${reservation.neededUsd}, available USD ${reservation.availableUsd}`,
        }),
      };
    }
  }
  let charged = '0.00000000';

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
    releaseAdmission();
    if (walletId) deps.wallets?.settle(walletId, requestId, charged);
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
    let upstream;
    try {
      upstream = input.build(candidate, apiKey);
    } catch (error) {
      // An adapter that cannot build the request is this target's fault: fall back.
      return {
        ok: false as const,
        error: {
          class: 'server' as const,
          retryable: false,
          fallbackAllowed: true,
          message: (error as Error).message,
        },
      };
    }
    if (!upstream)
      return {
        ok: false as const,
        error: {
          class: 'bad_request' as const,
          retryable: false,
          fallbackAllowed: true,
          message: `provider ${candidate.provider.slug} does not support this request`,
        },
      };
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
            error: adapterForProvider(candidate.provider).classifyError({
              status: call.response.status,
              headers: call.response.headers,
              body: await readErrorBody(call.response),
            }),
          };
        return { ok: true as const, value: await input.read(call.response, candidate) };
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
    const result = await executeWithFallback(candidates, attempt, {
      retry: settings.defaultRetry,
      fallbackOn: route.fallbackOn,
      deadline: started + timeouts.totalMs,
      budget: deps.budget,
      health: deps.store.healthRegistry,
      signal: clientGone.signal,
    });

    const metering: Metering = result.ok
      ? input.meter(result.value, result.candidate)
      : { usage: {}, estimated: false };
    const usage = fullUsage(metering.usage);
    const failure = result.ok ? undefined : toClientError(result.error, result.reason);
    const costUsd = result.ok
      ? computeCostUsd(usage, result.candidate.model.pricing, metering.media)
      : '0';
    if (result.ok)
      charged = chargeUsd(usage, result.candidate.model, {
        groupMultiplier: key.priceMultiplier,
        media: metering.media,
      });
    spent = { tokens: usage.inputTokens + usage.outputTokens, costUsd };
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
      ...(walletId ? { walletId } : {}),
      inboundApi: input.inboundApi,
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
      chargeUsd: charged,
      usageEstimated: result.ok && metering.estimated,
      ...(metering.media ? { media: metering.media } : {}),
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
        {
          requestId,
          api: input.inboundApi,
          reason: result.ok ? undefined : result.reason,
          error: failure?.message,
        },
        'request failed upstream',
      );
      return {
        ok: false,
        error: failure ?? new DiRouterError('service_unavailable', { message: 'Request failed' }),
      };
    }
    return {
      ok: true,
      value: result.value,
      candidate: result.candidate,
      metering,
      ...(admission ? { headers: admission.headers } : {}),
    };
  } finally {
    deps.lifecycle?.signal.removeEventListener('abort', onShutdown);
    releaseKey();
    if (walletId) deps.wallets?.settle(walletId, requestId, charged);
    admission?.settle(spent.tokens);
    admission?.release();
    deps.budgets?.record(budgets, spent.costUsd, spent.tokens);
  }
}
