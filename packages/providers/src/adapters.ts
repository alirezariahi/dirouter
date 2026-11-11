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

export interface UpstreamRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
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

function geminiVersion(provider: ProviderConfig): string {
  return typeof provider.options.apiVersion === 'string'
    ? provider.options.apiVersion
    : GEMINI_API_VERSION;
}

/** Model name without the `models/` prefix (both forms are accepted in config). */
const geminiModel = (name: string) => name.replace(/^models\//, '');

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

class GeminiAdapter implements ProviderAdapter {
  readonly type = 'gemini' as const;

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
}

// ───────────── registry ─────────────

const ADAPTERS: Partial<Record<ProviderType, ProviderAdapter>> = {
  openai: new OpenAICompatibleAdapter('openai'),
  'openai-compatible': new OpenAICompatibleAdapter('openai-compatible'),
  mock: new OpenAICompatibleAdapter('mock'),
  'azure-openai': new AzureOpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  gemini: new GeminiAdapter(),
};

export function adapterFor(type: ProviderType): ProviderAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`no adapter for provider type ${type}`);
  return adapter;
}

export function hasAdapter(type: ProviderType): boolean {
  return ADAPTERS[type] !== undefined;
}
