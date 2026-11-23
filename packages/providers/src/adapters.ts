/**
 * Provider adapters (cards 4.6 and 4.7).
 *
 * Each adapter only knows the "shape" of the request and response; HTTP execution, retry, timeout and
 * proxying live in the gateway. So adapters can be fully tested without a network.
 */
import {
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
  type CanonicalRequest,
  type CanonicalResponse,
  type CanonicalStreamEvent,
  GeminiGenerateContentResponse,
  type ModelConfig,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  type ProviderConfig,
  type ProviderType,
} from '@dirouter/contracts';
import {
  AnthropicStreamDecoder,
  type DropReporter,
  GeminiStreamDecoder,
  OpenAIStreamDecoder,
  type SseEvent,
  anthropicResponseToCanonical,
  canonicalToAnthropicRequest,
  canonicalToGeminiRequest,
  canonicalToOpenAIRequest,
  geminiResponseToCanonical,
  openAIResponseToCanonical,
} from '@dirouter/translator';

import {
  type ClassifiedError,
  type HttpErrorInput,
  classified,
  classifyHttpError,
} from './errors.js';
import { presetFor } from './presets.js';
import { BedrockAdapter } from './bedrock.js';
import { MediaOnlyAdapter } from './media.js';
import { MissingPluginAdapter } from './plugins/adapter.js';

export interface UpstreamRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
  /** Binary body (multipart form or raw audio), sent instead of `body` (card 21.1). */
  bytes?: Uint8Array;
}

export interface BuildContext {
  provider: ProviderConfig;
  model: ModelConfig;
  /** Decrypted credential key (in memory only). */
  apiKey: string;
  /** Extra credential headers. */
  credentialHeaders?: Record<string, string>;
  request: CanonicalRequest;
  /** Client inbound headers (only for controlled pass-through, such as anthropic-beta). */
  clientHeaders?: Record<string, string | undefined>;
  onDrop?: DropReporter;
}

export interface StreamDecoder {
  /** Raw SSE event → canonical events. `[DONE]` and ping are ignored. */
  push(event: SseEvent): CanonicalStreamEvent[];
  /**
   * Binary frame protocols (Bedrock `vnd.amazon.eventstream`): raw response bytes → canonical
   * events. When present the gateway must feed the upstream body here instead of parsing SSE;
   * chunks may be cut anywhere and may carry several frames.
   */
  feedChunk?(chunk: Uint8Array): CanonicalStreamEvent[];
  /**
   * Call once when the upstream body ends (only meaningful together with `feedChunk`): reports a
   * frame that was still incomplete as an `error` event.
   */
  flushChunks?(): CanonicalStreamEvent[];
}

// ───────────── Embeddings (card 11.4) ─────────────

export interface EmbeddingsBuildContext {
  provider: ProviderConfig;
  model: ModelConfig;
  apiKey: string;
  credentialHeaders?: Record<string, string>;
  /** Batch of texts to embed (the gateway rejects token-array input for unsupported providers). */
  texts: string[];
  dimensions?: number;
  encodingFormat?: 'float' | 'base64';
}

/** Upper bound of the public `/v1/embeddings` contract (inputs per request). */
export const EMBEDDING_BATCH_CONTRACT_MAX = 2048;

/**
 * Inputs one upstream embeddings call accepts, per provider type. One adapter call builds exactly
 * one upstream request (no chunking), so the gateway must reject larger batches with a 400.
 * Types that are not listed accept the full contract maximum.
 */
export const MAX_EMBEDDING_BATCH: Readonly<Partial<Record<ProviderType, number>>> = {
  openai: 2048,
  'azure-openai': 2048,
  cohere: 96,
  gemini: 100,
  vertex: 250,
  voyage: 1000,
  jina: 2048,
};

/**
 * Largest embeddings batch for one upstream call. `options.maxEmbeddingBatch` (positive integer)
 * overrides the built-in limit, e.g. for an OpenAI-compatible server with a smaller cap. Vertex
 * `gemini-embedding-*` models take a single input per request, and Vertex regions other than
 * `us-central1` accept 5 texts instead of 250.
 */
export function maxEmbeddingBatch(
  provider: Pick<ProviderConfig, 'type' | 'options'>,
  upstreamModel?: string,
): number {
  const override = provider.options.maxEmbeddingBatch;
  if (typeof override === 'number' && Number.isInteger(override) && override > 0)
    return Math.min(override, EMBEDDING_BATCH_CONTRACT_MAX);
  if (provider.type === 'vertex') {
    if (upstreamModel && geminiModel(upstreamModel).startsWith('gemini-embedding')) return 1;
    const location = provider.options.location;
    if (typeof location === 'string' && location !== VERTEX_DEFAULT_LOCATION) return 5;
  }
  return MAX_EMBEDDING_BATCH[provider.type] ?? EMBEDDING_BATCH_CONTRACT_MAX;
}

