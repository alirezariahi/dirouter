/**
 * Native provider pass-through (card 30.7): `/passthrough/{provider}/{path}` forwards a request
 * DiRouter does not translate (batches, files, legacy completions, a provider's own API) to the
 * provider's base URL, unchanged, behind the same virtual key.
 *
 * What still applies, exactly as for translated traffic:
 * - virtual-key authentication (expiry, IP allow-list) and the key's own pass-through grant
 *   (`passthroughProviders`: provider slugs or `*`; empty, the default, means off);
 * - the provider's path allow-list (`options.passthroughPaths`; empty means nothing is allowed);
 * - the data policy (ZDR, training, region, country; card 32.5) on the named provider, refused
 *   with `no_provider_matches_data_policy` like the translated path;
 * - rate limits (RPM and TPM), budgets and the key's concurrency cap, through the same admission
 *   as chat (spend-guard.ts) with the provider's credentials as the candidates: provider and
 *   credential budgets and quota windows (card 32.6), model, end-user (and its block), tag and
 *   cost-center limits included;
 * - request guardrails on the JSON body (block and redact), and response guardrails on a JSON
 *   answer (streams and binary answers flow through unchanged);
 * - a usage event per request (inbound API `passthrough`), however it ends (a client that goes
 *   away mid-stream too), with the attribution of the request.
 *
 * Pricing: a request that names a model (body `model`, a Gemini `/models/{model}:` path or an Azure
 * deployment) must name one configured on that provider, or it is refused with `model_not_found`
 * as on the translated path. The price is that model's, else the model the answer names (dated
 * versions such as `gpt-4o-mini-2024-07-18` match their base model). Usage for a model nobody
 * configured is priced at the provider's dearest configured model, never as free. OpenAI-style
 * streams are asked for their usage (`stream_options.include_usage`, as the translated path does);
 * the usage chunk is taken out again for a client that did not ask for it. Usage a stream does not
 * report (cut off, or none sent) is estimated from the streamed text, and the event says so.
 *
 * The client's DiRouter key never reaches the provider: only an allow-list of request headers is
 * forwarded, `?key=` is dropped, and the credential's own authentication is added instead.
 * Prepaid (wallet) keys are refused, since the cost cannot be reserved before the call.
 */
