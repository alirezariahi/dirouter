/**
 * AWS Bedrock adapter (card 11.3).
 *
 * Uses the Converse API (`/model/{modelId}/converse`) for both JSON and streaming
 * (`/converse-stream`, `vnd.amazon.eventstream` binary framing), signed with SigV4 using
 * node:crypto only.
 *
 * Credential secret formats: `accessKeyId:secretAccessKey`, `accessKeyId:secretAccessKey:sessionToken`
 * or JSON `{"accessKeyId":…,"secretAccessKey":…,"sessionToken":…}`. A session token (temporary
 * credentials) is sent as `x-amz-security-token` and is part of the signed headers;
 * `options.sessionToken` is a provider-wide fallback when the secret carries none.
 */
import { createHash, createHmac } from 'node:crypto';

import type {
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalTool,
  CanonicalUsage,
} from '@dirouter/contracts';
import {
  type DropReporter,
  JSON_ONLY_INSTRUCTION,
  StructuredOutputStream,
  STRUCTURED_OUTPUT_TOOL,
  type StructuredOutputMode,
  bedrockStructuredOutputMode,
  ignoreDrops,
  structuredOutputTool,
  unwrapStructuredOutput,
} from '@dirouter/translator';

import {
  type ClassifiedError,
  type HttpErrorInput,
  classified,
  classifyHttpError,
} from './errors.js';
import type { BuildContext, ProviderAdapter, StreamDecoder, UpstreamRequest } from './adapters.js';

/** A wire value as a string, or undefined when the provider sent something else. */
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const BEDROCK_DEFAULT_REGION = 'us-east-1';
const SERVICE = 'bedrock';

// ───────────── SigV4 ─────────────

const sha256Hex = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data);

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * `AKIA…:secret`, `ASIA…:secret:sessionToken` (credential secret) or JSON `{"accessKeyId":…}`.
 * Access key ids and secret keys never contain `:`, so the third segment is the session token.
 */
