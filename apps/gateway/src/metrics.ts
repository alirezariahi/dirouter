/**
 * متریک‌های مسیر داغ (کارت ۸.۱). همهٔ زمان‌ها بر حسب ثانیه‌اند (قرارداد Prometheus).
 * labelها فقط provider/model پایدار و مقادیر enum هستند؛ request id، کاربر، کلید،
 * سازمان، credential و خطای متنی هرگز label نمی‌شوند.
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
        // Scrape نباید به‌خاطر outbox کثیف یا Valkey قطع شکست بخورد؛ مقدار قبلی می‌ماند.
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
    reject(guard: 'rate_limit' | 'budget' | 'concurrency', reason: string) {
      rejected.inc({ guard, reason });
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