import { pipeline, Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import {
  type CanonicalUsage,
  type CredentialConfig,
  type ModelConfig,
  type ProviderConfig,
  type ProviderType,
  type UsageEvent,
  USAGE_EVENT_SCHEMA_VERSION,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { computeCost, computeCostUsd, roughTokens } from '@dirouter/model-catalog';
import {
  adapterForProvider,
  classifyNetworkError,
  protocolPresetOf,
  type UpstreamRequest,
} from '@dirouter/providers';
import { type Candidate, dataPolicyViolation } from '@dirouter/routing';
import {
  DiRouterError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ulid,
  UpstreamError,
} from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { attributionFields, requestAttribution } from './attribution.js';
import { authenticate, extractApiKey } from './auth.js';
import { resolveCredentialKey } from './credential-tokens.js';
import { evaluateGuardrails, policiesFor } from './guardrails.js';
import { chargeUsd } from './pricing.js';
import { errorPayload, type ProxyDeps } from './proxy.js';
import { planErrorToClient, routingFromRequest } from './route-request.js';
import { admitRequest } from './spend-guard.js';
import { callUpstream, mergeTimeouts, UpstreamTimeout } from './upstream.js';

export const PASSTHROUGH_PREFIX = '/passthrough/';
/** Bytes kept from the start of a non-SSE answer for usage; the rest still reaches the client. */
const MAX_CAPTURE = 1_048_576;
/** Bytes kept from the end of a non-SSE answer, where usage usually is. */
const MAX_TAIL = 65_536;
/** A JSON answer held for response guardrails may not be larger than this. */
const MAX_GUARDED_ANSWER = 4 * 1_048_576;
const MAX_BODY = 20 * 1_048_576;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** Bedrock signs every request with SigV4 and plugins own their transport: nothing to inject. */
const UNSUPPORTED: readonly ProviderType[] = ['bedrock', 'plugin'];

/** The only client headers that reach the provider; credentials are never among them. */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'openai-beta',
  'idempotency-key',
] as const;
const FORWARDED_RESPONSE_HEADERS =
  /^(content-type|content-disposition|cache-control|retry-after|x-ratelimit-[a-z0-9-]+|anthropic-ratelimit-[a-z0-9-]+)$/;

/** The provider's path allow-list (`options.passthroughPaths`). */
export function passthroughPaths(provider: ProviderConfig): string[] {
  const raw = provider.options.passthroughPaths;
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
}

/** One allow-list entry: `[METHOD ]/path`, where a trailing `*` matches any rest. */
export const PASSTHROUGH_PATH_PATTERN = /^(?:(GET|POST|PUT|PATCH|DELETE) )?(\/[\x21-\x7e]*)$/;

export function pathAllowed(patterns: readonly string[], method: string, path: string): boolean {
  for (const entry of patterns) {
    const match = PASSTHROUGH_PATH_PATTERN.exec(entry.trim());
    if (!match) continue;
    const [, verb, pattern = ''] = match;
    if (verb && verb !== method) continue;
    if (pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern)
      return true;
  }
  return false;
}

/**
 * A path that cannot climb out of the provider's base URL: printable ASCII, no `.`/`..`
 * segments, no empty segments, and no encoded slash, backslash, dot or NUL.
 */
export function safePath(path: string): boolean {
  if (!path.startsWith('/') || path.length > 2_048) return false;
  if (!/^[\x21-\x7e]+$/.test(path)) return false;
  if (/%(2e|2f|5c|00)/i.test(path) || path.includes('\\') || path.includes('//')) return false;
  return !path.split('/').some((segment) => segment === '.' || segment === '..');
}

export function keyMayPassthrough(key: VirtualKeyConfig, providerSlug: string): boolean {
  const grants = key.passthroughProviders;
  return grants.includes('*') || grants.includes(providerSlug);
}

/** The upstream URL, or undefined when it would leave the provider's base URL. */
export function upstreamUrl(baseUrl: string, path: string, query: string): string | undefined {
  const base = new URL(baseUrl);
  const params = new URLSearchParams(query);
  // A Gemini-style client key in the query string is DiRouter's key, never the provider's.
  params.delete('key');
  const qs = params.toString();
  const target = new URL(`${baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`);
  const basePath = base.pathname.replace(/\/+$/, '');
  if (target.origin !== base.origin) return undefined;
  if (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) return undefined;
  return target.toString();
}

// ───────────── usage in the answer ─────────────

interface Found {
  usage: Partial<CanonicalUsage>;
  model?: string;
}

const num = (value: unknown) => (typeof value === 'number' && value >= 0 ? value : undefined);
const record = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function readUsageObject(raw: Record<string, unknown>): Partial<CanonicalUsage> {
  const out: Partial<CanonicalUsage> = {};
  // Gemini: usageMetadata.
  if (num(raw.promptTokenCount) !== undefined || num(raw.candidatesTokenCount) !== undefined) {
    out.inputTokens = num(raw.promptTokenCount) ?? 0;
    out.outputTokens = (num(raw.candidatesTokenCount) ?? 0) + (num(raw.thoughtsTokenCount) ?? 0);
    if (num(raw.cachedContentTokenCount)) out.cacheReadTokens = num(raw.cachedContentTokenCount);
    if (num(raw.thoughtsTokenCount)) out.reasoningTokens = num(raw.thoughtsTokenCount);
    return out;
  }
  // OpenAI chat and legacy completions.
  if (num(raw.prompt_tokens) !== undefined || num(raw.completion_tokens) !== undefined) {
    out.inputTokens = num(raw.prompt_tokens) ?? 0;
    out.outputTokens = num(raw.completion_tokens) ?? 0;
    const cached = num(record(raw.prompt_tokens_details)?.cached_tokens);
    if (cached) out.cacheReadTokens = cached;
    const reasoning = num(record(raw.completion_tokens_details)?.reasoning_tokens);
    if (reasoning) out.reasoningTokens = reasoning;
    return out;
  }
  // Anthropic (input excludes cache reads and writes) and the OpenAI Responses API.
  if (num(raw.input_tokens) !== undefined || num(raw.output_tokens) !== undefined) {
    const cacheRead = num(raw.cache_read_input_tokens) ?? 0;
    const cacheWrite = num(raw.cache_creation_input_tokens) ?? 0;
    const responsesCached = num(record(raw.input_tokens_details)?.cached_tokens);
    const input = num(raw.input_tokens);
    if (input !== undefined) out.inputTokens = input + cacheRead + cacheWrite;
    const output = num(raw.output_tokens);
    if (output !== undefined) out.outputTokens = output;
    if (cacheRead || responsesCached) out.cacheReadTokens = cacheRead || responsesCached;
    if (cacheWrite) out.cacheWriteTokens = cacheWrite;
    const reasoning = num(record(raw.output_tokens_details)?.reasoning_tokens);
    if (reasoning) out.reasoningTokens = reasoning;
  }
  return out;
}

function inspect(json: unknown, found: Found): void {
  const top = record(json);
  if (!top) return;
  for (const holder of [top, record(top.message), record(top.response)]) {
    if (!holder) continue;
    const model = holder.model ?? holder.modelVersion;
    if (typeof model === 'string' && model !== '' && !found.model) found.model = model;
    const usage = record(holder.usage) ?? record(holder.usageMetadata);
    if (!usage) continue;
    // Streams report usage in pieces (Anthropic: input at the start, output at the end); the
    // largest value of each field is the final one.
    for (const [field, value] of Object.entries(readUsageObject(usage)) as [
      keyof CanonicalUsage,
      number,
    ][])
      found.usage[field] = Math.max(found.usage[field] ?? 0, value);
  }
}

/** The JSON object that starts at `start` (a `{`), or undefined when it is cut off. */
function objectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Usage and model in a piece of a JSON answer that does not parse as a whole: the head or the
 * tail of an answer too large to keep. Every complete `usage`/`usageMetadata` object counts.
 */
function inspectFragment(text: string, found: Found): void {
  const model = /"(?:model|modelVersion)"\s*:\s*"([^"\\]{1,200})"/.exec(text);
  if (model?.[1] && !found.model) found.model = model[1];
  for (const match of text.matchAll(/"(usage|usageMetadata)"\s*:\s*\{/g)) {
    const object = objectAt(text, match.index + match[0].length - 1);
    if (!object) continue;
    try {
      inspect({ [match[1] ?? 'usage']: JSON.parse(object) as unknown }, found);
    } catch {
      // Not JSON after all.
    }
  }
}

/** Usage and model reported in a JSON or SSE answer (or a piece of one), if any. */
export function usageFromAnswer(
  contentType: string,
  text: string,
  found: Found = { usage: {} },
): Found {
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) inspectSseLine(line, found);
    return found;
  }
  if (contentType.includes('json'))
    try {
      inspect(JSON.parse(text), found);
    } catch {
      inspectFragment(text, found);
    }
  return found;
}

