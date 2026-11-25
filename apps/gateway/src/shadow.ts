/**
 * Shadow traffic (card 32.4): a sampled copy of a request goes to a new model after the client has
 * its answer, so the new model is measured on real traffic without the client ever noticing.
 *
 * - Nothing runs before the response: the copy is scheduled once the handler has finished (the
 *   answer, or a whole stream, is already out), detached from the request, with its own timeout,
 *   and every failure is swallowed. It never touches the key's rate limit, concurrency cap, budget
 *   or wallet, the provider bulkheads, the breakers, the routing statistics, the caches or the
 *   body capture: a slow or failing shadow model cannot change what any client sees.
 * - At most MAX_IN_FLIGHT copies run at once on a replica; more are dropped, not queued.
 * - The copy is billed apart: a usage event with `shadow` set and `chargeUsd` 0, stored by the
 *   worker in its own table. The organization pays its own provider (the target must be one of its
 *   own models), and each policy stops for the day once its `dailyBudgetUsd` is spent.
 */
import type {
  CanonicalRequest,
  ConfigSnapshot,
  ModelConfig,
  ShadowPolicyConfig,
  UsageEvent,
  VirtualKeyConfig,
} from '@dirouter/contracts';
import {
  shadowSpendKey,
  unitsToUsd,
  USAGE_EVENT_SCHEMA_VERSION,
  usdToUnits,
} from '@dirouter/contracts';
import { computeCostUsd, estimateUsage } from '@dirouter/model-catalog';
import { adapterForProvider, classifyNetworkError } from '@dirouter/providers';
import { type Logger, ulid } from '@dirouter/shared';
import type { Redis } from 'ioredis';

import type { LoadedConfig } from './config-store.js';
import { resolveCredentialKey } from './credential-tokens.js';
import { callUpstream, mergeTimeouts, UpstreamTimeout } from './upstream.js';

export const MAX_IN_FLIGHT = 32;
const SPEND_TTL_SECONDS = 3 * 86_400;

export interface PrimaryOutcome {
  requestId: string;
  model: string | null;
  status: number;
  latencyMs: number;
  costUsd: string;
}

/** The policy of the key's organization that mirrors this request, if any (no I/O). */
export function shadowPolicyFor(
  snapshot: ConfigSnapshot,
  key: VirtualKeyConfig,
  requested: string,
  random: () => number = Math.random,
): ShadowPolicyConfig | undefined {
  for (const p of snapshot.shadowPolicies) {
    if (!p.enabled || p.organizationId !== key.organizationId) continue;
    if (p.match !== '*' && p.match !== requested) continue;
    if (p.projectId !== undefined && p.projectId !== key.projectId) continue;
    if (p.sampleRate <= 0 || random() >= p.sampleRate) return undefined;
    return p;
  }
  return undefined;
}

/**
 * The organization's own model behind a shadow target: a model, an alias of one, or the first
 * target of a combo. Marketplace models of the platform are never used (someone else would pay).
 */
export function ownShadowModel(
  config: LoadedConfig,
  organizationId: string,
  target: string,
): ModelConfig | undefined {
  const found = config.router.index.lookup(organizationId, target);
  if (!found) return undefined;
  const model =
    'model' in found
      ? found.model
      : [...found.combo.targets]
          .sort((a, b) => a.order - b.order)
          .map((t) => config.router.index.modelsById.get(t.modelId))
          .find((m) => m?.enabled);
  if (model?.organizationId !== organizationId || !model.enabled) return undefined;
  return model;
}

export class ShadowRunner {
  #inFlight = 0;
  /** Spend per policy and day when there is no Valkey (a single replica). */
  readonly #localSpend = new Map<string, number>();
  readonly stats = { started: 0, dropped: 0, overBudget: 0, failed: 0, succeeded: 0 };

  constructor(
    private readonly options: {
      logger: Logger;
      instance: string;
      emitUsage: (event: UsageEvent) => void;
      redis?: Redis | undefined;
      /** Aborted when the gateway shuts down. */
      signal?: AbortSignal;
      now?: () => Date;
    },
  ) {}

  get inFlight(): number {
    return this.#inFlight;
  }

  /** Schedules the copy; returns at once and never throws. */
  mirror(
    config: LoadedConfig,
    policy: ShadowPolicyConfig,
    key: VirtualKeyConfig,
    canonical: CanonicalRequest,
    primary: PrimaryOutcome,
  ): void {
    if (this.#inFlight >= MAX_IN_FLIGHT || this.options.signal?.aborted) {
      this.stats.dropped++;
      return;
    }
    this.#inFlight++;
    setImmediate(() => {
      this.#run(config, policy, key, canonical, primary)
        .catch((error: unknown) => {
          this.stats.failed++;
          this.options.logger.debug({ err: error, policy: policy.id }, 'shadow request failed');
        })
        .finally(() => {
          this.#inFlight--;
        });
    });
  }

