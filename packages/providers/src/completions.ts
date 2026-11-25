/**
 * Legacy `/v1/completions` served natively (card 30.4), for models whose provider still has the
 * endpoint (OpenAI's instruct models, Azure instruct deployments, vLLM and other compatible
 * servers). Every other model is reached by mapping the request to chat in the gateway.
 */
import type { ProviderType } from '@dirouter/contracts';

import { AZURE_DEFAULT_API_VERSION, type UpstreamRequest } from './adapters.js';
import type { MediaContext } from './media.js';

const NATIVE_TYPES: readonly ProviderType[] = [
  'openai',
  'openai-compatible',
  'mock',
  'azure-openai',
];

export function supportsNativeCompletions(type: ProviderType): boolean {
  return NATIVE_TYPES.includes(type);
}

export interface CompletionChoice {
  text: string;
  index: number;
  finishReason: string | null;
  logprobs?: unknown;
}

export interface CompletionResult {
  choices: CompletionChoice[];
  usage?: { inputTokens: number; outputTokens: number };
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** The request for the provider's own endpoint; `body` is the client's, with the model replaced. */
export function nativeCompletionsRequest(
  ctx: MediaContext,
  body: Record<string, unknown>,
): UpstreamRequest | undefined {
  const base = trimSlash(ctx.provider.baseUrl);
  // The gateway always reads the whole answer, so the upstream call never streams.
  const { stream: _stream, stream_options: _options, ...rest } = body;
  if (ctx.provider.type === 'azure-openai') {
    const apiVersion =
      typeof ctx.provider.options.apiVersion === 'string'
        ? ctx.provider.options.apiVersion
        : AZURE_DEFAULT_API_VERSION;
    delete rest.model;
    return {
      url: `${base}/openai/deployments/${encodeURIComponent(ctx.model.upstreamModel)}/completions?api-version=${encodeURIComponent(apiVersion)}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ctx.provider.options.authMode === 'entra'
          ? { authorization: `Bearer ${ctx.apiKey}` }
          : { 'api-key': ctx.apiKey }),
        ...ctx.credentialHeaders,
      },
      body: JSON.stringify(rest),
    };
  }
  if (!supportsNativeCompletions(ctx.provider.type)) return undefined;
  return {
    url: `${base}/completions`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
      ...ctx.credentialHeaders,
    },
    body: JSON.stringify({ ...rest, model: ctx.model.upstreamModel }),
  };
}

export function parseCompletion(json: unknown): CompletionResult {
  const body = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const usage = (body.usage ?? {}) as Record<string, unknown>;
  const choices = (Array.isArray(body.choices) ? body.choices : []).map((raw, i) => {
    const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      text: typeof c.text === 'string' ? c.text : '',
      index: typeof c.index === 'number' ? c.index : i,
      finishReason: typeof c.finish_reason === 'string' ? c.finish_reason : null,
      ...(c.logprobs !== undefined && c.logprobs !== null ? { logprobs: c.logprobs } : {}),
    };
  });
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  return {
    choices,
    ...(typeof input === 'number' && typeof output === 'number'
      ? { usage: { inputTokens: input, outputTokens: output } }
      : {}),
  };
}