export interface EmbeddingsResult {
  vectors: number[][];
  usage?: { inputTokens: number };
}

export interface ProviderAdapter {
  readonly type: ProviderType;
  buildRequest(ctx: BuildContext): UpstreamRequest;
  /** `model` is the upstream name, for providers that do not return it in the response. */
  parseResponse(json: unknown, model?: string): CanonicalResponse;
  createStreamDecoder(model?: string): StreamDecoder;
  classifyError(input: HttpErrorInput): ClassifiedError;
  /** Model list request for model discovery (control-api). */
  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest;
  /** Extract model IDs from a list models response. */
  parseModelList(json: unknown): string[];
  /** Provider supports `/v1/embeddings` (card 11.4). */
  buildEmbeddingsRequest?(ctx: EmbeddingsBuildContext): UpstreamRequest;
  parseEmbeddingsResponse?(json: unknown): EmbeddingsResult;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

function parseOpenAIModels(json: unknown): string[] {
  const data = (json as { data?: { id?: unknown }[] } | undefined)?.data;
  return Array.isArray(data)
    ? data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
    : [];
}

class OpenAIDecoder implements StreamDecoder {
  readonly #inner = new OpenAIStreamDecoder();

  push(event: SseEvent): CanonicalStreamEvent[] {
    if (event.data === '[DONE]' || event.data === '') return [];
    const json = JSON.parse(event.data) as Record<string, unknown>;
    if (json.error) {
      const err = json.error as { message?: unknown; code?: unknown; type?: unknown };
      const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
      return [
        {
          type: 'error',
          code: str(err.code) ?? str(err.type) ?? 'upstream_error',
          message: str(err.message) ?? 'upstream error',
        },
      ];
    }
    return this.#inner.push(OpenAIChatCompletionChunk.parse(json));
  }
}

class AnthropicDecoder implements StreamDecoder {
  readonly #inner = new AnthropicStreamDecoder();

  push(event: SseEvent): CanonicalStreamEvent[] {
    if (event.data === '') return [];
    return this.#inner.push(AnthropicStreamEvent.parse(JSON.parse(event.data)));
  }
}

// ───────────── OpenAI and OpenAI-compatible ─────────────

class OpenAICompatibleAdapter implements ProviderAdapter {
  constructor(readonly type: ProviderType) {}

  buildRequest(ctx: BuildContext): UpstreamRequest {
    const preset = presetFor(ctx.provider);
    const body = canonicalToOpenAIRequest(ctx.request, {
      upstreamModel: ctx.model.upstreamModel,
      maxTokensField: preset.maxTokensField,
      ...(ctx.onDrop ? { onDrop: ctx.onDrop } : {}),
    });
    if (!preset.supportsStreamOptions) delete body.stream_options;
    return {
      url: `${trimSlash(ctx.provider.baseUrl)}/chat/completions`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ctx.request.stream ? 'text/event-stream' : 'application/json',
        ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
        ...preset.headers,
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify(body),
    };
  }

  parseResponse(json: unknown): CanonicalResponse {
    return openAIResponseToCanonical(OpenAIChatCompletionResponse.parse(json));
  }

  createStreamDecoder(): StreamDecoder {
    return new OpenAIDecoder();
  }

  classifyError(input: HttpErrorInput): ClassifiedError {
    return classifyHttpError(input);
  }

  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    return {
      url: `${trimSlash(provider.baseUrl)}/models`,
      method: 'GET',
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...presetFor(provider).headers,
      },
    };
  }

  parseModelList = parseOpenAIModels;

  buildEmbeddingsRequest(ctx: EmbeddingsBuildContext): UpstreamRequest {
    const body: Record<string, unknown> = {
      model: ctx.model.upstreamModel,
      input: ctx.texts,
      encoding_format: ctx.encodingFormat ?? 'float',
      ...(ctx.dimensions !== undefined ? { dimensions: ctx.dimensions } : {}),
    };
    return {
      url: `${trimSlash(ctx.provider.baseUrl)}/embeddings`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
        ...presetFor(ctx.provider).headers,
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify(body),
    };
  }

  parseEmbeddingsResponse(json: unknown): EmbeddingsResult {
    const body = json as {
      data?: { embedding?: unknown; index?: number }[];
      usage?: { prompt_tokens?: unknown };
    };
    const data = Array.isArray(body.data) ? body.data : [];
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return {
      vectors: sorted.map((d) => (Array.isArray(d.embedding) ? (d.embedding as number[]) : [])),
      ...(typeof body.usage?.prompt_tokens === 'number'
        ? { usage: { inputTokens: body.usage.prompt_tokens } }
        : {}),
    };
  }
}