/** The text an SSE event adds to the answer (OpenAI, Anthropic, Gemini, Responses API). */
function deltaText(json: unknown): string {
  const top = record(json);
  if (!top) return '';
  let out = '';
  const add = (value: unknown) => {
    if (typeof value === 'string') out += value;
  };
  for (const choice of Array.isArray(top.choices) ? top.choices : []) {
    const c = record(choice);
    add(c?.text);
    const delta = record(c?.delta);
    add(delta?.content);
    add(delta?.reasoning_content);
    for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : [])
      add(record(record(call)?.function)?.arguments);
  }
  const delta = record(top.delta);
  add(delta?.text);
  add(delta?.partial_json);
  add(delta?.thinking);
  if (typeof top.type === 'string' && top.type.endsWith('.delta')) add(top.delta);
  for (const candidate of Array.isArray(top.candidates) ? top.candidates : [])
    for (const part of (record(record(candidate)?.content)?.parts as unknown[] | undefined) ?? [])
      add(record(part)?.text);
  return out;
}

/** One SSE line: usage and model of a `data:` event; returns the event's JSON, if any. */
function inspectSseLine(line: string, found: Found): unknown {
  if (!line.startsWith('data:')) return undefined;
  const data = line.slice(5).trim();
  if (data === '' || data === '[DONE]') return undefined;
  try {
    const json: unknown = JSON.parse(data);
    inspect(json, found);
    return json;
  } catch {
    // A truncated or non-JSON event carries nothing to count.
    return undefined;
  }
}

/**
 * Reads usage from an answer as it streams past, without holding it. An SSE answer is parsed event
 * by event over its whole length, so usage at the end of a long stream (Anthropic `message_delta`,
 * OpenAI's final usage chunk) is never lost, and the text it carries is counted for an estimate
 * when the stream stops early or reports no usage. Any other answer keeps its first MAX_CAPTURE
 * bytes and its last MAX_TAIL bytes, and usage is read from both.
 */
export class AnswerMeter {
  private readonly found: Found = { usage: {} };
  private readonly sse: boolean;
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private skipLine = false;
  private outputText = 0;
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail = Buffer.alloc(0);
  private total = 0;

  constructor(private readonly contentType: string) {
    this.sse = contentType.includes('text/event-stream');
  }

  push(chunk: Buffer): void {
    if (this.sse) {
      this.pending += this.decoder.write(chunk);
      let newline = this.pending.indexOf('\n');
      while (newline >= 0) {
        const line = this.pending.slice(0, newline);
        this.pending = this.pending.slice(newline + 1);
        if (this.skipLine) this.skipLine = false;
        else this.line(line);
        newline = this.pending.indexOf('\n');
      }
      // A single event larger than this is not inspected (and never held).
      if (this.pending.length > MAX_CAPTURE) {
        this.pending = '';
        this.skipLine = true;
      }
      return;
    }
    this.total += chunk.length;
    if (this.headBytes < MAX_CAPTURE) {
      const part = chunk.subarray(0, MAX_CAPTURE - this.headBytes);
      this.head.push(part);
      this.headBytes += part.length;
    }
    if (this.total > MAX_CAPTURE) {
      const joined = Buffer.concat([this.tail, chunk]);
      this.tail = joined.subarray(Math.max(0, joined.length - MAX_TAIL));
    }
  }

  private line(raw: string): void {
    const json = inspectSseLine(raw.replace(/\r$/, ''), this.found);
    if (json !== undefined) this.outputText += roughTokens(deltaText(json));
  }

  /** Usage and model found, and the output tokens the streamed text amounts to. */
  result(): { found: Found; streamedTokens: number } {
    if (this.sse) {
      if (!this.skipLine && this.pending !== '') this.line(this.pending + this.decoder.end());
      this.pending = '';
      return { found: this.found, streamedTokens: this.outputText };
    }
    const head = Buffer.concat(this.head).toString('utf8');
    usageFromAnswer(this.contentType, head, this.found);
    // The tail starts after the head ends only when the answer was larger than both together.
    if (this.total > MAX_CAPTURE)
      usageFromAnswer(this.contentType, this.tail.toString('utf8'), this.found);
    return { found: this.found, streamedTokens: 0 };
  }
}

/** A version or date after a model name: `-2024-07-18`, `-20241022`, `-001`, `-latest`. */
const VERSION_SUFFIX = /^(?:\d[\d.-]*|latest)$/;

/**
 * The configured model of this provider for the first of `names` that names one: its upstream name
 * or slug exactly, or a dated or versioned name of it (`gpt-4o-mini-2024-07-18`,
 * `gemini-2.0-flash-001`, `models/…`), the longest matching name winning.
 */
