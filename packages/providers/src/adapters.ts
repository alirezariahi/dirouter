/**
 * آداپترهای provider (کارت‌های ۴.۶ و ۴.۷).
 *
 * هر آداپتر فقط «شکل» درخواست و پاسخ را می‌داند؛ اجرای HTTP، retry، timeout و
 * proxy در گیت‌وی است. پس آداپترها کاملاً قابل تست بدون شبکه‌اند.
 */
import {
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
  type CanonicalRequest,
  type CanonicalResponse,
  type CanonicalStreamEvent,
  type ModelConfig,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  type ProviderConfig,
  type ProviderType,
} from '@dirouter/contracts';
import {
  AnthropicStreamDecoder,
  type DropReporter,
  OpenAIStreamDecoder,
  type SseEvent,
  anthropicResponseToCanonical,
  canonicalToAnthropicRequest,
  canonicalToOpenAIRequest,
  openAIResponseToCanonical,
} from '@dirouter/translator';

import { type ClassifiedError, type HttpErrorInput, classifyHttpError } from './errors.js';
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
  /** کلید رمزگشایی‌شدهٔ credential (فقط در حافظه). */
  apiKey: string;
  /** هدرهای اضافهٔ credential. */
  credentialHeaders?: Record<string, string>;
  request: CanonicalRequest;
  /** هدرهای ورودی کلاینت (فقط برای pass-through کنترل‌شده، مثل anthropic-beta). */
  clientHeaders?: Record<string, string | undefined>;
  onDrop?: DropReporter;
}

export interface StreamDecoder {
  /** رویداد SSE خام → رویدادهای canonical. `[DONE]` و ping نادیده گرفته می‌شوند. */
  push(event: SseEvent): CanonicalStreamEvent[];
}

export interface ProviderAdapter {
  readonly type: ProviderType;
  buildRequest(ctx: BuildContext): UpstreamRequest;
  parseResponse(json: unknown): CanonicalResponse;
  createStreamDecoder(): StreamDecoder;
  classifyError(input: HttpErrorInput): ClassifiedError;
  /** درخواست فهرست مدل‌ها برای کشف مدل (control-api). */
  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest;
  /** استخراج شناسهٔ مدل‌ها از پاسخ list models. */
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

// ───────────── OpenAI و OpenAI-compatible ─────────────

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
    // در Azure نام deployment در مسیر است.
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
    // Anthropic: overloaded_error (529) و api_error (500) قابل تلاش دوباره‌اند؛ classifyHttpError
    // هر دو را پوشش می‌دهد. «prompt is too long» هم context_length است.
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
 * pass-through کنترل‌شدهٔ anthropic-beta: فقط وقتی کلاینت Anthropic است و فقط
 * betaهایی که در `options.allowedBetas` آمده‌اند (یا `*` برای همه).
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

// ───────────── registry ─────────────

const ADAPTERS: Partial<Record<ProviderType, ProviderAdapter>> = {
  openai: new OpenAICompatibleAdapter('openai'),
  'openai-compatible': new OpenAICompatibleAdapter('openai-compatible'),
  mock: new OpenAICompatibleAdapter('mock'),
  'azure-openai': new AzureOpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
};

export function adapterFor(type: ProviderType): ProviderAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`no adapter for provider type ${type}`);
  return adapter;
}

export function hasAdapter(type: ProviderType): boolean {
  return ADAPTERS[type] !== undefined;
}