// ───────────── Azure OpenAI ─────────────

export const AZURE_DEFAULT_API_VERSION = '2024-10-21';

class AzureOpenAIAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super('azure-openai');
  }

  override buildRequest(ctx: BuildContext): UpstreamRequest {
    const apiVersion =
      typeof ctx.provider.options.apiVersion === 'string'
        ? ctx.provider.options.apiVersion
        : AZURE_DEFAULT_API_VERSION;
    const body = canonicalToOpenAIRequest(ctx.request, {
      upstreamModel: ctx.model.upstreamModel,
      maxTokensField: 'max_completion_tokens',
      ...(ctx.onDrop ? { onDrop: ctx.onDrop } : {}),
    });
    // In Azure, the deployment name is part of the path.
    delete body.model;
    return {
      url: `${trimSlash(ctx.provider.baseUrl)}/openai/deployments/${encodeURIComponent(ctx.model.upstreamModel)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ctx.request.stream ? 'text/event-stream' : 'application/json',
        'api-key': ctx.apiKey,
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify(body),
    };
  }

  override listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    const apiVersion =
      typeof provider.options.apiVersion === 'string'
        ? provider.options.apiVersion
        : AZURE_DEFAULT_API_VERSION;
    return {
      url: `${trimSlash(provider.baseUrl)}/openai/deployments?api-version=${apiVersion}`,
      method: 'GET',
      headers: { 'api-key': apiKey },
    };
  }
}

// ───────────── Anthropic ─────────────

export const ANTHROPIC_VERSION = '2023-06-01';

class AnthropicAdapter implements ProviderAdapter {
  readonly type = 'anthropic' as const;

  buildRequest(ctx: BuildContext): UpstreamRequest {
    const body = canonicalToAnthropicRequest(ctx.request, {
      upstreamModel: ctx.model.upstreamModel,
      ...(ctx.model.maxOutputTokens
        ? { defaultMaxTokens: Math.min(ctx.model.maxOutputTokens, 8_192) }
        : {}),
      ...(ctx.onDrop ? { onDrop: ctx.onDrop } : {}),
    });
    const version =
      typeof ctx.provider.options.version === 'string'
        ? ctx.provider.options.version
        : ANTHROPIC_VERSION;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: ctx.request.stream ? 'text/event-stream' : 'application/json',
      'x-api-key': ctx.apiKey,
      'anthropic-version': version,
      ...ctx.credentialHeaders,
    };
    const beta = allowedBetas(ctx);
    if (beta) headers['anthropic-beta'] = beta;
    return {
      url: `${trimSlash(ctx.provider.baseUrl)}/v1/messages`,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
  }

  parseResponse(json: unknown): CanonicalResponse {
    return anthropicResponseToCanonical(AnthropicMessagesResponse.parse(json));
  }

  createStreamDecoder(): StreamDecoder {
    return new AnthropicDecoder();
  }

  classifyError(input: HttpErrorInput): ClassifiedError {
    const result = classifyHttpError(input);
    // Anthropic: overloaded_error (529) and api_error (500) are retryable; classifyHttpError
    // covers both. "prompt is too long" is also context_length.
    return result;
  }

  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    return {
      url: `${trimSlash(provider.baseUrl)}/v1/models?limit=1000`,
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    };
  }

  parseModelList = parseOpenAIModels;
}

/**
 * Controlled pass-through of anthropic-beta: only when the client is Anthropic, and only
 * betas listed in `options.allowedBetas` (or `*` for all).
 */
function allowedBetas(ctx: BuildContext): string | undefined {
  const configured = ctx.provider.options.betas;
  const fixed = Array.isArray(configured)
    ? configured.filter((b): b is string => typeof b === 'string')
    : [];
  const requested =
    ctx.request.inboundApi === 'anthropic.messages'
      ? (ctx.clientHeaders?.['anthropic-beta'] ?? '')
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean)
      : [];
  const allow = ctx.provider.options.allowedBetas;
  const allowList = Array.isArray(allow)
    ? allow.filter((b): b is string => typeof b === 'string')
    : [];
  const passed = allowList.includes('*')
    ? requested
    : requested.filter((b) => allowList.includes(b));
  const all = [...new Set([...fixed, ...passed])];
  return all.length ? all.join(',') : undefined;
}

// ───────────── Google Gemini ─────────────

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
export const GEMINI_API_VERSION = 'v1beta';

class GeminiDecoder implements StreamDecoder {
  readonly #inner: GeminiStreamDecoder;

  constructor(model: string) {
    this.#inner = new GeminiStreamDecoder(model);
  }

  push(event: SseEvent): CanonicalStreamEvent[] {
    if (event.data === '' || event.data === '[DONE]') return [];
    const json = JSON.parse(event.data) as Record<string, unknown>;
    if (json.error && typeof json.error === 'object') {
      const err = json.error as { message?: unknown; status?: unknown };
      return [
        {
          type: 'error',
          code: typeof err.status === 'string' ? err.status : 'upstream_error',
          message: typeof err.message === 'string' ? err.message : 'upstream error',
        },
      ];
    }
    return this.#inner.push(GeminiGenerateContentResponse.parse(json));
  }
}

export function geminiVersion(provider: ProviderConfig): string {
  return typeof provider.options.apiVersion === 'string'
    ? provider.options.apiVersion
    : GEMINI_API_VERSION;
}

/** Model name without the `models/` prefix (both forms are accepted in config). */
export const geminiModel = (name: string) => name.replace(/^models\//, '');

/** Google gRPC status codes → equivalent HTTP status for classification. */
const GOOGLE_STATUS: Readonly<Record<string, number>> = {
  RESOURCE_EXHAUSTED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500,
  DEADLINE_EXCEEDED: 504,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
};

export class GeminiAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'gemini';

  buildRequest(ctx: BuildContext): UpstreamRequest {
    const opts = ctx.provider.options;
    const body = canonicalToGeminiRequest(ctx.request, {
      ...(typeof opts.safetyThreshold === 'string'
        ? { safetyThreshold: opts.safetyThreshold }
        : {}),
      ...(Array.isArray(opts.safetySettings) ? { safetySettings: opts.safetySettings } : {}),
      ...(ctx.onDrop ? { onDrop: ctx.onDrop } : {}),
    });
    const model = encodeURIComponent(geminiModel(ctx.model.upstreamModel));
    const action = ctx.request.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return {
      url: `${trimSlash(ctx.provider.baseUrl)}/${geminiVersion(ctx.provider)}/models/${model}:${action}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ctx.request.stream ? 'text/event-stream' : 'application/json',
        'x-goog-api-key': ctx.apiKey,
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify(body),
    };
  }

  parseResponse(json: unknown, model = 'gemini'): CanonicalResponse {
    return geminiResponseToCanonical(GeminiGenerateContentResponse.parse(json), { model });
  }

  createStreamDecoder(model = 'gemini'): StreamDecoder {
    return new GeminiDecoder(model);
  }

  classifyError(input: HttpErrorInput): ClassifiedError {
    // Google error body: {"error":{"code":429,"message":"…","status":"RESOURCE_EXHAUSTED",
    //   "details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"17s"}]}}
    let googleStatus: string | undefined;
    let retryDelayMs: number | undefined;
    try {
      const parsed = JSON.parse(input.body) as {
        error?: { status?: unknown; details?: { retryDelay?: unknown }[] };
      };
      if (typeof parsed.error?.status === 'string') googleStatus = parsed.error.status;
      const delay = parsed.error?.details?.find((d) => typeof d.retryDelay === 'string')
        ?.retryDelay as string | undefined;
      const seconds = delay ? /^(\d+(?:\.\d+)?)s$/.exec(delay)?.[1] : undefined;
      if (seconds) retryDelayMs = Math.round(Number(seconds) * 1000);
    } catch {
      // Non-JSON text
    }
    const mapped = googleStatus ? GOOGLE_STATUS[googleStatus] : undefined;
    const status = input.status === 400 && mapped ? mapped : input.status;
    const result = classifyHttpError({ ...input, status });
    const upstream = googleStatus ? { upstreamType: googleStatus } : {};
    if (result.class === 'bad_request') {
      // An invalid Google key returns 400 with API_KEY_INVALID.
      if (/API_KEY_INVALID|API key not valid/i.test(input.body))
        return classified('auth', { status: input.status, message: result.message, ...upstream });
      // «The input token count (…) exceeds the maximum number of tokens allowed (…)»
      if (/input token count|exceeds the maximum number of tokens/i.test(result.message))
        return classified('context_length', {
          status: input.status,
          message: result.message,
          ...upstream,
        });
    }
    if (result.class === 'rate_limit' && result.retryAfterMs === undefined && retryDelayMs)
      return { ...result, retryAfterMs: retryDelayMs, ...upstream };
    return { ...result, ...upstream };
  }

  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    return {
      url: `${trimSlash(provider.baseUrl)}/${geminiVersion(provider)}/models?pageSize=1000`,
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
    };
  }

  parseModelList(json: unknown): string[] {
    const models = (json as { models?: unknown } | undefined)?.models;
    if (!Array.isArray(models)) return [];
    return models.flatMap((m: { name?: unknown; supportedGenerationMethods?: unknown }) => {
      if (typeof m.name !== 'string') return [];
      const methods = m.supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes('generateContent')) return [];
      return [geminiModel(m.name)];
    });
  }

  protected embedUrl(ctx: EmbeddingsBuildContext): string {
    const model = encodeURIComponent(geminiModel(ctx.model.upstreamModel));
    const action = ctx.texts.length > 1 ? 'batchEmbedContents' : 'embedContent';
    return `${trimSlash(ctx.provider.baseUrl)}/${geminiVersion(ctx.provider)}/models/${model}:${action}`;
  }

  buildEmbeddingsRequest(ctx: EmbeddingsBuildContext): UpstreamRequest {
    // `model` is required in every EmbedContentRequest, including each entry of a batch.
    const item = (text: string) => ({
      model: `models/${geminiModel(ctx.model.upstreamModel)}`,
      content: { parts: [{ text }] },
      ...(ctx.dimensions !== undefined ? { outputDimensionality: ctx.dimensions } : {}),
    });
    const body =
      ctx.texts.length > 1 ? { requests: ctx.texts.map(item) } : item(ctx.texts[0] ?? '');
    return {
      url: this.embedUrl(ctx),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-goog-api-key': ctx.apiKey,
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify(body),
    };
  }

  parseEmbeddingsResponse(json: unknown): EmbeddingsResult {
    const body = json as {
      embedding?: { values?: unknown };
      embeddings?: { values?: unknown }[];
      usageMetadata?: { promptTokenCount?: unknown };
    };
    const vectors = body.embeddings
      ? body.embeddings.map((e) => (Array.isArray(e.values) ? (e.values as number[]) : []))
      : Array.isArray(body.embedding?.values)
        ? [body.embedding.values as number[]]
        : [];
    return {
      vectors,
      ...(typeof body.usageMetadata?.promptTokenCount === 'number'
        ? { usage: { inputTokens: body.usageMetadata.promptTokenCount } }
        : {}),
    };
  }
}