export function findModel(
  models: readonly ModelConfig[],
  provider: Pick<ProviderConfig, 'id'>,
  names: readonly (string | undefined)[],
): ModelConfig | undefined {
  const own = models.filter((m) => m.providerId === provider.id);
  for (const name of names) {
    if (!name) continue;
    const bare = name.replace(/^models\//, '');
    const exact = own.find((m) => m.upstreamModel === bare || m.slug === bare);
    if (exact) return exact;
    let best: ModelConfig | undefined;
    for (const m of own) {
      const prefix = `${m.upstreamModel}-`;
      if (
        m.upstreamModel !== '' &&
        bare.startsWith(prefix) &&
        VERSION_SUFFIX.test(bare.slice(prefix.length)) &&
        (!best || m.upstreamModel.length > best.upstreamModel.length)
      )
        best = m;
    }
    if (best) return best;
  }
  return undefined;
}

/** The model a request names: the body's `model`, a Gemini path or an Azure deployment. */
export function namedModel(requested: Record<string, unknown> | undefined, path: string) {
  if (typeof requested?.model === 'string' && requested.model !== '') return requested.model;
  const gemini = /\/models\/([^/:]+):[A-Za-z]+$/.exec(path);
  if (gemini?.[1]) return decodeURIComponent(gemini[1]);
  const azure = /\/deployments\/([^/]+)\//.exec(path);
  return azure?.[1] ? decodeURIComponent(azure[1]) : undefined;
}

/** Provider types that speak OpenAI's chat and completions streams. */
const OPENAI_STREAMS: readonly ProviderType[] = ['openai', 'azure-openai', 'openai-compatible'];

/**
 * An OpenAI-style stream carries usage only when `stream_options.include_usage` is set, so the
 * body sent upstream asks for it, as the translated path always does (translator `openai.ts`).
 * Returns the new body, and whether the client asked for usage itself (when it did not, the usage
 * chunk is taken out of the stream it receives); undefined when nothing needs to change.
 */
export function withStreamUsage(
  provider: Pick<ProviderConfig, 'type' | 'options'>,
  path: string,
  requested: Record<string, unknown> | undefined,
  body: Buffer,
): { body: Buffer; clientWantsUsage: false } | undefined {
  if (requested?.stream !== true) return undefined;
  if (!OPENAI_STREAMS.includes(provider.type) || protocolPresetOf(provider)) return undefined;
  if (!/\/(?:chat\/)?completions$/.test(path)) return undefined;
  if (record(requested.stream_options)?.include_usage === true) return undefined;
  let json: Record<string, unknown> | undefined;
  try {
    json = record(JSON.parse(body.toString('utf8')));
  } catch {
    return undefined;
  }
  if (!json) return undefined;
  json.stream_options = { ...record(json.stream_options), include_usage: true };
  return { body: Buffer.from(JSON.stringify(json)), clientWantsUsage: false };
}

const EVENT_END = /\r?\n\r?\n/;

/** Takes OpenAI's usage-only chunk (`choices: []` with `usage`) out of an SSE stream. */
export function dropUsageChunks(): Transform {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const keep = (event: string) => {
    const data = event
      .split(/\r?\n/)
      .find((line) => line.startsWith('data:'))
      ?.slice(5)
      .trim();
    if (!data || data === '[DONE]') return true;
    try {
      const json = record(JSON.parse(data));
      return !(json?.usage && Array.isArray(json.choices) && json.choices.length === 0);
    } catch {
      return true;
    }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += decoder.write(chunk);
      let out = '';
      let end = EVENT_END.exec(pending);
      while (end) {
        const event = pending.slice(0, end.index + end[0].length);
        pending = pending.slice(end.index + end[0].length);
        if (keep(event)) out += event;
        end = EVENT_END.exec(pending);
      }
      callback(null, out === '' ? undefined : out);
    },
    flush(callback) {
      const rest = pending + decoder.end();
      callback(null, rest !== '' && keep(rest) ? rest : undefined);
    },
  });
}

// ───────────── guardrails on raw JSON ─────────────

interface Leaf {
  holder: Record<string, unknown> | unknown[];
  key: string | number;
}

/** Every string value of a JSON document (except `model`), for guardrails to read and rewrite. */
function stringLeaves(value: unknown, out: Leaf[] = []): Leaf[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === 'string') out.push({ holder: value, key: index });
      else stringLeaves(item, out);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'model') continue;
      if (typeof item === 'string') out.push({ holder: value as Record<string, unknown>, key });
      else stringLeaves(item, out);
    }
  }
  return out;
}

const leafGet = (leaf: Leaf) =>
  Array.isArray(leaf.holder)
    ? (leaf.holder[leaf.key as number] as string)
    : (leaf.holder[leaf.key as string] as string);
const leafSet = (leaf: Leaf, text: string) => {
  if (Array.isArray(leaf.holder)) leaf.holder[leaf.key as number] = text;
  else leaf.holder[leaf.key as string] = text;
};

type GuardOutcome = { blocked: string } | { body: Buffer | undefined; redactions: number };

/** Request or response guardrails over the string values of a JSON body. */
export function guardJson(
  policies: Parameters<typeof evaluateGuardrails>[0],
  stage: 'request' | 'response',
  body: Buffer,
): GuardOutcome {
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return { body, redactions: 0 };
  }
  const leaves = stringLeaves(json);
  if (leaves.length === 0) return { body, redactions: 0 };
  const parts = leaves.map((leaf) => ({ type: 'text' as const, text: leafGet(leaf) }));
  const result =
    stage === 'request'
      ? evaluateGuardrails(policies, {
          stage,
          request: {
            inboundApi: 'openai.chat',
            model: '',
            system: [],
            messages: [{ role: 'user', content: parts }],
            stream: false,
          },
        })
      : evaluateGuardrails(policies, {
          stage,
          response: {
            id: 'passthrough',
            model: '',
            content: parts,
            finishReason: 'stop',
            created: 0,
          },
        });
  if (result.blocked) return { blocked: result.blocked.message };
  if (result.redactions === 0) return { body, redactions: 0 };
  // The engine rewrote the parts in place; copy them back into the document.
  leaves.forEach((leaf, i) => {
    const part = parts[i];
    if (part) leafSet(leaf, part.text);
  });
  return { body: Buffer.from(JSON.stringify(json)), redactions: result.redactions };
}

// ───────────── route ─────────────

function sendError(reply: FastifyReply, error: DiRouterError, requestId: string) {
  if (error instanceof RateLimitError && error.retryAfterMs !== undefined)
    void reply.header('retry-after', String(Math.ceil(error.retryAfterMs / 1000)));
  return reply.status(error.status).send(errorPayload('openai.chat', error, requestId));
}

