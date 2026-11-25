/**
 * Providers with their own wire protocol (card 31.6), configured as `type: openai-compatible` with
 * `options.preset` so no new provider type is needed:
 *
 * - `replicate`: the predictions API (`Prefer: wait`), prompt-style language models;
 * - `watsonx`: IBM watsonx.ai `text/chat` (OpenAI-shaped messages and tools, `project_id`), with
 *   an IAM token obtained from the API key (see `oauth.ts`);
 * - `sagemaker`: a SageMaker real-time endpoint serving the OpenAI Messages API (TGI, LMI, vLLM
 *   containers), signed with SigV4 (`sagemaker`).
 */
import {
  type CanonicalRequest,
  type CanonicalResponse,
  type CanonicalStreamEvent,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  type ProviderConfig,
} from '@dirouter/contracts';
import {
  OpenAIStreamDecoder,
  type SseEvent,
  UnsupportedContentError,
  canonicalToOpenAIRequest,
  openAIResponseToCanonical,
  textOf,
} from '@dirouter/translator';

import type { BuildContext, ProviderAdapter, StreamDecoder, UpstreamRequest } from './adapters.js';
import { parseAwsCredentials, signAwsRequest } from './bedrock.js';
import { type ClassifiedError, type HttpErrorInput, classifyHttpError } from './errors.js';