export const VERTEX_DEFAULT_LOCATION = 'us-central1';
/**
 * Vertex AI REST versions are `v1` and `v1beta1`; the Gemini API's `v1beta` does not exist there.
 * `v1beta1` serves generateContent, predict and the publisher model list.
 */
export const VERTEX_API_VERSION = 'v1beta1';

function vertexVersion(provider: ProviderConfig): string {
  return typeof provider.options.apiVersion === 'string'
    ? provider.options.apiVersion
    : VERTEX_API_VERSION;
}

/**
 * Vertex AI adapter (card 11.3): the Gemini-compatible publisher endpoint with OAuth bearer
 * tokens. Project and location come from provider options; the credential is an access token
 * (or `x-goog-api-key` when `options.authMode === 'apiKey'`).
 */
export class VertexAdapter extends GeminiAdapter {
  override readonly type: ProviderType = 'vertex';

  override buildRequest(ctx: BuildContext): UpstreamRequest {
    const base = super.buildRequest(ctx);
    return {
      ...base,
      url: this.vertexUrl(ctx.provider, ctx.model.upstreamModel, ctx.request.stream),
      headers: this.vertexHeaders(
        ctx.provider,
        ctx.apiKey,
        ctx.request.stream,
        ctx.credentialHeaders,
      ),
    };
  }

