/**
 * The adapter that runs a provider plugin (card 21.2).
 *
 * A plugin works in the OpenAI chat format, which most provider APIs resemble:
 *
 * ```js
 * module.exports = {
 *   // Required. `body` is an OpenAI chat completions request; return the upstream request.
 *   buildRequest({ body, model, apiKey, baseUrl, options, stream }) {
 *     return { url, method, headers, body };
 *   },
 *   // Optional: provider response → OpenAI chat completion (identity when absent).
 *   parseResponse(json) { ... },
 *   // Optional: one SSE `data` payload → OpenAI chunk, or null to skip it.
 *   parseStreamEvent(json) { ... },
 *   // Optional model discovery.
 *   listModels({ baseUrl, apiKey, options }) { return { url, headers }; },
 *   parseModelList(json) { return ['model-a']; },
 * };
 * ```
 */
import {
  type CanonicalResponse,
  type CanonicalStreamEvent,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  type PluginManifest,
  type ProviderConfig,
  type ProviderType,
} from '@dirouter/contracts';
import {
  OpenAIStreamDecoder,
  type SseEvent,
  canonicalToOpenAIRequest,
  openAIResponseToCanonical,
} from '@dirouter/translator';

import type { BuildContext, ProviderAdapter, StreamDecoder, UpstreamRequest } from '../adapters.js';
import { type ClassifiedError, type HttpErrorInput, classifyHttpError } from '../errors.js';
import { PluginError, type PluginSandbox } from './sandbox.js';

/** Options the gateway keeps for itself; plugins never see them. */
const INTERNAL_OPTIONS = new Set(['plugin', 'termsAcceptedAt', 'termsAcceptedBy']);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class PluginAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'plugin';

  constructor(
    readonly manifest: PluginManifest,
    private readonly sandbox: PluginSandbox,
  ) {}

  /** Terms must have been accepted on the provider before the plugin is used. */
  #assertUsable(provider: ProviderConfig) {
    if (this.manifest.termsWarning && typeof provider.options.termsAcceptedAt !== 'string')
      throw new PluginError(
        `plugin ${this.manifest.name} needs its terms accepted on provider ${provider.slug}`,
      );
  }

  #pluginOptions(provider: ProviderConfig) {
    return Object.fromEntries(
      Object.entries(provider.options).filter(([key]) => !INTERNAL_OPTIONS.has(key)),
    );
  }

  /** Validates a request the plugin built: shape, scheme and an allowed host. */
  #upstream(raw: unknown, provider: ProviderConfig, extraHeaders: Record<string, string> = {}) {
    const out = record(raw);
    if (typeof out.url !== 'string') throw new PluginError('plugin returned no url');
    let url: URL;
    try {
      url = new URL(out.url);
    } catch {
      throw new PluginError(`plugin returned an invalid url: ${out.url.slice(0, 100)}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new PluginError('plugin urls must be http or https');
    const allowed = new Set([new URL(provider.baseUrl).host, ...this.manifest.hosts]);
    if (!allowed.has(url.host))
      throw new PluginError(`plugin ${this.manifest.name} may not call ${url.host}`);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(record(out.headers)))
      if (typeof value === 'string') headers[name.toLowerCase()] = value;
    const method = out.method === 'GET' ? 'GET' : 'POST';
    const body =
      out.body === undefined || out.body === null || method === 'GET'
        ? undefined
        : typeof out.body === 'string'
          ? out.body
          : JSON.stringify(out.body);
    return {
      url: url.toString(),
      method,
      headers: { ...headers, ...extraHeaders },
      ...(body !== undefined ? { body } : {}),
    } satisfies UpstreamRequest;
  }

  buildRequest(ctx: BuildContext): UpstreamRequest {
    this.#assertUsable(ctx.provider);
    const body = canonicalToOpenAIRequest(ctx.request, {
      upstreamModel: ctx.model.upstreamModel,
      maxTokensField: 'max_tokens',
      ...(ctx.onDrop ? { onDrop: ctx.onDrop } : {}),
    });
    const raw = this.sandbox.call('buildRequest', {
      body,
      model: ctx.model.upstreamModel,
      apiKey: ctx.apiKey,
      baseUrl: ctx.provider.baseUrl,
      options: this.#pluginOptions(ctx.provider),
      stream: ctx.request.stream,
    });
    const up = this.#upstream(raw, ctx.provider, ctx.credentialHeaders);
    return { ...up, headers: { 'content-type': 'application/json', ...up.headers } };
  }

  parseResponse(json: unknown): CanonicalResponse {
    const openai = this.sandbox.has('parseResponse')
      ? this.sandbox.call('parseResponse', json)
      : json;
    return openAIResponseToCanonical(OpenAIChatCompletionResponse.parse(openai));
  }

  createStreamDecoder(): StreamDecoder {
    const inner = new OpenAIStreamDecoder();
    const convert = this.sandbox.has('parseStreamEvent');
    return {
      push: (event: SseEvent): CanonicalStreamEvent[] => {
        if (event.data === '[DONE]' || event.data === '') return [];
        const json: unknown = JSON.parse(event.data);
        const chunk = convert ? this.sandbox.call('parseStreamEvent', json) : json;
        return chunk === null ? [] : inner.push(OpenAIChatCompletionChunk.parse(chunk));
      },
    };
  }

  classifyError(input: HttpErrorInput): ClassifiedError {
    return classifyHttpError(input);
  }

  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    this.#assertUsable(provider);
    if (!this.sandbox.has('listModels'))
      return {
        url: `${provider.baseUrl.replace(/\/+$/, '')}/models`,
        method: 'GET',
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      };
    return this.#upstream(
      this.sandbox.call('listModels', {
        baseUrl: provider.baseUrl,
        apiKey,
        options: this.#pluginOptions(provider),
      }),
      provider,
    );
  }

  parseModelList(json: unknown): string[] {
    const list = this.sandbox.has('parseModelList')
      ? this.sandbox.call('parseModelList', json)
      : (record(json).data as unknown[] | undefined)?.map((m) => record(m).id);
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  }
}

/** Stands in for a plugin that is not loaded: every use fails, so routing falls back. */
export class MissingPluginAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'plugin';
  constructor(private readonly name: string) {}
  #fail(): never {
    throw new PluginError(`plugin ${this.name || '(unnamed)'} is not loaded`);
  }
  buildRequest(): UpstreamRequest {
    this.#fail();
  }
  parseResponse(): CanonicalResponse {
    this.#fail();
  }
  createStreamDecoder(): StreamDecoder {
    this.#fail();
  }
  classifyError(input: HttpErrorInput): ClassifiedError {
    return classifyHttpError(input);
  }
  listModelsRequest(): UpstreamRequest {
    this.#fail();
  }
  parseModelList(): string[] {
    return [];
  }
}