  #day(): string {
    return (this.options.now?.() ?? new Date()).toISOString().slice(0, 10);
  }

  async #spent(policy: ShadowPolicyConfig): Promise<number> {
    const key = shadowSpendKey(policy.id, this.#day());
    if (!this.options.redis) return this.#localSpend.get(key) ?? 0;
    return Number((await this.options.redis.get(key)) ?? 0);
  }

  async #spend(policy: ShadowPolicyConfig, costUsd: string): Promise<void> {
    const units = usdToUnits(costUsd);
    if (units <= 0) return;
    const key = shadowSpendKey(policy.id, this.#day());
    if (!this.options.redis) {
      this.#localSpend.set(key, (this.#localSpend.get(key) ?? 0) + units);
      return;
    }
    await this.options.redis.multi().incrby(key, units).expire(key, SPEND_TTL_SECONDS).exec();
  }

  async #run(
    config: LoadedConfig,
    policy: ShadowPolicyConfig,
    key: VirtualKeyConfig,
    canonical: CanonicalRequest,
    primary: PrimaryOutcome,
  ): Promise<void> {
    // The daily cap: a policy that has spent its budget stops until the next UTC day. Without a
    // readable counter the copy is skipped (an experiment may stop, never overspend).
    if ((await this.#spent(policy)) >= usdToUnits(policy.dailyBudgetUsd)) {
      this.stats.overBudget++;
      return;
    }
    const model = ownShadowModel(config, key.organizationId, policy.target);
    const provider = model ? config.router.index.providersById.get(model.providerId) : undefined;
    const credential = provider?.credentials.find((c) => c.enabled);
    if (!model || !provider?.enabled || !credential) {
      this.stats.failed++;
      return;
    }
    this.stats.started++;
    const started = Date.now();
    const signal = AbortSignal.any([
      AbortSignal.timeout(policy.timeoutMs),
      ...(this.options.signal ? [this.options.signal] : []),
    ]);
    // The same request as the client's, answered in one piece.
    const request: CanonicalRequest = { ...canonical, model: model.slug, stream: false };
    let status = 0;
    let errorCode: string | undefined;
    let usage: UsageEvent['usage'] | undefined;
    let usageEstimated = false;
    try {
      const settings = config.snapshot.settings;
      const proxyUrl = credential.proxy?.url ?? provider.proxy?.url ?? settings.proxy?.url;
      const apiKey = await resolveCredentialKey(
        provider,
        credential,
        config.secret(credential.id, credential.secret),
        { signal, proxyUrl },
      );
      const adapter = adapterForProvider(provider);
      const up = adapter.buildRequest({
        provider,
        model,
        apiKey,
        request,
        credentialHeaders: credential.headers,
        clientHeaders: {},
        onDrop: () => undefined,
      });
      const call = await callUpstream(
        provider,
        up,
        mergeTimeouts(settings.defaultTimeouts, provider.timeouts, { totalMs: policy.timeoutMs }),
        signal,
        false,
        proxyUrl,
      ).catch((error: unknown) => {
        const failure = classifyNetworkError(error, error instanceof UpstreamTimeout);
        throw Object.assign(new Error(failure.message), { class: failure.class });
      });
      try {
        status = call.response.status;
        if (call.response.ok) {
          const parsed = adapter.parseResponse(await call.response.json(), model.upstreamModel);
          usage = parsed.usage ?? estimateUsage(request, parsed.content);
          usageEstimated = parsed.usage === undefined;
        } else {
          errorCode = adapter.classifyError({
            status,
            headers: call.response.headers,
            body: await call.response.text().catch(() => ''),
          }).class;
        }
      } finally {
        call.done();
      }
    } catch (error) {
      errorCode = (error as { class?: string }).class ?? 'connection';
      if (status === 0) status = errorCode === 'timeout' ? 504 : 502;
    }
    const ok = usage !== undefined;
    const costUsd = usage ? computeCostUsd(usage, model.pricing) : '0';
    if (ok) this.stats.succeeded++;
    else this.stats.failed++;
    await this.#spend(policy, costUsd).catch(() => undefined);
    const shadowId = `${primary.requestId}:shadow`;
    this.options.emitUsage({
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: ulid(),
      idempotencyKey: `${shadowId}:${policy.id}`,
      requestId: shadowId,
      occurredAt: new Date(started).toISOString(),
      gatewayInstance: this.options.instance,
      configVersion: config.version,
      organizationId: key.organizationId,
      teamId: key.teamId,
      projectId: key.projectId,
      virtualKeyId: key.id,
      inboundApi: canonical.inboundApi,
      requestedModel: policy.target,
      resolvedModelId: model.id,
      providerId: provider.id,
      credentialId: credential.id,
      stream: false,
      status: ok ? 'success' : 'error',
      httpStatus: ok ? 200 : status,
      ...(errorCode ? { errorCode } : {}),
      usage: usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costUsd,
      // The customer pays nothing for a shadow copy.
      chargeUsd: unitsToUsd(0),
      usageEstimated,
      shadow: {
        policyId: policy.id,
        primaryRequestId: primary.requestId,
        primaryModel: primary.model,
        primaryStatus: primary.status,
        primaryLatencyMs: Math.max(0, Math.round(primary.latencyMs)),
        primaryCostUsd: unitsToUsd(usdToUnits(primary.costUsd)),
      },
      latencyMs: Date.now() - started,
      attempts: [],
    });
  }
}