export function parseAwsCredentials(raw: string): AwsCredentials {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as Partial<AwsCredentials>;
    if (!parsed.accessKeyId || !parsed.secretAccessKey)
      throw new Error('bedrock credentials need accessKeyId and secretAccessKey');
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      ...(parsed.sessionToken ? { sessionToken: parsed.sessionToken } : {}),
    };
  }
  const at = trimmed.indexOf(':');
  if (at <= 0) throw new Error('bedrock credential must be accessKeyId:secretAccessKey');
  const rest = trimmed.slice(at + 1);
  const tokenAt = rest.indexOf(':');
  const secretAccessKey = tokenAt < 0 ? rest : rest.slice(0, tokenAt);
  const sessionToken = tokenAt < 0 ? '' : rest.slice(tokenAt + 1);
  if (!secretAccessKey) throw new Error('bedrock credential must be accessKeyId:secretAccessKey');
  return {
    accessKeyId: trimmed.slice(0, at),
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

/**
 * SigV4 `UriEncode`: every byte except `A-Z a-z 0-9 - . _ ~` is percent-encoded with uppercase hex.
 * `encodeURIComponent` leaves `! ' ( ) *` alone, so those are handled here.
 */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Canonical URI for every service except S3: each segment of the path *as sent* is URI-encoded
 * once more, so a model id sent as `…-v2%3A0` is signed as `…-v2%253A0`.
 */
export function canonicalUri(pathname: string): string {
  if (!pathname) return '/';
  return pathname.split('/').map(awsUriEncode).join('/');
}

function canonicalQueryString(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export interface SignInput {
  method: 'POST' | 'GET';
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  credentials: AwsCredentials;
  now?: Date;
}

interface SigningParts {
  headers: Record<string, string>;
  amzDate: string;
  signedHeaders: string;
  canonicalRequest: string;
}

function signingParts(input: SignInput): SigningParts {
  const url = new URL(input.url);
  const amzDate = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': sha256Hex(input.body),
  };
  if (input.credentials.sessionToken)
    headers['x-amz-security-token'] = input.credentials.sessionToken;

  const canonicalNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const headerMap = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]),
  );
  const canonicalHeaders = canonicalNames.map((n) => `${n}:${headerMap.get(n) ?? ''}\n`).join('');
  const signedHeaders = canonicalNames.join(';');
  const canonicalRequest = [
    input.method,
    canonicalUri(url.pathname),
    canonicalQueryString(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join('\n');
  return { headers, amzDate, signedHeaders, canonicalRequest };
}

/** The SigV4 canonical request string (exposed for contract tests). */
export function awsCanonicalRequest(input: SignInput): string {
  return signingParts(input).canonicalRequest;
}

/** Adds `x-amz-date`, `x-amz-content-sha256` and `authorization` (SigV4). */
export function signAwsRequest(input: SignInput): Record<string, string> {
  const { headers, amzDate, signedHeaders, canonicalRequest } = signingParts(input);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  let key: Buffer = Buffer.from(`AWS4${input.credentials.secretAccessKey}`, 'utf8');
  key = hmac(key, date).digest();
  key = hmac(key, input.region).digest();
  key = hmac(key, SERVICE).digest();
  key = hmac(key, 'aws4_request').digest();
  const signature = hmac(key, stringToSign).digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ───────────── canonical → Converse ─────────────

type ConversePart = Record<string, unknown>;
type ConverseMessage = { role: 'user' | 'assistant'; content: ConversePart[] };

function imageFormat(mediaType: string): string {
  const sub = mediaType.split('/')[1] ?? 'png';
  if (sub === 'jpg') return 'jpeg';
  return sub;
}

function partToConverse(part: CanonicalPart, onDrop: DropReporter): ConversePart[] {
  switch (part.type) {
    case 'text':
      return [{ text: part.text }];
    case 'reasoning':
      return [];
    case 'image':
      return part.source.kind === 'base64'
        ? [
            {
              image: {
                format: imageFormat(part.source.mediaType),
                source: { bytes: part.source.data },
              },
            },
          ]
        : (onDrop('messages[].content[]', 'bedrock does not accept image URLs'), []);
    case 'tool_call':
      return [
        {
          toolUse: {
            toolUseId: part.id,
            name: part.name,
            input: safeJson(part.arguments),
          },
        },
      ];
    case 'tool_result':
      return [
        {
          toolResult: {
            toolUseId: part.toolCallId,
            content: part.content.flatMap((c) => (c.type === 'text' ? [{ text: c.text }] : [])),
            ...(part.isError ? { status: 'error' } : {}),
          },
        },
      ];
    default:
      return [];
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toConverseMessage(
  message: CanonicalMessage,
  onDrop: DropReporter,
): ConverseMessage | undefined {
  const content = message.content.flatMap((p) => partToConverse(p, onDrop));
  if (content.length === 0) return undefined;
  // Bedrock has no `tool` role: tool results travel in a user turn.
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  return { role, content };
}

export interface ConverseRequestOptions {
  /** How `response_format` is sent (card 27.1); defaults to `bedrockStructuredOutputMode`. */
  structuredOutput?: StructuredOutputMode;
}

export function canonicalToConverseRequest(
  request: CanonicalRequest,
  modelId: string,
  onDrop: DropReporter = ignoreDrops,
  options: ConverseRequestOptions = {},
): Record<string, unknown> {
  // Converse requires strictly alternating roles. Canonical `tool` messages become user turns, so
  // consecutive tool results (and a tool result followed by user text) are merged into one message.
  const messages: ConverseMessage[] = [];
  for (const message of request.messages) {
    const converted = toConverseMessage(message, onDrop);
    if (!converted) continue;
    const previous = messages.at(-1);
    if (previous?.role === converted.role) previous.content.push(...converted.content);
    else messages.push(converted);
  }
  const body: Record<string, unknown> = {
    modelId,
    messages,
  };
  const system: ConversePart[] = request.system.map((s) => ({ text: s.text }));
  const inferenceConfig: Record<string, unknown> = {};
  if (request.maxOutputTokens !== undefined) inferenceConfig.maxTokens = request.maxOutputTokens;
  if (request.temperature !== undefined) inferenceConfig.temperature = request.temperature;
  if (request.topP !== undefined) inferenceConfig.topP = request.topP;
  if (request.stop?.length) inferenceConfig.stopSequences = request.stop;
  if (Object.keys(inferenceConfig).length) body.inferenceConfig = inferenceConfig;
  const structured = converseStructuredOutput(request, modelId, options, onDrop);
  if (structured.instruction) system.push({ text: structured.instruction });
  if (structured.additional) body.additionalModelRequestFields = structured.additional;
  if (system.length) body.system = system;
  const tools = [...(request.tools ?? [])];
  if (structured.tool) tools.push(structured.tool);
  if (tools.length) {
    const toolChoice =
      structured.toolChoice ??
      (request.toolChoice
        ? typeof request.toolChoice === 'string'
          ? request.toolChoice === 'required'
            ? { any: {} }
            : request.toolChoice === 'none'
              ? undefined
              : { auto: {} }
          : { tool: { name: request.toolChoice.name } }
        : undefined);
    body.toolConfig = {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          inputSchema: { json: t.parameters },
        },
      })),
      ...(toolChoice ? { toolChoice } : {}),
    };
  }
  return body;
}