/** The provider's enabled credentials that health has not taken out. */
function usableCredentials(provider: ProviderConfig, deps: ProxyDeps): CredentialConfig[] {
  const health = deps.store.healthRegistry;
  return provider.credentials.filter(
    (c) => c.enabled && c.weight > 0 && health.credentialDisabledReason(c.id) === undefined,
  );
}

/**
 * The credential to call: the first in order for `fill-first` and `reset-aware` providers (the
 * admission already put the one whose quota resets soonest first), else a weighted pick.
 */
function pickCandidate(provider: ProviderConfig, candidates: readonly Candidate[]) {
  if (provider.credentialStrategy && provider.credentialStrategy !== 'weighted')
    return candidates[0];
  const total = candidates.reduce((sum, c) => sum + c.credential.weight, 0);
  let roll = Math.random() * total;
  for (const candidate of candidates) {
    roll -= candidate.credential.weight;
    if (roll < 0) return candidate;
  }
  return candidates[0];
}

/**
 * The model a request without one counts against in admission: it matches no model scope, so
 * only the key, request, provider and credential limits apply.
 */
function unnamedModel(provider: ProviderConfig): ModelConfig {
  return {
    id: `passthrough:${provider.id}`,
    organizationId: provider.organizationId,
    slug: `passthrough-${provider.slug}`,
    providerId: provider.id,
    upstreamModel: '',
    enabled: true,
    pricing: { inputPerMTok: '0', outputPerMTok: '0' },
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      jsonMode: false,
      embeddings: false,
    },
  };
}

/** Of the provider's configured models, the one that charges the most for this usage. */
function dearestModel(
  models: readonly ModelConfig[],
  provider: ProviderConfig,
  usage: CanonicalUsage,
): ModelConfig | undefined {
  let best: { model: ModelConfig; cost: bigint } | undefined;
  for (const model of models) {
    if (model.providerId !== provider.id) continue;
    const cost = computeCost(usage, model.pricing).total;
    if (!best || cost > best.cost) best = { model, cost };
  }
  return best?.model;
}

interface EventBase {
  requestId: string;
  started: number;
  key: VirtualKeyConfig;
  provider: ProviderConfig;
  requestedModel: string;
  stream: boolean;
}

/** The fields of a pass-through usage event that do not depend on the answer. */
function baseEvent(
  deps: ProxyDeps,
  config: { version: number },
  e: EventBase,
): Omit<
  UsageEvent,
  | 'resolvedModelId'
  | 'credentialId'
  | 'status'
  | 'httpStatus'
  | 'usage'
  | 'costUsd'
  | 'chargeUsd'
  | 'usageEstimated'
  | 'attempts'
> {
  return {
    schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
    eventId: ulid(),
    idempotencyKey: e.requestId,
    requestId: e.requestId,
    occurredAt: new Date(e.started).toISOString(),
    gatewayInstance: deps.instance,
    configVersion: config.version,
    organizationId: e.key.organizationId,
    teamId: e.key.teamId,
    projectId: e.key.projectId,
    virtualKeyId: e.key.id,
    inboundApi: 'passthrough',
    requestedModel: e.requestedModel,
    providerId: e.provider.id,
    stream: e.stream,
    latencyMs: Date.now() - e.started,
  };
}

/** The usage event of a request that failed before any provider was called. */
function emitFailure(
  deps: ProxyDeps,
  config: { version: number },
  e: EventBase & { slug: string; status: number; errorCode: string },
): void {
  const event: UsageEvent = {
    ...baseEvent(deps, config, e),
    resolvedModelId: null,
    credentialId: null,
    status: 'error',
    httpStatus: e.status,
    errorCode: e.errorCode,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    costUsd: '0',
    chargeUsd: '0.00000000',
    usageEstimated: false,
    attempts: [],
  };
  deps.metrics?.observe({ ...event, requestedModel: `passthrough:${e.slug}` });
  deps.onRequestComplete?.(event);
  deps.emitUsage(event);
}

