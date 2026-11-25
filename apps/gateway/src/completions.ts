/**
 * Legacy `POST /v1/completions` (card 30.4), for tools that still use the text completion API.
 *
 * A model whose `completions` capability is on, at a provider that has the endpoint (OpenAI,
 * Azure, OpenAI-compatible servers such as vLLM), is called natively: every option passes
 * through. Any other model gets the request mapped to chat: the prompt becomes one user message
 * and the answer's text comes back as the completion. Options chat cannot express (`echo`,
 * `logprobs`, `suffix`, `best_of`, `n` > 1, several or token prompts) are refused with a 400 that
 * says so instead of being dropped.
 *
 * It runs through the shared metered pipeline (routing with fallback, limits, budgets, wallet,
 * usage event with `inboundApi: openai.completions`). The upstream answer is read whole; with
 * `stream: true` it is sent as server-sent events in the API's chunk format (one chunk per choice,
 * then the usage chunk when `stream_options.include_usage` is set, then `[DONE]`).
 */
import { type CanonicalFinishReason, OpenAIChatCompletionRequest } from '@dirouter/contracts';
import {
  adapterForProvider,
  type CompletionResult,
  nativeCompletionsRequest,
  parseCompletion,
  supportsNativeCompletions,
} from '@dirouter/providers';
import type { Candidate } from '@dirouter/routing';
import { DiRouterError, ValidationError } from '@dirouter/shared';
import { openAIRequestToCanonical } from '@dirouter/translator';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { authenticate, extractApiKey } from './auth.js';
import { guardBodies } from './body-guardrails.js';
import { type MeteredResult, runMetered } from './metered.js';
import type { ProxyDeps } from './proxy.js';

/** OpenAI's default when `max_tokens` is left out. */
const DEFAULT_MAX_TOKENS = 16;
const MAX_CHOICES = 128;

const invalid = (path: string, message: string) => new ValidationError([{ path, message }]);

const isTokens = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every((t) => Number.isInteger(t));

/** The prompt as texts (strings only), or undefined for token prompts. */
function promptTexts(prompt: unknown): string[] | undefined {
  if (prompt === undefined) return [''];
  if (typeof prompt === 'string') return [prompt];
  if (Array.isArray(prompt) && prompt.every((p) => typeof p === 'string')) return prompt;
  return undefined;
}

/** Why the request cannot be mapped to chat, or undefined when it can. */
export function unmappable(body: Record<string, unknown>): string | undefined {
  const texts = promptTexts(body.prompt);
  const reasons: string[] = [];
  if (!texts) reasons.push('token prompts');
  else if (texts.length > 1) reasons.push('several prompts');
  if (body.echo === true) reasons.push('echo');
  if (body.logprobs !== undefined && body.logprobs !== null) reasons.push('logprobs');
  if (typeof body.suffix === 'string' && body.suffix !== '') reasons.push('suffix');
  if (typeof body.best_of === 'number' && body.best_of > 1) reasons.push('best_of');
  if (typeof body.n === 'number' && body.n > 1) reasons.push('n > 1');
  return reasons.length > 0 ? reasons.join(', ') : undefined;
}

const native = (candidate: Candidate) =>
  candidate.model.capabilities.completions === true &&
  supportsNativeCompletions(candidate.provider.type);

const FINISH: Partial<Record<CanonicalFinishReason, string>> = {
  stop: 'stop',
  length: 'length',
  content_filter: 'content_filter',
};