interface ConverseStructuredPlan {
  tool?: CanonicalTool;
  toolChoice?: Record<string, unknown>;
  additional?: Record<string, unknown>;
  instruction?: string;
}

/**
 * Card 27.1: `response_format` on Bedrock. The default is a forced tool (`toolChoice.tool`) whose
 * call the response decoders turn back into text; models that reject a forced tool get Anthropic's
 * `output_config.format` through `additionalModelRequestFields`.
 */
function converseStructuredOutput(
  request: CanonicalRequest,
  modelId: string,
  options: ConverseRequestOptions,
  onDrop: DropReporter,
): ConverseStructuredPlan {
  const format = request.responseFormat;
  if (!format || format.type === 'text') return {};
  const mode = options.structuredOutput ?? bedrockStructuredOutputMode(modelId);
  if (mode === 'native') {
    if (format.type === 'json_schema')
      return {
        additional: { output_config: { format: { type: 'json_schema', schema: format.schema } } },
      };
    onDrop('response_format', 'json_object has no schema; sent as an instruction');
    return { instruction: JSON_ONLY_INSTRUCTION };
  }
  const tool = structuredOutputTool(format);
  if (!tool) return {};
  if (request.tools?.length) {
    if (typeof request.toolChoice === 'object')
      return { tool, toolChoice: { tool: { name: request.toolChoice.name } } };
    if (request.toolChoice !== 'none') return { tool, toolChoice: { any: {} } };
  }
  return { tool, toolChoice: { tool: { name: STRUCTURED_OUTPUT_TOOL } } };
}

const FINISH_FROM_BEDROCK: Record<string, CanonicalFinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  content_filtered: 'content_filter',
  guardrail_intervened: 'content_filter',
};

function converseUsage(usage: unknown): CanonicalUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.round(v) : 0);
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadInputTokens),
    cacheWriteTokens: num(u.cacheWriteInputTokens),
    reasoningTokens: 0,
  };
}