  /**
   * Vertex text embeddings use the prediction endpoint, not the Gemini API's
   * `embedContent` / `batchEmbedContents`: `:predict` with one instance per text.
   */
  override buildEmbeddingsRequest(ctx: EmbeddingsBuildContext): UpstreamRequest {
    const body = {
      instances: ctx.texts.map((text) => ({ content: text })),
      ...(ctx.dimensions !== undefined
        ? { parameters: { outputDimensionality: ctx.dimensions } }
        : {}),
    };
    return {
      url: this.vertexUrl(ctx.provider, ctx.model.upstreamModel, false, 'predict'),
      method: 'POST',
      headers: this.vertexHeaders(ctx.provider, ctx.apiKey, false, ctx.credentialHeaders),
      body: JSON.stringify(body),
    };
  }

  /** `{ predictions: [{ embeddings: { values, statistics: { token_count } } }] }`. */
  override parseEmbeddingsResponse(json: unknown): EmbeddingsResult {
    const predictions = (json as { predictions?: unknown } | undefined)?.predictions;
    if (!Array.isArray(predictions)) return super.parseEmbeddingsResponse(json);
    const items = predictions as {
      embeddings?: { values?: unknown; statistics?: { token_count?: unknown } };
    }[];
    const vectors = items.map((p) =>
      Array.isArray(p.embeddings?.values) ? (p.embeddings.values as number[]) : [],
    );
    const counts = items
      .map((p) => p.embeddings?.statistics?.token_count)
      .filter((count): count is number => typeof count === 'number');
    return {
      vectors,
      ...(counts.length > 0
        ? { usage: { inputTokens: counts.reduce((sum, count) => sum + count, 0) } }
        : {}),
    };
  }