export async function handlePassthrough(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<unknown> {
  const requestId = req.id;
  const started = Date.now();
  const config = deps.store.current;
  if (!config)
    return sendError(
      reply,
      new DiRouterError('service_unavailable', { message: 'Gateway has no configuration yet' }),
      requestId,
    );

  // The raw URL, so the path reaches the provider exactly as the client encoded it.
  const rawUrl = req.raw.url ?? '';
  const queryAt = rawUrl.indexOf('?');
  const pathname = queryAt >= 0 ? rawUrl.slice(0, queryAt) : rawUrl;
  const query = queryAt >= 0 ? rawUrl.slice(queryAt + 1) : '';
  const rest = pathname.slice(PASSTHROUGH_PREFIX.length);
  const slash = rest.indexOf('/');
  const slug = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash) : '/';
  const method = req.method.toUpperCase();

  let key: VirtualKeyConfig;
  try {
    key = authenticate(
      config,
      extractApiKey(req.headers, new URLSearchParams(query).get('key') ?? undefined),
      deps.pepper,
      req.ip,
    );
  } catch (error) {
    return sendError(
      reply,
      error instanceof DiRouterError ? error : new DiRouterError('unauthenticated'),
      requestId,
    );
  }
  if (!keyMayPassthrough(key, slug))
    return sendError(
      reply,
      new ForbiddenError('forbidden', {
        message: `This key may not use pass-through to '${slug}'`,
      }),
      requestId,
    );
  const provider = config.snapshot.providers.find(
    (p) => p.organizationId === key.organizationId && p.slug === slug && p.enabled,
  );
  if (!provider)
    return sendError(
      reply,
      new NotFoundError('not_found', { message: `Provider '${slug}' not found` }),
      requestId,
    );
  if (UNSUPPORTED.includes(provider.type))
    return sendError(
      reply,
      new DiRouterError('invalid_request', {
        message: `Pass-through is not available for ${provider.type} providers`,
      }),
      requestId,
    );
  if (!(METHODS as readonly string[]).includes(method))
    return sendError(
      reply,
      new DiRouterError('invalid_request', {
        message: `Method ${method} is not supported`,
        status: 405,
      }),
      requestId,
    );
  if (!safePath(path))
    return sendError(
      reply,
      new DiRouterError('invalid_request', { message: 'Invalid pass-through path' }),
      requestId,
    );
  if (!pathAllowed(passthroughPaths(provider), method, path))
    return sendError(
      reply,
      new ForbiddenError('forbidden', {
        message: `${method} ${path} is not in the pass-through allow-list of '${slug}'`,
      }),
      requestId,
    );
  if (key.walletId)
    return sendError(
      reply,
      new ForbiddenError('forbidden', {
        message: 'Pass-through is not available to prepaid keys: its cost cannot be reserved',
      }),
      requestId,
    );
  const url = upstreamUrl(provider.baseUrl, path, query);
  if (!url)
    return sendError(
      reply,
      new DiRouterError('invalid_request', { message: 'Invalid pass-through path' }),
      requestId,
    );

  let body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
  const contentType = req.headers['content-type'] ?? '';
  const isJson = contentType.includes('json');
  let requested: Record<string, unknown> | undefined;
  if (body && isJson)
    try {
      requested = record(JSON.parse(body.toString('utf8')));
    } catch {
      requested = undefined;
    }

  // A request for a model must name one this provider has a price for: like the translated path,
  // which refuses a model that is not configured, so a pass-through call is never billed as free.
  const named = namedModel(requested, path);
  const namedConfig = named ? findModel(config.snapshot.models, provider, [named]) : undefined;
  if (named && !namedConfig)
    return sendError(
      reply,
      new NotFoundError('model_not_found', {
        message: `Model '${named.slice(0, 200)}' is not configured on provider '${slug}'`,
        param: 'model',
      }),
      requestId,
    );
  const requestedModel = (named ?? `${slug}${path}`).slice(0, 200);

  // The data policy (card 32.5) of the organization, project, key and request, applied to the one
  // provider named; refused with the same error as the translated path.
  let dataPolicy;
  try {
    dataPolicy = routingFromRequest(
      config.snapshot.routingPolicies,
      key,
      requested ?? {},
    ).dataPolicy;
  } catch (error) {
    return sendError(reply, error as DiRouterError, requestId);
  }
  const admissionModel = namedConfig ?? unnamedModel(provider);
  const violation = dataPolicy ? dataPolicyViolation(provider, dataPolicy) : undefined;
  if (violation) {
    deps.logger.info(
      { requestId, provider: provider.slug, dataPolicy, reason: violation },
      'pass-through provider does not satisfy the data policy',
    );
    return sendError(
      reply,
      planErrorToClient(
        {
          error: 'no_provider_matches_data_policy',
          skipped: [{ modelId: admissionModel.id, reason: violation }],
        },
        requestedModel,
      ),
      requestId,
    );
  }

  // Guardrails (card 15.1) on the string values of a JSON body; a blocked request never leaves.
  const policies = policiesFor(config.snapshot.guardrails, key);
  if (body && isJson && policies.length > 0) {
    const guard = guardJson(policies, 'request', body);
    if ('blocked' in guard) {
      deps.metrics?.reject('guardrail', 'passthrough');
      return sendError(
        reply,
        new DiRouterError('invalid_request', { message: guard.blocked, status: 400 }),
        requestId,
      );
    }
    body = guard.body;
  }

  const stream =
    requested?.stream === true || (req.headers.accept ?? '').includes('text/event-stream');
  // An OpenAI-style stream asks for its usage, or it would be free.
  const usageAsked = body ? withStreamUsage(provider, path, requested, body) : undefined;
  if (usageAsked) body = usageAsked.body;

  const credentials = usableCredentials(provider, deps);
  if (credentials.length === 0) {
    emitFailure(deps, config, {
      requestId,
      started,
      key,
      provider,
      requestedModel,
      stream,
      slug,
      status: 503,
      errorCode: 'no_credential',
    });
    return sendError(
      reply,
      new DiRouterError('service_unavailable', {
        message: `Provider '${slug}' has no usable credential`,
      }),
      requestId,
    );
  }

  // Rate limits and budgets (spend-guard.ts), as for chat: the provider's credentials are the
  // candidates, so key, project, team, organization, member, end-user, tag, cost-center, model,
  // provider and credential limits all apply (cards 6.1, 25.5, 32.6, 33.1-33.4), the end-user
  // block too, and a used-up credential budget or quota window leaves the other credentials.
  const attribution = requestAttribution(
    req.headers,
    requested?.user ?? record(requested?.metadata)?.user_id,
    key,
  );
  const admission = await admitRequest(deps, {
    config,
    key,
    candidates: credentials.map((credential) => ({
      model: admissionModel,
      provider,
      credential,
    })),
    requested: requestedModel,
    estimatedTokens: Math.ceil((body?.length ?? 0) / 4),
    requestId,
    attribution,
  });
  if (!admission.ok) {
    deps.metrics?.reject(admission.metric.guard, admission.metric.reason);
    for (const [name, value] of Object.entries(admission.headers)) void reply.header(name, value);
    return sendError(reply, admission.error, requestId);
  }
  const candidate = pickCandidate(provider, admission.candidates);
  if (!candidate) {
    admission.cancel();
    return sendError(reply, new UpstreamError('no_available_provider'), requestId);
  }
  const credential = candidate.credential;

  const clientGone = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) clientGone.abort(new Error('client disconnected'));
  });
  const onShutdown = () => {
    clientGone.abort(new Error('gateway shutting down'));
  };
  deps.lifecycle?.signal.addEventListener('abort', onShutdown, { once: true });
  const keyBulkhead = deps.bulkheads?.get(`key:${key.id}`, key.rateLimit?.maxConcurrency, {});
  const releaseKey = keyBulkhead ? await keyBulkhead.acquire(clientGone.signal) : () => undefined;

  let settled = false;
  /** Prices, records and releases the request; runs once, whatever way it ends. */
  const finish = (outcome: {
    status: number;
    ok: boolean;
    errorCode?: string;
    credentialId: string | null;
    found?: Found;
    /** Output tokens of the text streamed to the client, for an estimate. */
    streamedTokens?: number;
    /** The answer reached the client whole. */
    complete?: boolean;
  }) => {
    if (settled) return;
    settled = true;
    const found = outcome.found ?? { usage: {} };
    const streamed = outcome.streamedTokens ?? 0;
    // Usage the answer does not report (a stream cut off, or one without usage) is estimated from
    // the text streamed and the request body, like the translated path does.
    let estimated = false;
    let outputTokens = found.usage.outputTokens;
    if (streamed > (outputTokens ?? 0) && (outputTokens === undefined || !outcome.complete)) {
      outputTokens = streamed;
      estimated = true;
    }
    let inputTokens = found.usage.inputTokens;
    if (inputTokens === undefined && estimated) inputTokens = Math.ceil((body?.length ?? 0) / 4);
    const usage: CanonicalUsage = {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cacheReadTokens: found.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: found.usage.cacheWriteTokens ?? 0,
      reasoningTokens: found.usage.reasoningTokens ?? 0,
    };
    const tokens = usage.inputTokens + usage.outputTokens;
    // The model the request named first, then the one the answer names (a dated version too).
    const model = findModel(config.snapshot.models, provider, [named, found.model]);
    // Usage for a model nobody configured is priced at the provider's dearest model, never free.
    const priced =
      model ?? (tokens > 0 ? dearestModel(config.snapshot.models, provider, usage) : undefined);
    if (!model && tokens > 0)
      deps.logger.warn(
        { requestId, provider: provider.slug, answeredModel: found.model, pricedAs: priced?.id },
        priced
          ? 'pass-through usage for an unconfigured model, priced at the dearest model of the provider'
          : 'pass-through usage on a provider without configured models is not priced',
      );
    const costUsd = priced ? computeCostUsd(usage, priced.pricing) : '0';
    const charged = priced
      ? chargeUsd(usage, priced, { groupMultiplier: key.priceMultiplier })
      : '0.00000000';
    const event: UsageEvent = {
      ...baseEvent(deps, config, { requestId, started, key, provider, requestedModel, stream }),
      ...attributionFields(attribution),
      resolvedModelId: model?.id ?? null,
      credentialId: outcome.credentialId,
      status: outcome.ok ? 'success' : 'error',
      httpStatus: outcome.status,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      usage,
      costUsd,
      chargeUsd: charged,
      usageEstimated: estimated,
      attempts: outcome.credentialId
        ? [
            {
              providerId: provider.id,
              modelId: model?.id ?? '',
              credentialId: outcome.credentialId,
              outcome: outcome.ok ? 'success' : 'error',
              httpStatus: outcome.status,
              ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
              latencyMs: Date.now() - started,
              startedAt: new Date(started).toISOString(),
            },
          ]
        : [],
    };
    // Metrics label by model; a path (with file or batch ids) would explode their cardinality.
    deps.metrics?.observe(model ? event : { ...event, requestedModel: `passthrough:${slug}` });
    deps.onRequestComplete?.(event);
    deps.emitUsage(event);
    deps.lifecycle?.signal.removeEventListener('abort', onShutdown);
    releaseKey?.();
    admission.finish({
      tokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      candidate,
    });
    deps.logger.info(
      { requestId, provider: provider.slug, method, path, status: outcome.status },
      'passthrough request',
    );
  };

  if (!releaseKey) {
    deps.lifecycle?.signal.removeEventListener('abort', onShutdown);
    admission.cancel();
    deps.metrics?.reject('concurrency', 'key');
    return sendError(
      reply,
      new RateLimitError({
        message: `Too many concurrent requests for this key (limit ${String(keyBulkhead?.limit)})`,
        retryAfterMs: 1_000,
      }),
      requestId,
    );
  }

  const settings = config.snapshot.settings;
  const proxyUrl = credential.proxy?.url ?? provider.proxy?.url ?? settings.proxy?.url;
  let apiKey: string;
  try {
    apiKey = await resolveCredentialKey(
      provider,
      credential,
      config.secret(credential.id, credential.secret),
      { signal: clientGone.signal, proxyUrl },
    );
  } catch (error) {
    deps.logger.warn(
      { requestId, provider: provider.slug, error: (error as Error).message },
      'passthrough credential unusable',
    );
    finish({ status: 502, ok: false, errorCode: 'auth', credentialId: credential.id });
    return sendError(
      reply,
      new DiRouterError('upstream_error', { message: 'Provider credential is not usable' }),
      requestId,
    );
  }

  // The credential's authentication, exactly as the adapter sends it for model discovery.
  const auth = adapterForProvider(provider).listModelsRequest(provider, apiKey).headers;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(auth))
    if (name.toLowerCase() !== 'content-type' && name.toLowerCase() !== 'accept')
      headers[name.toLowerCase()] = value;
  for (const [name, value] of Object.entries(credential.headers))
    headers[name.toLowerCase()] = value;
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  if (body && !headers['content-type']) headers['content-type'] = 'application/octet-stream';

  const upstream: UpstreamRequest = {
    url,
    // UpstreamRequest names the methods adapters use; fetch accepts every method checked above.
    method: method as UpstreamRequest['method'],
    headers,
    ...(body && method !== 'GET' ? { bytes: new Uint8Array(body) } : {}),
  };
  const timeouts = mergeTimeouts(settings.defaultTimeouts, provider.timeouts);
  let call;
  try {
    call = await callUpstream(provider, upstream, timeouts, clientGone.signal, stream, proxyUrl);
  } catch (error) {
    const classified = classifyNetworkError(error, error instanceof UpstreamTimeout);
    deps.logger.warn(
      { requestId, provider: provider.slug, error: classified.message },
      'passthrough upstream failed',
    );
    const timeout = classified.class === 'timeout';
    finish({
      status: timeout ? 504 : 502,
      ok: false,
      errorCode: classified.class,
      credentialId: credential.id,
    });
    return sendError(
      reply,
      new DiRouterError(timeout ? 'upstream_timeout' : 'upstream_error', {
        message: timeout ? 'Upstream request timed out' : 'Could not reach the upstream provider',
      }),
      requestId,
    );
  }

  const status = call.response.status;
  const ok = status < 400;
  const answerType = call.response.headers.get('content-type') ?? '';
  for (const [name, value] of call.response.headers)
    if (FORWARDED_RESPONSE_HEADERS.test(name)) void reply.header(name, value);
  void reply.header('x-dirouter-provider', provider.slug);
  void reply.status(status);

  const responsePolicies = policies.filter(
    (p) => p.enabled && (p.stage === 'response' || p.stage === 'both'),
  );
  // A JSON answer is held for response guardrails; streams and binary bodies flow through.
  if (responsePolicies.length > 0 && answerType.includes('json') && ok) {
    let text: Buffer;
    try {
      const bytes = Buffer.from(await call.response.arrayBuffer());
      if (bytes.length > MAX_GUARDED_ANSWER) throw new Error('answer too large for guardrails');
      text = bytes;
    } catch (error) {
      call.done();
      finish({ status: 502, ok: false, errorCode: 'server', credentialId: credential.id });
      deps.logger.warn({ requestId, error: (error as Error).message }, 'passthrough answer lost');
      return sendError(
        reply,
        new DiRouterError('upstream_error', { message: 'Upstream answer could not be checked' }),
        requestId,
      );
    }
    call.done();
    const found = usageFromAnswer(answerType, text.toString('utf8'));
    const guard = guardJson(policies, 'response', text);
    if ('blocked' in guard) {
      finish({
        status: 400,
        ok: false,
        errorCode: 'guardrail',
        credentialId: credential.id,
        found,
      });
      return sendError(
        reply,
        new DiRouterError('invalid_request', { message: guard.blocked, status: 400 }),
        requestId,
      );
    }
    finish({ status, ok, credentialId: credential.id, found });
    return reply.send(guard.body ?? text);
  }

  const upstreamBody = call.response.body;
  if (!upstreamBody) {
    call.done();
    finish({
      status,
      ok,
      ...(ok ? {} : { errorCode: `http_${String(status)}` }),
      credentialId: credential.id,
    });
    return reply.send();
  }
  const meter = new AnswerMeter(answerType);
  const source = Readable.fromWeb(upstreamBody);
  let ended = false;
  let failure: Error | undefined;
  source.on('data', (chunk: Buffer) => {
    call.touch();
    meter.push(chunk);
  });
  source.once('end', () => {
    ended = true;
  });
  source.once('error', (error) => {
    failure = error;
  });
  // The usage chunk the gateway asked for is not the client's, unless it asked for it too.
  const out =
    usageAsked && answerType.includes('text/event-stream')
      ? pipeline(source, dropUsageChunks(), () => undefined)
      : source;
  // 'close' comes last however the stream ends: after 'end', after an upstream error, and when the
  // client goes away (Fastify destroys the stream without an error). Billing and every release
  // happen there, exactly once, for what was streamed so far.
  out.once('close', () => {
    call.done();
    const { found, streamedTokens } = meter.result();
    const gone = !ended && (clientGone.signal.aborted || !failure);
    finish({
      status: gone ? 499 : failure ? 502 : status,
      ok: ok && ended && !failure,
      ...(gone
        ? {
            errorCode: deps.lifecycle?.signal.aborted ? 'shutdown' : 'client_disconnected',
          }
        : failure
          ? { errorCode: failure instanceof UpstreamTimeout ? 'timeout' : 'connection' }
          : ok
            ? {}
            : { errorCode: `http_${String(status)}` }),
      credentialId: credential.id,
      found,
      streamedTokens,
      complete: ended && !failure,
    });
  });
  return reply.send(out);
}

/**
 * Registers `/passthrough/{provider}/*` in its own scope, whose body parser keeps every content
 * type as raw bytes, so the provider receives the body exactly as the client sent it.
 */
export function registerPassthroughRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  void app.register((scope, _opts, next) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_BODY },
      (_req, payload, done) => {
        done(null, payload);
      },
    );
    scope.route({
      method: [...METHODS],
      url: '/passthrough/:provider/*',
      handler: (req, reply) => handlePassthrough(req, reply, deps),
    });
    next();
  });
}
