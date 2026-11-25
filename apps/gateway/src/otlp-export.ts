/**
 * OTLP/HTTP JSON export of metrics and logs (card 24.3), next to the traces of tracing.ts and with
 * the same rules: no SDK dependency, settings read from the snapshot on every tick (a change applies
 * without a restart), and export failures never touch the request path.
 *
 * - Metrics: the Prometheus registry is converted as it is (cumulative counters, gauges and
 *   histograms under their Prometheus names), except the GenAI histograms, which leave under their
 *   semantic-convention names (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`)
 *   with `gen_ai.*` attribute keys.
 * - Logs: every JSON line the logger writes is also queued as an OTLP log record (the same fields,
 *   so the log privacy rules of docs/observability.md hold), batched every second.
 */
import type { TracingSettings } from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';
import type { Registry } from 'prom-client';

import { type Attributes, GENAI_SCHEMA_URL } from './genai.js';
import { toAttributes } from './tracing.js';

type MetricsJson = Awaited<ReturnType<Registry['getMetricsAsJSON']>>;
type PromValue = MetricsJson[number]['values'][number];

/** Prometheus GenAI histograms → semantic-convention metric names, units and attribute keys. */
const GENAI_METRICS: Record<string, { name: string; unit: string }> = {
  dirouter_gateway_gen_ai_client_token_usage: {
    name: 'gen_ai.client.token.usage',
    unit: '{token}',
  },
  dirouter_gateway_gen_ai_client_operation_duration_seconds: {
    name: 'gen_ai.client.operation.duration',
    unit: 's',
  },
};
const GENAI_LABELS: Record<string, string> = {
  operation: 'gen_ai.operation.name',
  provider: 'gen_ai.provider.name',
  request_model: 'gen_ai.request.model',
  response_model: 'gen_ai.response.model',
  token_type: 'gen_ai.token.type',
  error_type: 'error.type',
};

const SEVERITY: Record<string, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};
const MAX_LOGS = 5_000;
const nanos = (ms: number) => `${String(Math.round(ms))}000000`;

function labelsOf(labels: PromValue['labels'], genAi: boolean, skip?: string): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key === skip || value === undefined) continue;
    if (genAi) {
      // Empty optional labels (no response model, no error) are simply absent in OTLP.
      if (value === '') continue;
      out[GENAI_LABELS[key] ?? key] = value;
    } else out[key] = typeof value === 'number' ? value : value;
  }
  return out;
}

/** Converts prom-client's JSON into OTLP metrics (cumulative temporality). */
export function toOtlpMetrics(metrics: MetricsJson, startMs: number, nowMs: number): unknown[] {
  const start = nanos(startMs);
  const time = nanos(nowMs);
  const out: unknown[] = [];
  for (const metric of metrics) {
    const genAi = GENAI_METRICS[metric.name];
    const name = genAi?.name ?? metric.name;
    const unit = genAi?.unit ?? (metric.name.endsWith('_seconds') ? 's' : '');
    const base = { name, description: metric.help, ...(unit ? { unit } : {}) };
    const type = String(metric.type);
    if (type === 'counter' || type === 'gauge') {
      const dataPoints = metric.values.map((v) => ({
        attributes: toAttributes(labelsOf(v.labels, Boolean(genAi))),
        startTimeUnixNano: start,
        timeUnixNano: time,
        asDouble: v.value,
      }));
      if (dataPoints.length === 0) continue;
      out.push(
        type === 'counter'
          ? { ...base, sum: { dataPoints, aggregationTemporality: 2, isMonotonic: true } }
          : { ...base, gauge: { dataPoints } },
      );
    } else if (type === 'histogram') {
      // prom-client lists cumulative `_bucket` values per label set, then `_sum` and `_count`.
      const series = new Map<
        string,
        { labels: Attributes; bounds: number[]; cumulative: number[]; sum: number; count: number }
      >();
      for (const v of metric.values) {
        const attrs = labelsOf(v.labels, Boolean(genAi), 'le');
        const id = JSON.stringify(attrs);
        let entry = series.get(id);
        if (!entry) {
          entry = { labels: attrs, bounds: [], cumulative: [], sum: 0, count: 0 };
          series.set(id, entry);
        }
        const metricName = (v as { metricName?: string }).metricName ?? '';
        if (metricName.endsWith('_bucket')) {
          const le = v.labels.le;
          if (le !== '+Inf' && le !== undefined) entry.bounds.push(Number(le));
          entry.cumulative.push(v.value);
        } else if (metricName.endsWith('_sum')) entry.sum = v.value;
        else if (metricName.endsWith('_count')) entry.count = v.value;
      }
      const dataPoints = [...series.values()]
        .filter((s) => s.count > 0)
        .map((s) => ({
          attributes: toAttributes(s.labels),
          startTimeUnixNano: start,
          timeUnixNano: time,
          count: String(s.count),
          sum: s.sum,
          explicitBounds: s.bounds,
          bucketCounts: s.cumulative.map((c, i) => String(c - (s.cumulative[i - 1] ?? 0))),
        }));
      if (dataPoints.length > 0)
        out.push({ ...base, histogram: { dataPoints, aggregationTemporality: 2 } });
    }
    // Summaries are not part of the gateway's registry and have no OTLP equivalent worth sending.
  }
  return out;
}