  override listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    return {
      url: `${trimSlash(provider.baseUrl)}/${vertexVersion(provider)}/publishers/google/models?pageSize=1000`,
      method: 'GET',
      headers: this.vertexHeaders(provider, apiKey, false),
    };
  }

  private vertexUrl(
    provider: ProviderConfig,
    model: string,
    stream: boolean,
    action?: string,
  ): string {
    const location =
      typeof provider.options.location === 'string'
        ? provider.options.location
        : VERTEX_DEFAULT_LOCATION;
    const project = typeof provider.options.project === 'string' ? provider.options.project : '';
    if (!project) throw new Error('vertex provider options.project is required');
    const name = encodeURIComponent(geminiModel(model));
    const verb = action ?? (stream ? 'streamGenerateContent?alt=sse' : 'generateContent');
    return `${trimSlash(provider.baseUrl)}/${vertexVersion(provider)}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${name}:${verb}`;
  }

  private vertexHeaders(
    provider: ProviderConfig,
    apiKey: string,
    stream: boolean,
    credentialHeaders: Record<string, string> = {},
  ): Record<string, string> {
    const useApiKey = provider.options.authMode === 'apiKey';
    return {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      ...(useApiKey ? { 'x-goog-api-key': apiKey } : { authorization: `Bearer ${apiKey}` }),
      ...credentialHeaders,
    };
  }
}

// ───────────── registry ─────────────

// ───────────── Cohere (native v2, card 11.3) ─────────────

const COHERE_FINISH: Record<string, CanonicalResponse['finishReason']> = {
  COMPLETE: 'stop',
  STOP_SEQUENCE: 'stop',
  MAX_TOKENS: 'length',
  TOOL_CALL: 'tool_calls',
  ERROR: 'error',
};

function cohereMessages(request: CanonicalRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  const system = request.system.map((s) => s.text).join('\n');
  if (system) messages.push({ role: 'system', content: system });
  for (const message of request.messages) {
    if (message.role === 'tool') {
      for (const part of message.content)
        if (part.type === 'tool_result')
          messages.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            content: part.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
          });
      continue;
    }
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const calls = message.content.filter((part) => part.type === 'tool_call');
    messages.push({
      role: message.role,
      content: text,
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: call.arguments,
              },
            })),
          }
        : {}),
    });
  }
  return messages;
}

class CohereAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'cohere';

  buildRequest(ctx: BuildContext): UpstreamRequest {
    const request = ctx.request;
    const body: Record<string, unknown> = {
      model: ctx.model.upstreamModel,
      messages: cohereMessages(request),
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { p: request.topP } : {}),
      ...(request.topK !== undefined ? { k: request.topK } : {}),
      ...(request.stop && request.stop.length > 0 ? { stop_sequences: request.stop } : {}),
      ...(request.stream ? { stream: true } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...(tool.description ? { description: tool.description } : {}),
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
    };
    if (request.toolChoice === 'required') body.tool_choice = 'REQUIRED';
    else if (request.toolChoice === 'none') body.tool_choice = 'NONE';
    return {
      url: `${trimSlash(ctx.provider.baseUrl)}/v2/chat`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: request.stream ? 'text/event-stream' : 'application/json',
        ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify(body),
    };
  }

  parseResponse(json: unknown): CanonicalResponse {
    const body = json as {
      id?: string;
      message?: {
        content?: { type?: string; text?: string }[];
        tool_calls?: {
          id?: string;
          function?: { name?: string; arguments?: string };
        }[];
      };
      finish_reason?: string;
      usage?: { tokens?: { input_tokens?: number; output_tokens?: number } };
    };
    const content: CanonicalResponse['content'] = [];
    for (const part of body.message?.content ?? [])
      if (part.type === 'text' && typeof part.text === 'string')
        content.push({ type: 'text', text: part.text });
    for (const call of body.message?.tool_calls ?? [])
      content.push({
        type: 'tool_call',
        id: call.id ?? '',
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '{}',
      });
    return {
      id: body.id ?? `cohere_${String(Date.now())}`,
      model: '',
      content,
      finishReason: COHERE_FINISH[body.finish_reason ?? 'COMPLETE'] ?? 'stop',
      ...(body.finish_reason ? { rawFinishReason: body.finish_reason } : {}),
      ...(body.usage?.tokens
        ? {
            usage: {
              inputTokens: body.usage.tokens.input_tokens ?? 0,
              outputTokens: body.usage.tokens.output_tokens ?? 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
          }
        : {}),
      created: Math.floor(Date.now() / 1000),
    };
  }

  createStreamDecoder(): StreamDecoder {
    return new CohereDecoder();
  }

  classifyError(input: HttpErrorInput): ClassifiedError {
    return classifyHttpError(input);
  }

  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    return {
      url: `${trimSlash(provider.baseUrl)}/v1/models`,
      method: 'GET',
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    };
  }

  parseModelList(json: unknown): string[] {
    const models = (json as { models?: { name?: unknown }[] } | undefined)?.models;
    return Array.isArray(models)
      ? models.map((m) => m.name).filter((name): name is string => typeof name === 'string')
      : [];
  }

  buildEmbeddingsRequest(ctx: EmbeddingsBuildContext): UpstreamRequest {
    return {
      url: `${trimSlash(ctx.provider.baseUrl)}/v2/embed`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify({
        model: ctx.model.upstreamModel,
        texts: ctx.texts,
        input_type: 'search_document',
        embedding_types: ['float'],
        ...(ctx.dimensions !== undefined ? { output_dimension: ctx.dimensions } : {}),
      }),
    };
  }

  parseEmbeddingsResponse(json: unknown): EmbeddingsResult {
    const body = json as {
      embeddings?: { float?: number[][] };
      meta?: { billed_units?: { input_tokens?: number } };
    };
    const vectors = body.embeddings?.float ?? [];
    return {
      vectors,
      ...(typeof body.meta?.billed_units?.input_tokens === 'number'
        ? { usage: { inputTokens: body.meta.billed_units.input_tokens } }
        : {}),
    };
  }
}

