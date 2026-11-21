/**
 * OpenTelemetry tracing over OTLP/HTTP JSON (card 17.2), using node's fetch and no SDK dependency.
 *
 * - W3C Trace Context: an incoming `traceparent` is continued (same trace id, the caller's span as
 *   parent) and every upstream attempt carries its own `traceparent`, so a trace runs from the
 *   client through the gateway to the provider.
 * - Sampling is parent-based: a sampled parent is always recorded, an unsampled parent never, and
 *   requests without a parent are sampled with `sampleRatio`. Unsampled requests cost two random
 *   ids and nothing else.
 * - One `gateway.request` span per request and one `gateway.upstream` child span per attempt
 *   (retries, fallbacks and hedges each get their own).
 * - Spans are batched in memory and flushed every second (and on shutdown). Export failures never
 *   affect the request path; when the collector is down the batch is dropped.
 *
 * Tracing is off unless `settings.tracing.enabled` is true and an endpoint is set.
 */
import { randomBytes } from 'node:crypto';

import type { TracingSettings } from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';

type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

interface OtlpAttribute {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
}

export interface Span {
  end(status?: 'ok' | 'error', attributes?: Attributes): void;
}

/** A span that can have children and be propagated to another service. */
export interface TraceSpan extends Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
  /** `traceparent` header value naming this span as the parent of the next hop. */
  readonly traceparent: string;
  child(name: string, attributes?: Attributes): TraceSpan;
}

export interface ParentContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const SPAN_KIND_SERVER = 2;
const SPAN_KIND_CLIENT = 3;
const MAX_BUFFER = 5_000;
const OFF: TracingSettings = { enabled: false, serviceName: 'dirouter-gateway', sampleRatio: 0 };

const traceIdHex = () => randomBytes(16).toString('hex');
const spanIdHex = () => randomBytes(8).toString('hex');

/** Parses a W3C `traceparent` header; anything malformed (or all-zero ids) is ignored. */
export function parseTraceparent(header: unknown): ParentContext | undefined {
  if (typeof header !== 'string') return undefined;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return undefined;
  const [, traceId = '', spanId = '', flags = '00'] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

export class Tracer {
  readonly #getSettings: () => TracingSettings | undefined;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #random: () => number;
  readonly #buffer: unknown[] = [];
  readonly #timer: NodeJS.Timeout | undefined;
  #flushing = false;
  dropped = 0;

  constructor(
    settings: TracingSettings | undefined | (() => TracingSettings | undefined),
    logger: Logger,
    fetchImpl?: typeof fetch,
    random: () => number = Math.random,
  ) {
    this.#getSettings = typeof settings === 'function' ? settings : () => settings;
    this.#logger = logger;
    this.#fetch = fetchImpl ?? fetch;
    this.#random = random;
    this.#timer = setInterval(() => void this.flush(), 1_000);
    this.#timer.unref();
  }

  get #settings(): TracingSettings {
    return this.#getSettings() ?? OFF;
  }

  get enabled(): boolean {
    return this.#settings.enabled && typeof this.#settings.endpoint === 'string';
  }

  /** Parent-based decision: follow the caller when there is one, otherwise use the ratio. */
  #sample(parent: ParentContext | undefined): boolean {
    if (!this.enabled) return false;
    if (parent) return parent.sampled;
    return this.#random() < this.#settings.sampleRatio;
  }

  /**
   * Starts the server span of an inbound request. `traceparent` is the raw header value (if any).
   * Always returns a span object so callers can propagate ids; nothing is recorded unless sampled.
   */
  startRequest(name: string, attributes: Attributes = {}, traceparent?: unknown): TraceSpan {
    const parent = parseTraceparent(traceparent);
    return this.#span({
      name,
      attributes,
      traceId: parent?.traceId ?? traceIdHex(),
      parentSpanId: parent?.spanId,
      sampled: this.#sample(parent),
      kind: SPAN_KIND_SERVER,
    });
  }

  /** Root span without propagation (kept for callers that only need timing). */
  startSpan(name: string, attributes: Attributes = {}): Span {
    return this.startRequest(name, attributes);
  }

  #span(input: {
    name: string;
    attributes: Attributes;
    traceId: string;
    parentSpanId: string | undefined;
    sampled: boolean;
    kind: number;
  }): TraceSpan {
    const spanId = spanIdHex();
    const started = Date.now();
    let ended = false;
    return {
      traceId: input.traceId,
      spanId,
      sampled: input.sampled,
      traceparent: formatTraceparent(input.traceId, spanId, input.sampled),
      child: (name, attributes = {}) =>
        this.#span({
          name,
          attributes,
          traceId: input.traceId,
          parentSpanId: spanId,
          sampled: input.sampled,
          kind: SPAN_KIND_CLIENT,
        }),
      end: (status = 'ok', extra = {}) => {
        if (ended || !input.sampled) return;
        ended = true;
        if (this.#buffer.length >= MAX_BUFFER) {
          // The collector is slow or down: drop instead of growing without bound.
          this.dropped += 1;
          return;
        }
        this.#buffer.push({
          traceId: input.traceId,
          spanId,
          ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
          name: input.name,
          kind: input.kind,
          startTimeUnixNano: String(started * 1_000_000),
          endTimeUnixNano: String(Date.now() * 1_000_000),
          attributes: toAttributes({ ...input.attributes, ...extra }),
          status: { code: status === 'ok' ? 1 : 2 },
        });
        if (this.#buffer.length >= 200) void this.flush();
      },
    };
  }

  /** Spans waiting for export (for tests and /health/runtime). */
  get pending(): number {
    return this.#buffer.length;
  }

  async flush(): Promise<void> {
    const endpoint = this.#settings.endpoint;
    if (this.#flushing || this.#buffer.length === 0) return;
    if (!endpoint) {
      // Tracing was switched off with spans still buffered.
      this.#buffer.length = 0;
      return;
    }
    this.#flushing = true;
    const spans = this.#buffer.splice(0, this.#buffer.length);
    try {
      await this.#fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: toAttributes({ 'service.name': this.#settings.serviceName }),
              },
              scopeSpans: [{ scope: { name: 'dirouter-gateway' }, spans }],
            },
          ],
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      this.dropped += spans.length;
      this.#logger.debug({ err: error }, 'OTLP export failed');
    } finally {
      this.#flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    await this.flush();
  }
}

function toAttributes(attributes: Attributes): OtlpAttribute[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value:
      typeof value === 'string'
        ? { stringValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value },
  }));
}
