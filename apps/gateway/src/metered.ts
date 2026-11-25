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
import {
  applyDataPolicy,
  type Candidate,
  executeWithFallback,
  isRouteError,
} from '@dirouter/routing';
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
import { resolveCredentialKey, tokenFailure } from './credential-tokens.js';
import { chargeUnits, chargeUsd } from './pricing.js';
import { type ProxyDeps, toClientError } from './proxy.js';
import { admitRequest, type Spent } from './spend-guard.js';
import { planErrorToClient, routingFromRequest } from './route-request.js';
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
  /**
   * A call the gateway makes for another request (a guardrail's moderation or classifier call,
   * cards 23.2 and 23.3): its own request id, so the usage event and the wallet reservation do
   * not collide with the parent's, and no second slot of the key's concurrency cap, which the
   * parent already holds.
   */
  nested?: { requestId: string };
  /** Aborts the upstream call (the guardrail's timeout). */
  signal?: AbortSignal;
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
  const requestId = input.nested?.requestId ?? req.id;
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

  // The data policy (card 32.5) holds for every call that carries the caller's data: embeddings,
  // media, moderation and classifier calls are filtered like chat requests.
  let dataPolicy;
  try {
    dataPolicy = routingFromRequest(config.snapshot.routingPolicies, key, req.body).dataPolicy;
  } catch (error) {
    return { ok: false, error: error as DiRouterError };
  }
  const resolved = config.router.resolve(key, input.model, {
    estimatedInputTokens: input.estimatedInputTokens,
  });
  const route =
    dataPolicy && !isRouteError(resolved) ? applyDataPolicy(resolved, dataPolicy) : resolved;
  if ('error' in route && route.error === 'no_provider_matches_data_policy')
    return { ok: false, error: planErrorToClient(route, input.model) };
  if ('error' in route)
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
  const selected = input.select(route.candidates);
  if (selected instanceof DiRouterError) return { ok: false, error: selected };

  // Budgets and rate limits (RPM and TPM on the input estimate) apply before any provider is
  // called (spend-guard.ts); a used-up model or provider budget takes its candidates out.
  const admission = await admitRequest(deps, {
    config,
    key,
    candidates: selected,
    requested: input.model,
    estimatedTokens: input.estimatedInputTokens,
    requestId,
  });
  if (!admission.ok) {
    deps.metrics?.reject(admission.metric.guard, admission.metric.reason);
    return { ok: false, headers: admission.headers, error: admission.error };
  }
  const candidates = admission.candidates;
  const releaseAdmission = () => {
    admission.cancel();
  };

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
  input.signal?.addEventListener(
    'abort',
    () => {
      clientGone.abort(input.signal?.reason ?? new Error('aborted'));
    },
    { once: true },
  );

  const keyBulkhead = input.nested
    ? undefined
    : deps.bulkheads?.get(`key:${key.id}`, key.rateLimit?.maxConcurrency, {});
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
      return { ok: false as const, error: tokenFailure(error) };
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
        proxyUrl,
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

  let spent: Spent = { tokens: 0, costUsd: '0' };
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
    spent = {
      tokens: usage.inputTokens + usage.outputTokens,
      costUsd,
      candidate: result.ok ? result.candidate : undefined,
    };
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
      headers: admission.headers,
    };
  } finally {
    deps.lifecycle?.signal.removeEventListener('abort', onShutdown);
    releaseKey();
    if (walletId) deps.wallets?.settle(walletId, requestId, charged);
    admission.finish(spent);
  }
}