/** Turns one pino JSON line into an OTLP log record; undefined for lines that are not JSON. */
export function toOtlpLog(line: string): { record: unknown; severity: number } | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const { level, time, msg, ...rest } = parsed;
  const severityText = typeof level === 'string' ? level : 'info';
  const severity = SEVERITY[severityText] ?? 9;
  const at = typeof time === 'string' ? Date.parse(time) : Date.now();
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === null || value === undefined) continue;
    attributes[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : JSON.stringify(value);
  }
  return {
    severity,
    record: {
      timeUnixNano: nanos(Number.isNaN(at) ? Date.now() : at),
      observedTimeUnixNano: nanos(Date.now()),
      severityNumber: severity,
      severityText: severityText.toUpperCase(),
      body: { stringValue: typeof msg === 'string' ? msg : '' },
      attributes: toAttributes(attributes),
    },
  };
}

/** Collects log lines until the exporter sends them; cheap when export is off. */
export class OtlpLogBuffer {
  readonly #records: unknown[] = [];
  #minSeverity: number | undefined;
  dropped = 0;

  /** Undefined switches collection off (nothing is parsed). */
  setMinLevel(level: string | undefined): void {
    this.#minSeverity = level === undefined ? undefined : (SEVERITY[level] ?? 9);
    if (level === undefined) this.#records.length = 0;
  }

  push(line: string): void {
    if (this.#minSeverity === undefined) return;
    const log = toOtlpLog(line);
    if (!log || log.severity < this.#minSeverity) return;
    if (this.#records.length >= MAX_LOGS) {
      this.dropped += 1;
      return;
    }
    this.#records.push(log.record);
  }

  take(): unknown[] {
    return this.#records.splice(0, this.#records.length);
  }
}

export interface OtlpExporterOptions {
  settings: () => TracingSettings | undefined;
  registry: Registry;
  logger: Logger;
  logs?: OtlpLogBuffer;
  instance: string;
  fetchImpl?: typeof fetch;
  /** Tick length; metrics go out every `metrics.intervalSeconds`, logs every tick. */
  tickMs?: number;
}

export class OtlpExporter {
  readonly #opts: OtlpExporterOptions;
  readonly #fetch: typeof fetch;
  readonly #timer: NodeJS.Timeout;
  readonly #startMs = Date.now() - process.uptime() * 1_000;
  #lastMetrics = 0;
  #busy = false;
  readonly stats = { metricsExports: 0, logRecords: 0, failures: 0 };

  constructor(opts: OtlpExporterOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timer = setInterval(() => void this.tick(), opts.tickMs ?? 1_000);
    this.#timer.unref();
  }

  #resource(settings: TracingSettings | undefined) {
    return {
      attributes: toAttributes({
        'service.name': settings?.serviceName ?? 'dirouter-gateway',
        'service.instance.id': this.#opts.instance,
      }),
    };
  }

  async #post(url: string, body: unknown): Promise<void> {
    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`collector answered ${String(res.status)}`);
    } catch (error) {
      this.stats.failures += 1;
      this.#opts.logger.debug({ err: error, url }, 'OTLP export failed');
    }
  }

  /** One round: logs every tick, metrics when their interval has passed. */
  async tick(force = false): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const settings = this.#opts.settings();
      const logs = settings?.logs;
      const logsOn = logs?.enabled === true && typeof logs.endpoint === 'string';
      this.#opts.logs?.setMinLevel(logsOn ? logs.level : undefined);
      if (logsOn && this.#opts.logs) {
        const records = this.#opts.logs.take();
        if (records.length > 0) {
          this.stats.logRecords += records.length;
          await this.#post(logs.endpoint ?? '', {
            resourceLogs: [
              {
                resource: this.#resource(settings),
                scopeLogs: [{ scope: { name: 'dirouter-gateway' }, logRecords: records }],
              },
            ],
          });
        }
      }
      const metrics = settings?.metrics;
      if (metrics?.enabled !== true || !metrics.endpoint) return;
      const now = Date.now();
      if (!force && now - this.#lastMetrics < metrics.intervalSeconds * 1_000) return;
      this.#lastMetrics = now;
      const converted = toOtlpMetrics(
        await this.#opts.registry.getMetricsAsJSON(),
        this.#startMs,
        now,
      );
      this.stats.metricsExports += 1;
      await this.#post(metrics.endpoint, {
        resourceMetrics: [
          {
            resource: this.#resource(settings),
            scopeMetrics: [
              {
                scope: { name: 'dirouter-gateway' },
                schemaUrl: GENAI_SCHEMA_URL,
                metrics: converted,
              },
            ],
          },
        ],
      });
    } finally {
      this.#busy = false;
    }
  }

  /** Sends what is left (shutdown). */
  async shutdown(): Promise<void> {
    clearInterval(this.#timer);
    await this.tick(true);
  }
}
