/**
 * Hot-path metrics (card 8.1). All times are in seconds (Prometheus convention).
 * Labels are only stable provider/model and enum values; request id, user, key,
 * organization, credential and text errors are never used as labels.
 */
import type { UsageEvent } from '@dirouter/contracts';
import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Registry,
  type RegistryContentType,
} from 'prom-client';

export interface OutboxStats {
  size(): Promise<number>;
}

export interface GatewayMetricOptions {
  breakerStates(): {
    scope: 'provider' | 'model';
    provider: string;
    model: string;
    state: string;
  }[];
  outbox?: OutboxStats;
}

const breakerState = (state: string) => (state === 'closed' ? 0 : 1);

export function createGatewayMetrics(options: GatewayMetricOptions) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'dirouter_gateway_' });

  const requests = new Counter({
    name: 'dirouter_gateway_requests_total',
    help: 'LLM requests observed by the gateway',
    labelNames: ['provider', 'model', 'status'],
    registers: [registry],
  });
  const latency = new Histogram({
    name: 'dirouter_gateway_request_duration_seconds',
    help: 'End-to-end gateway request duration',
    labelNames: ['provider', 'model'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });
  const ttft = new Histogram({
    name: 'dirouter_gateway_ttft_seconds',
    help: 'Time to the first response byte for streaming requests',
    labelNames: ['provider', 'model'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  });
  const attempts = new Histogram({
    name: 'dirouter_gateway_request_attempts',
    help: 'Upstream attempts, excluding candidates skipped before an attempt',
    labelNames: ['provider', 'model'],
    buckets: [0, 1, 2, 3, 5, 8, 13],
    registers: [registry],
  });
  const attemptDuration = new Histogram({
    name: 'dirouter_gateway_upstream_attempt_duration_seconds',
    help: 'Individual upstream attempt duration',
    labelNames: ['provider', 'model', 'outcome'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    registers: [registry],
  });
  const rejected = new Counter({
    name: 'dirouter_gateway_admission_rejected_total',
    help: 'Requests rejected before an upstream attempt',
    labelNames: ['guard', 'reason'],
    registers: [registry],
  });
  const guardrailUnknown = new Counter({
    name: 'dirouter_gateway_guardrail_unknown_total',
    help: 'Evaluations that skipped an enabled guardrail policy of a type this gateway does not enforce',
    labelNames: ['type'],
    registers: [registry],
  });
  const guardrailCalls = new Counter({
    name: 'dirouter_gateway_guardrail_calls_total',
    help: 'Model calls made by moderation and classifier guardrails, by outcome',
    labelNames: ['type', 'outcome'],
    registers: [registry],
  });
  const cacheHits = new Counter({
    name: 'dirouter_gateway_cache_hits_total',
    help: 'Responses served from the exact or semantic cache',
    labelNames: ['kind'],
    registers: [registry],
  });
  // GenAI semantic conventions v1.41.0 (card 24.3). Prometheus names cannot hold dots; the OTLP
  // exporter sends these as gen_ai.client.token.usage and gen_ai.client.operation.duration.
  const genAiTokens = new Histogram({
    name: 'dirouter_gateway_gen_ai_client_token_usage',
    help: 'Tokens per upstream LLM call (gen_ai.client.token.usage)',
    labelNames: ['operation', 'provider', 'request_model', 'response_model', 'token_type'],
    buckets: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304],
    registers: [registry],
  });
  const genAiDuration = new Histogram({
    name: 'dirouter_gateway_gen_ai_client_operation_duration_seconds',
    help: 'Duration of each upstream LLM call (gen_ai.client.operation.duration)',
    labelNames: ['operation', 'provider', 'request_model', 'response_model', 'error_type'],
    buckets: [
      0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
    ],
    registers: [registry],
  });
  const activeStreams = new Gauge({
    name: 'dirouter_gateway_active_streams',
    help: 'Currently open upstream/client LLM streams',
    registers: [registry],
  });
  new Gauge({
    name: 'dirouter_gateway_usage_outbox_events',
    help: 'Usage events still buffered in memory or persisted in the local outbox',
    registers: [registry],
    async collect() {
      if (!options.outbox) return;
      try {
        this.set(await options.outbox.size());
      } catch {
        // A scrape must not fail because of a dirty outbox or Valkey being down; the previous value stays.
      }
    },
  });

  new Gauge({
    name: 'dirouter_gateway_breaker_state',
    help: 'Current provider/model circuit breaker state; one series per scope and target',
    labelNames: ['scope', 'provider', 'model', 'state'],
    registers: [registry],
    collect() {
      this.reset();
      for (const breaker of options.breakerStates())
        this.set(
          {
            scope: breaker.scope,
            provider: breaker.provider,
            model: breaker.model,
            state: breaker.state,
          },
          breakerState(breaker.state),
        );
    },
  });

  return {
    registry,
    contentType: registry.contentType as RegistryContentType,
    observe(event: UsageEvent) {
      const provider = event.providerId ?? 'none';
      const model = event.resolvedModelId ?? event.requestedModel;
      const labels = { provider, model };
      requests.inc({ ...labels, status: event.status });
      latency.observe(labels, event.latencyMs / 1_000);
      if (event.ttftMs !== undefined) ttft.observe(labels, event.ttftMs / 1_000);
      attempts.observe(labels, event.attempts.length);
    },
    observeAttempt(attempt: {
      provider: string;
      model: string;
      outcome: string;
      latencyMs: number;
    }) {
      const { provider, model, outcome } = attempt;
      attemptDuration.observe({ provider, model, outcome }, attempt.latencyMs / 1_000);
    },
    /** One upstream LLM call in GenAI semantic-convention terms (card 24.3). */
    observeGenAi(call: {
      operation: string;
      provider: string;
      requestModel: string;
      responseModel?: string | undefined;
      durationMs: number;
      errorType?: string | undefined;
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
    }) {
      const base = {
        operation: call.operation,
        provider: call.provider,
        request_model: call.requestModel,
        response_model: call.responseModel ?? '',
      };
      genAiDuration.observe({ ...base, error_type: call.errorType ?? '' }, call.durationMs / 1_000);
      if (call.inputTokens !== undefined)
        genAiTokens.observe({ ...base, token_type: 'input' }, call.inputTokens);
      if (call.outputTokens !== undefined)
        genAiTokens.observe({ ...base, token_type: 'output' }, call.outputTokens);
    },
    reject(
      guard: 'rate_limit' | 'budget' | 'wallet' | 'concurrency' | 'guardrail',
      reason: string,
    ) {
      rejected.inc({ guard, reason });
    },
    /** A policy type this gateway does not enforce (label sanitised to keep cardinality bounded). */
    guardrailUnknown(type: string) {
      guardrailUnknown.inc({ type: type.replace(/[^a-z0-9_]/gi, '_').slice(0, 32) || 'empty' });
    },
    guardrailCall(type: string, outcome: 'pass' | 'flagged' | 'timeout' | 'error') {
      guardrailCalls.inc({ type, outcome });
    },
    cacheHit(kind: 'exact' | 'semantic') {
      cacheHits.inc({ kind });
    },
    streamStarted() {
      activeStreams.inc();
    },
    streamEnded() {
      activeStreams.dec();
    },
  };
}

export type GatewayMetrics = ReturnType<typeof createGatewayMetrics>;
