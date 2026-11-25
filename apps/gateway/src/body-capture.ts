/**
 * Request body capture (card 24.1).
 *
 * The level comes from the snapshot (key, then project, then organization, then the instance
 * default); at `none` nothing here runs. Otherwise the request body is kept by reference, the
 * answer is taken from the reply as it is sent (or rebuilt from a stream), and once the response
 * has closed the record is redacted, cut to the size cap and queued.
 *
 * Bodies do not travel with usage events: they go to their own `request-bodies` queue, best
 * effort, so a large prompt never slows down billing. A record that cannot be queued (Valkey down,
 * too many in flight) is counted and dropped; the request itself is never affected.
 */
import {
  bodyCaptureLevel,
  type BodyMetadata,
  type CanonicalRequest,
  type ConfigSnapshot,
  DEFAULT_BODY_MAX_BYTES,
  type GuardrailPolicy,
  type InboundApi,
  policiesFor,
  redactForStorage,
  REQUEST_BODIES_QUEUE,
  type ReplayDraft,
  type RequestBodyRecord,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { connectValkey, type Logger } from '@dirouter/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { usageJobId } from './usage-sink.js';

export type RecordBody = (record: RequestBodyRecord) => void;

/** Top-level request fields that carry content rather than parameters. */
const CONTENT_KEYS = new Set([
  'model',
  'stream',
  'messages',
  'input',
  'contents',
  'system',
  'systemInstruction',
  'system_instruction',
  'instructions',
  'prompt',
]);

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const cut = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  // A character split at the boundary decodes as U+FFFD; drop it.
  return { text: cut.replace(/�$/, ''), truncated: true };
}

const textOf = (parts: { type: string; text?: string }[]) =>
  parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');

/**
 * The conversation as the playground can send it again: system text, plain-text turns and the last
 * user message as the prompt. Images, tool calls and tool results are left out and the draft is
 * marked lossy. Undefined when there is no user message to replay.
 */
export function replayDraft(request: CanonicalRequest): ReplayDraft | undefined {
  let lossy = false;
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      lossy = true;
      continue;
    }
    if (message.content.some((p) => p.type !== 'text' && p.type !== 'reasoning')) lossy = true;
    const content = textOf(message.content);
    if (content) turns.push({ role: message.role, content });
  }
  let last = turns.length - 1;
  while (last >= 0 && turns[last]?.role !== 'user') last--;
  const prompt = turns[last];
  if (!prompt) return undefined;
  // An assistant prefill after the last user message cannot be sent by the playground.
  if (last < turns.length - 1) lossy = true;
  const system = request.system.map((p) => p.text).join('\n');
  return {
    ...(system ? { system } : {}),
    history: turns.slice(0, last),
    prompt: prompt.content,
    ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    lossy: lossy || (request.tools?.length ?? 0) > 0,
  };
}

/** A payload as Fastify sends it, as a JSON value when it is JSON and as text otherwise. */
function asValue(payload: unknown): unknown {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
  }
  if (Buffer.isBuffer(payload)) return asValue(payload.toString('utf8'));
  return payload ?? null;
}

const serialize = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

export interface CaptureStart {
  snapshot: ConfigSnapshot;
  key: VirtualKeyConfig;
  api: InboundApi;
  requestId: string;
  started: number;
  /** The parsed request body exactly as the client sent it. */
  body: unknown;
  /** The canonical request as parsed; request guardrails redact it in place before routing. */
  canonical: CanonicalRequest;
  /** Request size from Content-Length, when the client sent one. */
  contentLength?: number | undefined;
}

export class BodyCapture {
  readonly level: 'metadata' | 'full';
  readonly #start: CaptureStart;
  readonly #policies: GuardrailPolicy[];
  readonly #maxBytes: number;
  #response: unknown;
  #hasResponse = false;
  #streamed = false;
  #finishReason: string | undefined;
  #finished = false;
  #closed = false;
  #done = false;
  readonly #emit: RecordBody | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;

  constructor(
    level: 'metadata' | 'full',
    start: CaptureStart,
    emit?: RecordBody,
    onError?: (error: unknown) => void,
  ) {
    this.level = level;
    this.#start = start;
    this.#emit = emit;
    this.#onError = onError;
    this.#policies = policiesFor(start.snapshot.guardrails, start.key);
    this.#maxBytes = start.snapshot.settings.bodyCapture?.maxBytes ?? DEFAULT_BODY_MAX_BYTES;
  }

  /** The answer the client receives; the last one set wins. */
  setResponse(payload: unknown, opts: { streamed?: boolean; finishReason?: string } = {}): void {
    this.#response = asValue(payload);
    this.#hasResponse = true;
    this.#streamed = opts.streamed === true;
    if (opts.finishReason) this.#finishReason = opts.finishReason;
  }

  setFinishReason(reason: string): void {
    this.#finishReason = reason;
  }

  /** The client connection is done with this response. */
  responseClosed(): void {
    this.#closed = true;
    this.#maybeEmit();
  }