interface CohereStreamToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Cohere v2 `tool-call-start` / `tool-call-delta` carry `delta.message.tool_calls` as a single
 * object (one event per tool call); older payloads and some proxies send a one-element array.
 */
function firstToolCall(
  calls: CohereStreamToolCall | CohereStreamToolCall[] | undefined,
): CohereStreamToolCall | undefined {
  return Array.isArray(calls) ? calls[0] : calls;
}

class CohereDecoder implements StreamDecoder {
  #id = 'cohere_stream';
  #created = Math.floor(Date.now() / 1000);
  #toolIndex = 0;

  push(event: SseEvent): CanonicalStreamEvent[] {
    if (event.data === '' || event.data === '[DONE]') return [];
    const json = JSON.parse(event.data) as {
      type?: string;
      id?: string;
      delta?: {
        message?: {
          content?: { text?: string };
          tool_calls?: CohereStreamToolCall | CohereStreamToolCall[];
        };
        finish_reason?: string;
        usage?: { tokens?: { input_tokens?: number; output_tokens?: number } };
      };
    };
    const out: CanonicalStreamEvent[] = [];
    if (json.type === 'message-start') {
      this.#id = json.id ?? this.#id;
      out.push({ type: 'start', id: this.#id, model: '', created: this.#created });
    } else if (json.type === 'content-delta') {
      const text = json.delta?.message?.content?.text;
      if (typeof text === 'string' && text) out.push({ type: 'text_delta', index: 0, text });
    } else if (json.type === 'tool-call-start') {
      const call = firstToolCall(json.delta?.message?.tool_calls);
      out.push({
        type: 'tool_call_start',
        index: ++this.#toolIndex,
        id: call?.id ?? '',
        name: call?.function?.name ?? '',
      });
    } else if (json.type === 'tool-call-delta') {
      const args = firstToolCall(json.delta?.message?.tool_calls)?.function?.arguments;
      if (args) out.push({ type: 'tool_call_delta', index: this.#toolIndex, argumentsDelta: args });
    } else if (json.type === 'message-end') {
      const usage = json.delta?.usage?.tokens;
      if (usage)
        out.push({
          type: 'usage',
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        });
      out.push({
        type: 'finish',
        finishReason: COHERE_FINISH[json.delta?.finish_reason ?? 'COMPLETE'] ?? 'stop',
      });
    }
    return out;
  }
}

// ───────────── Voyage and Jina embeddings (card 11.4) ─────────────

class VoyageAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'voyage';

  buildRequest(): UpstreamRequest {
    throw new Error('Voyage AI only supports embeddings');
  }
  parseResponse(): CanonicalResponse {
    throw new Error('Voyage AI only supports embeddings');
  }
  createStreamDecoder(): StreamDecoder {
    throw new Error('Voyage AI only supports embeddings');
  }
  classifyError(input: HttpErrorInput): ClassifiedError {
    return classifyHttpError(input);
  }
  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    return {
      url: `${trimSlash(provider.baseUrl)}/models`,
      method: 'GET',
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    };
  }
  parseModelList(json: unknown): string[] {
    const data = (json as { data?: { id?: unknown }[] } | undefined)?.data;
    return Array.isArray(data)
      ? data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
      : [];
  }
  buildEmbeddingsRequest(ctx: EmbeddingsBuildContext): UpstreamRequest {
    const body: Record<string, unknown> = {
      model: ctx.model.upstreamModel,
      input: ctx.texts,
      input_type: 'document',
      ...(ctx.dimensions !== undefined ? { output_dimension: ctx.dimensions } : {}),
    };
    return {
      url: `${trimSlash(ctx.provider.baseUrl)}/embeddings`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify(body),
    };
  }
  parseEmbeddingsResponse(json: unknown): EmbeddingsResult {
    const body = json as {
      data?: { embedding?: unknown; index?: number }[];
      usage?: { total_tokens?: number };
    };
    const data = Array.isArray(body.data) ? body.data : [];
    return {
      vectors: [...data]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => (Array.isArray(d.embedding) ? (d.embedding as number[]) : [])),
      ...(typeof body.usage?.total_tokens === 'number'
        ? { usage: { inputTokens: body.usage.total_tokens } }
        : {}),
    };
  }
}

class JinaAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'jina';