export function converseResponseToCanonical(json: unknown, model = 'bedrock'): CanonicalResponse {
  const body = json as {
    output?: { message?: { content?: Record<string, unknown>[] } };
    stopReason?: string;
    usage?: unknown;
  };
  const content: CanonicalPart[] = [];
  for (const part of body.output?.message?.content ?? []) {
    if (typeof part.text === 'string') content.push({ type: 'text', text: part.text });
    else if (part.toolUse && typeof part.toolUse === 'object') {
      const use = part.toolUse as { toolUseId?: string; name?: string; input?: unknown };
      content.push({
        type: 'tool_call',
        id: use.toolUseId ?? use.name ?? 'tool',
        name: use.name ?? 'tool',
        arguments: JSON.stringify(use.input ?? {}),
      });
    }
  }
  const rawFinish = body.stopReason ?? 'end_turn';
  const usage = converseUsage(body.usage);
  return unwrapStructuredOutput({
    id: `bedrock_${Date.now().toString(36)}`,
    model,
    content,
    finishReason: FINISH_FROM_BEDROCK[rawFinish] ?? 'other',
    rawFinishReason: rawFinish,
    ...(usage ? { usage } : {}),
    created: Math.floor(Date.now() / 1000),
  });
}

// ───────────── eventstream decoder ─────────────

export interface EventStreamMessage {
  /** String-typed headers (`:message-type`, `:event-type`, `:exception-type`, …). */
  headers: Record<string, string>;
  payload: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, the GZIP polynomial) as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Prelude: total length (4) + headers length (4) + prelude CRC (4). */
const PRELUDE_BYTES = 12;
/** Prelude plus the trailing message CRC: the size of a message with no headers and no payload. */
const FRAME_OVERHEAD = 16;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Splits an AWS `vnd.amazon.eventstream` byte stream into messages. Chunks may be cut anywhere and
 * may carry several messages. Wire layout of one message (all integers big-endian):
 *
 *   total length (4) | headers length (4) | prelude CRC32 (4) | headers | payload | message CRC32 (4)
 *
 * The prelude CRC covers the first 8 bytes; the message CRC covers everything before itself. A
 * checksum or length violation is unrecoverable (the frame boundary is lost): parsing stops and
 * `error` is set.
 */
export class EventStreamParser {
  #buffer: Buffer = Buffer.alloc(0);
  #error: string | undefined;