  /** The request handler returned; a stream's answer has been handed over by now. */
  handlerDone(): void {
    this.#done = true;
    this.#maybeEmit();
  }

  /** Builds and queues the record once both the response and the handler have finished. */
  #maybeEmit(): void {
    if (!this.#closed || !this.#done || !this.#emit) return;
    try {
      const record = this.finish();
      if (record) this.#emit(record);
    } catch (error) {
      this.#onError?.(error);
    }
  }

  /** Builds the record once; later calls return undefined. */
  finish(): RequestBodyRecord | undefined {
    if (this.#finished) return undefined;
    this.#finished = true;
    const { canonical, body, key } = this.#start;
    const responseText = this.#hasResponse ? serialize(this.#response) : '';
    const roles: Record<string, number> = {};
    if (canonical.system.length > 0) roles.system = canonical.system.length;
    for (const message of canonical.messages) roles[message.role] = (roles[message.role] ?? 0) + 1;
    const metadata: BodyMetadata = {
      model: canonical.model,
      stream: canonical.stream,
      parameters:
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body)
              .filter((k) => !CONTENT_KEYS.has(k))
              .sort()
          : [],
      messages: canonical.messages.length,
      roles,
      tools: (canonical.tools ?? []).map((t) => t.name),
      requestBytes: this.#start.contentLength ?? Buffer.byteLength(serialize(body ?? null)),
      responseBytes: Buffer.byteLength(responseText),
      ...(this.#finishReason ? { finishReason: this.#finishReason } : {}),
    };
    const record: RequestBodyRecord = {
      requestId: this.#start.requestId,
      createdAt: new Date(this.#start.started).toISOString(),
      organizationId: key.organizationId,
      projectId: key.projectId,
      apiKeyId: key.id,
      inboundApi: this.#start.api,
      level: this.level,
      metadata,
      requestTruncated: false,
      responseTruncated: false,
      streamed: this.#streamed,
      redactions: 0,
    };
    if (this.level === 'metadata') return record;

    // Redaction runs on the structure, before serializing and cutting, so a cut never leaves half
    // of a match behind.
    const request = redactForStorage(this.#policies, body ?? null, 'request');
    const req = capBytes(serialize(request.value), this.#maxBytes);
    record.request = req.text;
    record.requestTruncated = req.truncated;
    record.redactions += request.redactions;
    if (this.#hasResponse) {
      const response = redactForStorage(this.#policies, this.#response, 'response');
      const res = capBytes(serialize(response.value), this.#maxBytes);
      record.response = res.text;
      record.responseTruncated = res.truncated;
      record.redactions += response.redactions;
    }
    // The canonical request object this capture started with: request guardrails redacted it in
    // place, while compression and routing only ever replace it with a copy.
    const draft = replayDraft(canonical);
    if (draft) {
      const replay = redactForStorage(this.#policies, draft, 'request');
      record.replay = replay.value as ReplayDraft;
      record.redactions += replay.redactions;
    }
    return record;
  }
}

/** A capture for this request, or undefined when its key captures nothing. */
export function startBodyCapture(
  start: CaptureStart,
  emit: RecordBody,
  onError?: (error: unknown) => void,
): BodyCapture | undefined {
  const level = bodyCaptureLevel(start.snapshot.bodyCapture, start.key, start.snapshot.settings);
  return level === 'none' ? undefined : new BodyCapture(level, start, emit, onError);
}

/** At most this many records wait for Valkey at once; the rest are dropped and counted. */
const MAX_IN_FLIGHT = 200;

/** Queues captured bodies for the worker (best effort, never on the usage path). */
export class BodySink {
  readonly #queue: Queue;
  readonly #redis: Redis;
  #inFlight = 0;
  readonly stats = { queued: 0, dropped: 0 };

  constructor(
    valkeyUrl: string,
    private readonly logger: Logger,
  ) {
    // No offline queue: while Valkey is down a record fails at once instead of piling up in memory.
    this.#redis = connectValkey(Redis, valkeyUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (n: number) => Math.min(n * 200, 2_000),
    });
    this.#redis.on('error', () => undefined);
    this.#queue = new Queue(REQUEST_BODIES_QUEUE, { connection: this.#redis });
    this.#queue.on('error', () => undefined);
  }

  record(record: RequestBodyRecord): void {
    if (this.#inFlight >= MAX_IN_FLIGHT || this.#redis.status !== 'ready') {
      this.stats.dropped++;
      return;
    }
    this.#inFlight++;
    void this.#queue
      .add('body', record, {
        // Client x-request-id values may hold ':' or be purely numeric; BullMQ refuses both.
        jobId: usageJobId(record.requestId),
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      })
      .then(() => {
        this.stats.queued++;
      })
      .catch((error: unknown) => {
        this.stats.dropped++;
        this.logger.debug({ err: error, requestId: record.requestId }, 'request body dropped');
      })
      .finally(() => {
        this.#inFlight--;
      });
  }

  async close(): Promise<void> {
    await this.#queue.close().catch(() => undefined);
    this.#redis.disconnect();
  }
}