  buildRequest(): UpstreamRequest {
    throw new Error('Jina AI only supports embeddings');
  }
  parseResponse(): CanonicalResponse {
    throw new Error('Jina AI only supports embeddings');
  }
  createStreamDecoder(): StreamDecoder {
    throw new Error('Jina AI only supports embeddings');
  }
  classifyError(input: HttpErrorInput): ClassifiedError {
    return classifyHttpError(input);
  }
  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    return {
      url: `${trimSlash(provider.baseUrl)}/models`,
      method: 'GET',
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    };
  }
  parseModelList(json: unknown): string[] {
    const data = (json as { data?: { id?: unknown }[] } | undefined)?.data;
    return Array.isArray(data)
      ? data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
      : [];
  }
  buildEmbeddingsRequest(ctx: EmbeddingsBuildContext): UpstreamRequest {
    return {
      url: `${trimSlash(ctx.provider.baseUrl)}/embeddings`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify({
        model: ctx.model.upstreamModel,
        input: ctx.texts,
        ...(ctx.dimensions !== undefined ? { dimensions: ctx.dimensions } : {}),
      }),
    };
  }
  parseEmbeddingsResponse(json: unknown): EmbeddingsResult {
    const body = json as {
      data?: { embedding?: unknown; index?: number }[];
      usage?: { total_tokens?: number };
    };
    const data = Array.isArray(body.data) ? body.data : [];
    return {
      vectors: [...data]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => (Array.isArray(d.embedding) ? (d.embedding as number[]) : [])),
      ...(typeof body.usage?.total_tokens === 'number'
        ? { usage: { inputTokens: body.usage.total_tokens } }
        : {}),
    };
  }
}

const ADAPTERS: Partial<Record<ProviderType, ProviderAdapter>> = {
  openai: new OpenAICompatibleAdapter('openai'),
  'openai-compatible': new OpenAICompatibleAdapter('openai-compatible'),
  mock: new OpenAICompatibleAdapter('mock'),
  'azure-openai': new AzureOpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  gemini: new GeminiAdapter(),
  vertex: new VertexAdapter(),
  bedrock: new BedrockAdapter(),
  cohere: new CohereAdapter(),
  mistral: new OpenAICompatibleAdapter('mistral'),
  voyage: new VoyageAdapter(),
  jina: new JinaAdapter(),
  elevenlabs: new MediaOnlyAdapter('elevenlabs'),
  deepgram: new MediaOnlyAdapter('deepgram'),
  fal: new MediaOnlyAdapter('fal'),
};

export function adapterFor(type: ProviderType): ProviderAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`no adapter for provider type ${type}`);
  return adapter;
}

export function hasAdapter(type: ProviderType): boolean {
  return ADAPTERS[type] !== undefined;
}

// ───────────── Provider plugins (card 21.2) ─────────────

const PLUGIN_ADAPTERS = new Map<string, ProviderAdapter>();

export function registerPluginAdapter(name: string, adapter: ProviderAdapter): void {
  PLUGIN_ADAPTERS.set(name, adapter);
}

export function clearPluginAdapters(): void {
  PLUGIN_ADAPTERS.clear();
}

/**
 * The adapter for a provider: its type's built-in adapter, or for `plugin` providers the plugin
 * named in `options.plugin`. A plugin that is not loaded gets an adapter that fails every call,
 * so the request falls back to the next target instead of breaking.
 */
export function adapterForProvider(
  provider: Pick<ProviderConfig, 'type' | 'options'>,
): ProviderAdapter {
  if (provider.type !== 'plugin') return adapterFor(provider.type);
  const name = typeof provider.options.plugin === 'string' ? provider.options.plugin : '';
  return PLUGIN_ADAPTERS.get(name) ?? new MissingPluginAdapter(name);
}