export async function handleCompletions(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const send = (error: DiRouterError, headers: Record<string, string> = {}) => {
    for (const [name, value] of Object.entries(headers)) void reply.header(name, value);
    reply.status(error.status).send(error.toOpenAI());
  };
  const prompt = body.prompt;
  const maxTokens = body.max_tokens ?? DEFAULT_MAX_TOKENS;
  const n = body.n ?? 1;
  try {
    if (typeof body.model !== 'string' || body.model === '')
      throw invalid('model', 'model is required');
    const tokenPrompt =
      isTokens(prompt) || (Array.isArray(prompt) && prompt.length > 0 && prompt.every(isTokens));
    if (prompt !== undefined && !promptTexts(prompt) && !tokenPrompt)
      throw invalid('prompt', 'prompt must be a string, an array of strings or token arrays');
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 0)
      throw invalid('max_tokens', 'max_tokens must be a non-negative integer');
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_CHOICES)
      throw invalid('n', `n must be an integer from 1 to ${String(MAX_CHOICES)}`);
  } catch (error) {
    send(error as DiRouterError);
    return;
  }
  const model = body.model;

  // Request guardrails (card 15.1), as on chat: a blocking policy refuses the request, redaction
  // rewrites the prompt (and suffix) before it is sent natively or mapped to chat. A request that
  // does not authenticate is answered by the metered pipeline below.
  const config = deps.store.current;
  let key;
  try {
    key = config
      ? authenticate(
          config,
          extractApiKey(req.headers, (req.query as { key?: string } | undefined)?.key),
          deps.pepper,
          req.ip,
        )
      : undefined;
  } catch {
    key = undefined;
  }
  if (config && key) {
    const guard = await guardBodies(req, deps, config, key, [body]);
    if (guard.blocked) {
      send(new DiRouterError('invalid_request', { message: guard.blocked.message, status: 400 }));
      return;
    }
  }

  const texts = promptTexts(body.prompt) ?? [];
  const promptCount = Array.isArray(prompt) && !isTokens(prompt) ? prompt.length : 1;
  const estimatedInputTokens = Math.ceil(
    (texts.length > 0
      ? texts.reduce((sum, text) => sum + text.length, 0)
      : JSON.stringify(body.prompt).length) / 4,
  );
  // `best_of` completions are generated (and billed) per prompt; `n` of them are returned.
  const generated =
    typeof body.best_of === 'number' && Number.isInteger(body.best_of) && body.best_of > n
      ? body.best_of
      : n;
  const blocked = unmappable(body);

  // The request as chat, for models without the native endpoint.
  let chat: ReturnType<typeof openAIRequestToCanonical> | undefined;
  try {
    chat = blocked
      ? undefined
      : openAIRequestToCanonical(
          OpenAIChatCompletionRequest.parse({
            model,
            messages: [{ role: 'user', content: texts[0] ?? '' }],
            max_tokens: maxTokens,
            ...Object.fromEntries(
              [
                'temperature',
                'top_p',
                'stop',
                'seed',
                'presence_penalty',
                'frequency_penalty',
                'logit_bias',
                'user',
              ]
                .filter((k) => body[k] !== undefined && body[k] !== null)
                .map((k) => [k, body[k]]),
            ),
          }),
        );
  } catch {
    send(invalid('body', 'temperature, top_p, stop, seed, penalties or logit_bias are malformed'));
    return;
  }

  const result: MeteredResult<CompletionResult> = await runMetered<CompletionResult>(req, deps, {
    inboundApi: 'openai.completions',
    model,
    estimatedInputTokens,
    worstCase: {
      usage: {
        inputTokens: estimatedInputTokens,
        outputTokens: maxTokens * generated * promptCount,
      },
      estimated: true,
    },
    select: (candidates) => {
      const fits = candidates.filter((c) => native(c) || !blocked);
      return fits.length > 0
        ? fits
        : new DiRouterError('invalid_request', {
            message: `'${model}' is served through chat, which cannot express ${blocked ?? ''}; use a model with native completions`,
            status: 400,
          });
    },
    build: (candidate, apiKey) => {
      const ctx = {
        provider: candidate.provider,
        model: candidate.model,
        apiKey,
        credentialHeaders: candidate.credential.headers,
      };
      if (native(candidate)) return nativeCompletionsRequest(ctx, body);
      if (!chat) return undefined;
      return adapterForProvider(candidate.provider).buildRequest({
        ...ctx,
        request: { ...chat, model: candidate.model.upstreamModel },
      });
    },
    read: async (response, candidate) => {
      const json: unknown = await response.json();
      if (native(candidate)) return parseCompletion(json);
      const parsed = adapterForProvider(candidate.provider).parseResponse(
        json,
        candidate.model.upstreamModel,
      );
      return {
        choices: [
          {
            text: parsed.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
            index: 0,
            finishReason: FINISH[parsed.finishReason] ?? 'stop',
          },
        ],
        ...(parsed.usage
          ? {
              usage: {
                inputTokens: parsed.usage.inputTokens,
                outputTokens: parsed.usage.outputTokens,
              },
            }
          : {}),
      };
    },
    meter: (value) =>
      value.usage
        ? { usage: value.usage, estimated: false }
        : {
            usage: {
              inputTokens: estimatedInputTokens,
              outputTokens: Math.ceil(value.choices.reduce((sum, c) => sum + c.text.length, 0) / 4),
            },
            estimated: true,
          },
  });
  if (!result.ok) {
    send(result.error, result.headers);
    return;
  }

  for (const [name, value] of Object.entries(result.headers ?? {})) void reply.header(name, value);
  void reply
    .header('x-dirouter-model', result.candidate.model.slug)
    .header('x-dirouter-provider', result.candidate.provider.slug);
  const usage = {
    prompt_tokens: result.metering.usage.inputTokens ?? 0,
    completion_tokens: result.metering.usage.outputTokens ?? 0,
    total_tokens:
      (result.metering.usage.inputTokens ?? 0) + (result.metering.usage.outputTokens ?? 0),
  };
  const id = `cmpl-${req.id}`;
  const created = Math.floor(Date.now() / 1000);
  const choices = result.value.choices.map((c) => ({
    text: c.text,
    index: c.index,
    logprobs: c.logprobs ?? null,
    finish_reason: c.finishReason,
  }));
  if (body.stream !== true) {
    reply.status(200).send({ id, object: 'text_completion', created, model, choices, usage });
    return;
  }
  const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  const base = { id, object: 'text_completion', created, model };
  const includeUsage =
    (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;
  const events = [
    ...choices.map((c) => chunk({ ...base, choices: [c] })),
    ...(includeUsage ? [chunk({ ...base, choices: [], usage })] : []),
    'data: [DONE]\n\n',
  ];
  reply
    .status(200)
    .header('content-type', 'text/event-stream; charset=utf-8')
    .header('cache-control', 'no-cache')
    .send(events.join(''));
}