  feed(chunk: Uint8Array): EventStreamMessage[] {
    if (this.#error !== undefined) return [];
    this.#buffer =
      this.#buffer.length > 0 ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
    const out: EventStreamMessage[] = [];
    while (this.#buffer.length >= PRELUDE_BYTES) {
      const total = this.#buffer.readUInt32BE(0);
      const headersLength = this.#buffer.readUInt32BE(4);
      if (crc32(this.#buffer.subarray(0, 8)) !== this.#buffer.readUInt32BE(8))
        return this.#fail('prelude checksum mismatch', out);
      if (
        total < FRAME_OVERHEAD ||
        total > MAX_FRAME_BYTES ||
        headersLength > total - FRAME_OVERHEAD
      )
        return this.#fail('invalid frame length', out);
      if (this.#buffer.length < total) break;
      if (crc32(this.#buffer.subarray(0, total - 4)) !== this.#buffer.readUInt32BE(total - 4))
        return this.#fail('message checksum mismatch', out);
      const headersEnd = PRELUDE_BYTES + headersLength;
      const headers = parseHeaders(this.#buffer.subarray(PRELUDE_BYTES, headersEnd));
      if (!headers) return this.#fail('malformed headers', out);
      out.push({ headers, payload: this.#buffer.subarray(headersEnd, total - 4) });
      this.#buffer = this.#buffer.subarray(total);
    }
    return out;
  }

  /** Bytes of an incomplete message still waiting for more input. */
  get pendingBytes(): number {
    return this.#buffer.length;
  }

  /** Set once the stream is corrupt; later `feed` calls return nothing. */
  get error(): string | undefined {
    return this.#error;
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
    this.#error = undefined;
  }

  #fail(reason: string, parsed: EventStreamMessage[]): EventStreamMessage[] {
    this.#error = reason;
    this.#buffer = Buffer.alloc(0);
    return parsed;
  }
}

/** Byte width of fixed-size header value types; booleans (0, 1) carry no value bytes. */
const FIXED_HEADER_VALUE_BYTES: Readonly<Record<number, number>> = {
  0: 0, // true
  1: 0, // false
  2: 1, // byte
  3: 2, // short
  4: 4, // integer
  5: 8, // long
  8: 8, // timestamp
  9: 16, // uuid
};

/** Header: name length (1) | name | value type (1) | [value length (2)] | value. */
function parseHeaders(buf: Buffer): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  let offset = 0;
  while (offset < buf.length) {
    const nameLength = buf.readUInt8(offset);
    offset += 1;
    if (offset + nameLength + 1 > buf.length) return undefined;
    const name = buf.toString('utf8', offset, offset + nameLength);
    offset += nameLength;
    const type = buf.readUInt8(offset);
    offset += 1;
    if (type === 6 || type === 7) {
      // Byte array / string: 2-byte length prefix.
      if (offset + 2 > buf.length) return undefined;
      const length = buf.readUInt16BE(offset);
      offset += 2;
      if (offset + length > buf.length) return undefined;
      if (type === 7) headers[name] = buf.toString('utf8', offset, offset + length);
      offset += length;
      continue;
    }
    const width = FIXED_HEADER_VALUE_BYTES[type];
    if (width === undefined || offset + width > buf.length) return undefined;
    if (type === 0 || type === 1) headers[name] = type === 0 ? 'true' : 'false';
    offset += width;
  }
  return headers;
}

/**
 * In-stream exception (`:exception-type`, lower-cased) → canonical error code. Codes are
 * `UpstreamErrorClass` names so the gateway can classify the failure without parsing messages.
 */
const STREAM_EXCEPTION_CODES: Readonly<Record<string, string>> = {
  throttlingexception: 'rate_limit',
  toomanyrequestsexception: 'rate_limit',
  modelnotreadyexception: 'overloaded',
  serviceunavailableexception: 'overloaded',
  modelstreamerrorexception: 'server',
  internalserverexception: 'server',
  modelerrorexception: 'server',
  modeltimeoutexception: 'timeout',
  validationexception: 'bad_request',
  accessdeniedexception: 'auth',
  resourcenotfoundexception: 'not_found',
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const blockIndex = (body: Record<string, unknown>): number =>
  typeof body.contentBlockIndex === 'number' && Number.isInteger(body.contentBlockIndex)
    ? body.contentBlockIndex
    : 0;

/**
 * ConverseStream decoder. The response is not SSE: the gateway must hand raw bytes to
 * `feedChunk`. The event name travels in the `:event-type` header and the payload is the bare
 * event member, e.g. `{"contentBlockIndex":0,"delta":{"text":"hi"}}`.
 */
class BedrockDecoder implements StreamDecoder {
  readonly #model: string;
  readonly #parser = new EventStreamParser();
  #started = false;
  /** Set after an error event: the stream is over and later bytes are ignored. */
  #failed = false;
  #usage: CanonicalUsage | undefined;
  /** Turns the structured-output fallback tool back into text (card 27.1). */
  readonly #structured = new StructuredOutputStream();

  constructor(model: string) {
    this.#model = model;
  }

  feedChunk(chunk: Uint8Array): CanonicalStreamEvent[] {
    if (this.#failed) return [];
    const events: CanonicalStreamEvent[] = [];
    for (const message of this.#parser.feed(chunk)) {
      const decoded = this.#message(message).flatMap((e) => this.#structured.push(e));
      events.push(...decoded);
      // An exception ends the stream; whatever follows it is not part of the response.
      if (decoded.some((event) => event.type === 'error')) return events;
    }
    if (this.#parser.error !== undefined)
      events.push(this.#fail('server', `corrupt bedrock event stream: ${this.#parser.error}`));
    return events;
  }

  flushChunks(): CanonicalStreamEvent[] {
    if (this.#failed || this.#parser.pendingBytes === 0) return [];
    return [this.#fail('server', 'bedrock event stream ended in the middle of a frame')];
  }

  /** ConverseStream is never SSE; SSE events carry nothing for this decoder. */
  push(): CanonicalStreamEvent[] {
    return [];
  }

  #fail(code: string, message: string): CanonicalStreamEvent {
    this.#failed = true;
    return { type: 'error', code, message };
  }

  #start(): CanonicalStreamEvent[] {
    if (this.#started) return [];
    this.#started = true;
    return [
      {
        type: 'start',
        id: `bedrock_${Date.now().toString(36)}`,
        model: this.#model,
        created: Math.floor(Date.now() / 1000),
      },
    ];
  }

  #message(message: EventStreamMessage): CanonicalStreamEvent[] {
    const text = Buffer.from(message.payload).toString('utf8');
    let json: Record<string, unknown> = {};
    try {
      json = asRecord(JSON.parse(text)) ?? {};
    } catch {
      // Exceptions may carry plain text; events with an unreadable payload are skipped below.
    }
    const messageType = message.headers[':message-type'] ?? 'event';
    if (messageType === 'exception') {
      const type = message.headers[':exception-type'] ?? 'exception';
      const detail = str(json.message) ?? str(json.Message) ?? text.slice(0, 500);
      return [
        this.#fail(
          STREAM_EXCEPTION_CODES[type.toLowerCase()] ?? 'server',
          detail ? `${type}: ${detail}` : type,
        ),
      ];
    }
    if (messageType === 'error') {
      // Unmodelled service error: details are in the headers, not the payload.
      const code = message.headers[':error-code'] ?? 'error';
      const detail = message.headers[':error-message'] ?? str(json.message) ?? '';
      return [
        this.#fail(
          STREAM_EXCEPTION_CODES[code.toLowerCase()] ?? 'server',
          detail ? `${code}: ${detail}` : code,
        ),
      ];
    }
    if (messageType !== 'event') return [];
    const eventType = message.headers[':event-type'] ?? '';
    // The payload is the bare member; tolerate emulators that wrap it under the event name.
    const body = asRecord(json[eventType]) ?? json;
    switch (eventType) {
      case 'messageStart':
        return this.#start();
      case 'contentBlockStart': {
        const toolUse = asRecord(asRecord(body.start)?.toolUse);
        if (!toolUse) return this.#start();
        return [
          ...this.#start(),
          {
            type: 'tool_call_start',
            index: blockIndex(body),
            id: str(toolUse.toolUseId) ?? str(toolUse.name) ?? 'tool',
            name: str(toolUse.name) ?? 'tool',
          },
        ];
      }
      case 'contentBlockDelta': {
        const delta = asRecord(body.delta);
        if (!delta) return [];
        const index = blockIndex(body);
        const out = this.#start();
        if (typeof delta.text === 'string')
          out.push({ type: 'text_delta', index, text: delta.text });
        const toolUse = asRecord(delta.toolUse);
        if (toolUse) {
          const input = toolUse.input;
          out.push({
            type: 'tool_call_delta',
            index,
            argumentsDelta: typeof input === 'string' ? input : JSON.stringify(input ?? ''),
          });
        }
        const reasoning = asRecord(delta.reasoningContent);
        if (reasoning) {
          const reasoningText = str(reasoning.text);
          const signature = str(reasoning.signature);
          if (reasoningText !== undefined)
            out.push({ type: 'reasoning_delta', index, text: reasoningText });
          if (signature !== undefined) out.push({ type: 'reasoning_delta', index, signature });
        }
        return out;
      }
      case 'contentBlockStop':
        return [{ type: 'content_end', index: blockIndex(body) }];
      case 'messageStop': {
        const raw = str(body.stopReason) ?? 'end_turn';
        return [
          ...this.#start(),
          {
            type: 'finish',
            finishReason: FINISH_FROM_BEDROCK[raw] ?? 'other',
            rawFinishReason: raw,
          },
        ];
      }
      case 'metadata': {
        const usage = converseUsage(body.usage);
        if (!usage) return [];
        this.#usage = usage;
        return [{ type: 'usage', usage }];
      }
      default:
        return [];
    }
  }

  get usage(): CanonicalUsage | undefined {
    return this.#usage;
  }
}

// ───────────── adapter ─────────────

const trimSlash = (url: string) => url.replace(/\/+$/, '');

function bedrockRegion(ctx: BuildContext): string {
  const region = ctx.provider.options.region;
  if (typeof region === 'string' && region) return region;
  return process.env.AWS_REGION ?? BEDROCK_DEFAULT_REGION;
}

export class BedrockAdapter implements ProviderAdapter {
  readonly type = 'bedrock' as const;

  buildRequest(ctx: BuildContext): UpstreamRequest {
    const body = JSON.stringify(
      canonicalToConverseRequest(ctx.request, ctx.model.upstreamModel, ctx.onDrop, {
        structuredOutput: bedrockStructuredOutputMode(
          ctx.model.upstreamModel,
          ctx.provider.options.structuredOutput,
        ),
      }),
    );
    const action = ctx.request.stream ? 'converse-stream' : 'converse';
    const url = `${trimSlash(ctx.provider.baseUrl)}/model/${encodeURIComponent(ctx.model.upstreamModel)}/${action}`;
    const region = bedrockRegion(ctx);
    const parsed = parseAwsCredentials(ctx.apiKey);
    const fallbackToken = ctx.provider.options.sessionToken;
    // The token inside the credential secret wins: it belongs to that exact key pair.
    const credentials: AwsCredentials =
      !parsed.sessionToken && typeof fallbackToken === 'string' && fallbackToken
        ? { ...parsed, sessionToken: fallbackToken }
        : parsed;
    const headers = signAwsRequest({
      method: 'POST',
      url,
      body,
      region,
      credentials,
      headers: {
        'content-type': 'application/json',
        accept: ctx.request.stream ? 'application/vnd.amazon.eventstream' : 'application/json',
        ...ctx.credentialHeaders,
      },
    });
    return { url, method: 'POST', headers, body };
  }

  parseResponse(json: unknown, model = 'bedrock'): CanonicalResponse {
    return converseResponseToCanonical(json, model);
  }

  createStreamDecoder(model = 'bedrock'): StreamDecoder {
    return new BedrockDecoder(model);
  }

  classifyError(input: HttpErrorInput): ClassifiedError {
    const message = input.body.slice(0, 500);
    const base = { status: input.status, message };
    if (/ThrottlingException|TooManyRequestsException/i.test(message))
      return classified('rate_limit', { ...base, upstreamType: 'ThrottlingException' });
    if (/ModelStreamErrorException|InternalServerException/i.test(message))
      return classified('server', { ...base, upstreamType: 'InternalServerException' });
    if (/ValidationException/i.test(message))
      return classified('bad_request', { ...base, upstreamType: 'ValidationException' });
    if (/AccessDenied|UnrecognizedClient|InvalidSignature/i.test(message))
      return classified('auth', { ...base, upstreamType: 'AccessDenied' });
    if (/ResourceNotFoundException/i.test(message))
      return classified('not_found', { ...base, upstreamType: 'ResourceNotFoundException' });
    if (/ModelTimeoutException/i.test(message)) return classified('timeout', base);
    return classifyHttpError(input);
  }

  listModelsRequest(_provider: unknown, _apiKey: string): UpstreamRequest {
    // Bedrock model discovery lives in control-api with the Bedrock control-plane API; the gateway
    // only needs the runtime endpoint.
    throw new Error('bedrock model discovery is handled by the control plane');
  }

  parseModelList(): string[] {
    return [];
  }
}