type Json = Record<string, unknown>;
const trimSlash = (url: string) => url.replace(/\/+$/, '');
const option = (provider: Pick<ProviderConfig, 'options'>, name: string) => {
  const value = provider.options[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};
const noStream = (provider: string) =>
  new UnsupportedContentError(
    'stream',
    `${provider} models answer without streaming here; send the request with stream: false`,
  );

/** A decoder for providers whose answers are never streamed through DiRouter. */
class NoStreamDecoder implements StreamDecoder {
  constructor(private readonly provider: string) {}
  push(): CanonicalStreamEvent[] {
    return [{ type: 'error', code: 'bad_request', message: noStream(this.provider).message }];
  }
}

// ───────────── Replicate ─────────────

export const REPLICATE_DEFAULT_BASE_URL = 'https://api.replicate.com/v1';

/**
 * Replicate language models take a prompt, not a conversation. A single user turn is sent as it
 * is; a longer conversation as a transcript the model continues.
 */
function replicatePrompt(request: CanonicalRequest): string {
  const turns = request.messages.map((m) => ({ role: m.role, text: textOf(m.content) }));
  const only = turns[0];
  if (turns.length === 1 && only?.role === 'user') return only.text;
  return `${turns
    .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`)
    .join('\n\n')}\n\nAssistant:`;
}

export class ReplicateAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const;

  buildRequest(ctx: BuildContext): UpstreamRequest {
    const req = ctx.request;
    if (req.stream) throw noStream('Replicate');
    if (req.tools?.length)
      throw new UnsupportedContentError('tools', 'Replicate language models take no tools');
    for (const message of req.messages)
      for (const part of message.content)
        if (part.type !== 'text')
          throw new UnsupportedContentError(
            `messages[].content[].${part.type}`,
            `Replicate language models take text only, not ${part.type}`,
          );
    const input: Json = { prompt: replicatePrompt(req) };
    if (req.system.length) input.system_prompt = req.system.map((p) => p.text).join('\n\n');
    if (req.maxOutputTokens !== undefined) input.max_tokens = req.maxOutputTokens;
    if (req.temperature !== undefined) input.temperature = req.temperature;
    if (req.topP !== undefined) input.top_p = req.topP;
    if (req.topK !== undefined) input.top_k = req.topK;
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.stop?.length) input.stop_sequences = req.stop.join(',');
    // `owner/name` runs the model's latest version; `owner/name:version` a pinned one.
    const [model = '', version] = ctx.model.upstreamModel.split(':');
    const base = trimSlash(ctx.provider.baseUrl);
    return {
      url: version ? `${base}/predictions` : `${base}/models/${model}/predictions`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${ctx.apiKey}`,
        // Wait for the prediction (up to 60 s) instead of polling.
        prefer: 'wait=60',
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify(version ? { version, input } : { input }),
    };
  }

  parseResponse(json: unknown, model = 'replicate'): CanonicalResponse {
    const body = (json ?? {}) as Json;
    const status = body.status;
    if (status !== 'succeeded') {
      const detail = typeof body.error === 'string' ? `: ${body.error}` : '';
      throw new Error(
        `Replicate prediction ${typeof status === 'string' ? status : 'unknown'}${detail}`,
      );
    }
    const output = body.output;
    const text = Array.isArray(output) ? output.join('') : typeof output === 'string' ? output : '';
    const metrics = (body.metrics ?? {}) as Json;
    const input = Number(metrics.input_token_count);
    const out = Number(metrics.output_token_count);
    return {
      id: typeof body.id === 'string' ? body.id : `replicate-${Date.now().toString(36)}`,
      model: typeof body.model === 'string' ? body.model : model,
      content: text ? [{ type: 'text', text }] : [],
      finishReason: 'stop',
      ...(Number.isFinite(input) && Number.isFinite(out)
        ? {
            usage: {
              inputTokens: input,
              outputTokens: out,
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
    return new NoStreamDecoder('Replicate');
  }

  classifyError(input: HttpErrorInput): ClassifiedError {
    return classifyHttpError(input);
  }

  /** The language-models collection: public models suited to chat. */
  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    return {
      url: `${trimSlash(provider.baseUrl)}/collections/language-models`,
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    };
  }

  parseModelList(json: unknown): string[] {
    const models = (json as { models?: { owner?: unknown; name?: unknown }[] } | undefined)?.models;
    return Array.isArray(models)
      ? models.flatMap((m) =>
          typeof m.owner === 'string' && typeof m.name === 'string' ? [`${m.owner}/${m.name}`] : [],
        )
      : [];
  }
}

// ───────────── OpenAI-shaped bodies of other providers ─────────────

/** Fills what OpenAI's schema requires and these providers leave out or name differently. */
function asOpenAIResponse(json: unknown, model: string): OpenAIChatCompletionResponse {
  const body = (json ?? {}) as Json;
  return OpenAIChatCompletionResponse.parse({
    ...body,
    id: typeof body.id === 'string' ? body.id : `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: typeof body.created === 'number' ? body.created : Math.floor(Date.now() / 1000),
    model:
      typeof body.model === 'string'
        ? body.model
        : typeof body.model_id === 'string'
          ? body.model_id
          : model,
  });
}

// ───────────── IBM watsonx.ai ─────────────

export const WATSONX_DEFAULT_VERSION = '2024-10-08';

class WatsonxDecoder implements StreamDecoder {
  readonly #inner = new OpenAIStreamDecoder();
  constructor(private readonly model: string) {}

  push(event: SseEvent): CanonicalStreamEvent[] {
    if (event.data === '' || event.data === '[DONE]') return [];
    const json = JSON.parse(event.data) as Json;
    if (json.errors || json.error) {
      const first = Array.isArray(json.errors) ? (json.errors[0] as Json | undefined) : undefined;
      return [
        {
          type: 'error',
          code: typeof first?.code === 'string' ? first.code : 'upstream_error',
          message: typeof first?.message === 'string' ? first.message : 'watsonx error',
        },
      ];
    }
    return this.#inner.push(
      OpenAIChatCompletionChunk.parse({
        ...json,
        id: typeof json.id === 'string' ? json.id : 'watsonx',
        object: 'chat.completion.chunk',
        created: typeof json.created === 'number' ? json.created : Math.floor(Date.now() / 1000),
        model: typeof json.model_id === 'string' ? json.model_id : this.model,
      }),
    );
  }
}

export class WatsonxAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const;

  buildRequest(ctx: BuildContext): UpstreamRequest {
    const projectId = option(ctx.provider, 'projectId');
    const spaceId = option(ctx.provider, 'spaceId');
    if (!projectId && !spaceId)
      throw new Error('watsonx needs options.projectId (or options.spaceId)');
    const openai = canonicalToOpenAIRequest(ctx.request, {
      upstreamModel: ctx.model.upstreamModel,
      maxTokensField: 'max_tokens',
      ...(ctx.onDrop ? { onDrop: ctx.onDrop } : {}),
    });
    const { model, stream: _stream, stream_options: _options, user: _user, ...rest } = openai;
    const version = option(ctx.provider, 'version') ?? WATSONX_DEFAULT_VERSION;
    const action = ctx.request.stream ? 'chat_stream' : 'chat';
    return {
      url: `${trimSlash(ctx.provider.baseUrl)}/ml/v1/text/${action}?version=${encodeURIComponent(version)}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ctx.request.stream ? 'text/event-stream' : 'application/json',
        authorization: `Bearer ${ctx.apiKey}`,
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify({
        ...rest,
        model_id: model,
        ...(projectId ? { project_id: projectId } : { space_id: spaceId }),
      }),
    };
  }

  parseResponse(json: unknown, model = 'watsonx'): CanonicalResponse {
    return openAIResponseToCanonical(asOpenAIResponse(json, model));
  }

  createStreamDecoder(model = 'watsonx'): StreamDecoder {
    return new WatsonxDecoder(model);
  }

  classifyError(input: HttpErrorInput): ClassifiedError {
    return classifyHttpError(input);
  }

  /** Foundation models that can chat. */
  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    const version = option(provider, 'version') ?? WATSONX_DEFAULT_VERSION;
    return {
      url: `${trimSlash(provider.baseUrl)}/ml/v1/foundation_model_specs?version=${encodeURIComponent(version)}&filters=function_text_chat&limit=200`,
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    };
  }

  parseModelList(json: unknown): string[] {
    const resources = (json as { resources?: { model_id?: unknown }[] } | undefined)?.resources;
    return Array.isArray(resources)
      ? resources.map((r) => r.model_id).filter((id): id is string => typeof id === 'string')
      : [];
  }
}

// ───────────── Amazon SageMaker ─────────────

function sagemakerRegion(provider: ProviderConfig): string {
  const region = option(provider, 'region');
  if (region) return region;
  const match = /runtime\.sagemaker\.([a-z0-9-]+)\.amazonaws\.com/.exec(provider.baseUrl);
  return match?.[1] ?? 'us-east-1';
}

function credentialsFor(provider: ProviderConfig, secret: string) {
  const parsed = parseAwsCredentials(secret);
  const fallback = option(provider, 'sessionToken');
  return !parsed.sessionToken && fallback ? { ...parsed, sessionToken: fallback } : parsed;
}

export class SageMakerAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible' as const;

  /** The model name is the endpoint name; the container speaks the OpenAI Messages API. */
  buildRequest(ctx: BuildContext): UpstreamRequest {
    if (ctx.request.stream) throw noStream('SageMaker');
    const openai = canonicalToOpenAIRequest(ctx.request, {
      upstreamModel: ctx.model.upstreamModel,
      maxTokensField: 'max_tokens',
      ...(ctx.onDrop ? { onDrop: ctx.onDrop } : {}),
    });
    // The container's own model name, when it checks one (TGI takes `tgi`).
    const containerModel = option(ctx.provider, 'containerModel');
    const { model: _endpoint, ...rest } = openai;
    const body = JSON.stringify(containerModel ? { ...rest, model: containerModel } : rest);
    const url = `${trimSlash(ctx.provider.baseUrl)}/endpoints/${encodeURIComponent(ctx.model.upstreamModel)}/invocations`;
    const headers = signAwsRequest({
      method: 'POST',
      url,
      body,
      region: sagemakerRegion(ctx.provider),
      credentials: credentialsFor(ctx.provider, ctx.apiKey),
      service: 'sagemaker',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...ctx.credentialHeaders,
      },
    });
    return { url, method: 'POST', headers, body };
  }

  parseResponse(json: unknown, model = 'sagemaker'): CanonicalResponse {
    return openAIResponseToCanonical(asOpenAIResponse(json, model));
  }

  createStreamDecoder(): StreamDecoder {
    return new NoStreamDecoder('SageMaker');
  }

  classifyError(input: HttpErrorInput): ClassifiedError {
    return classifyHttpError(input);
  }

  /** `ListEndpoints` on the SageMaker control plane (endpoints in service). */
  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    const region = sagemakerRegion(provider);
    const url = option(provider, 'controlUrl') ?? `https://api.sagemaker.${region}.amazonaws.com/`;
    const body = JSON.stringify({ MaxResults: 100, StatusEquals: 'InService' });
    const headers = signAwsRequest({
      method: 'POST',
      url,
      body,
      region,
      credentials: credentialsFor(provider, apiKey),
      service: 'sagemaker',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'SageMaker.ListEndpoints',
      },
    });
    return { url, method: 'POST', headers, body };
  }

  parseModelList(json: unknown): string[] {
    const endpoints = (json as { Endpoints?: { EndpointName?: unknown }[] } | undefined)?.Endpoints;
    return Array.isArray(endpoints)
      ? endpoints
          .map((e) => e.EndpointName)
          .filter((name): name is string => typeof name === 'string')
      : [];
  }
}

export const PROTOCOL_ADAPTERS = {
  replicate: new ReplicateAdapter(),
  watsonx: new WatsonxAdapter(),
  sagemaker: new SageMakerAdapter(),
} as const;
