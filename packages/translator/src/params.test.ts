/**
 * Card 31.4: parameter defaults, overrides and removals per model, and drop_params. Golden
 * requests show what reaches each provider.
 */
import {
  AnthropicMessagesRequest,
  type CanonicalRequest,
  OpenAIChatCompletionRequest,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  anthropicRequestToCanonical,
  applyParamPolicy,
  applyUpstreamFields,
  canonicalToAnthropicRequest,
  canonicalToGeminiRequest,
  canonicalToOpenAIRequest,
  guardParameterDrops,
  openAIRequestToCanonical,
  UnsupportedContentError,
  UnsupportedParameterError,
} from './index.js';

const openai = (body: Record<string, unknown>) =>
  openAIRequestToCanonical(
    OpenAIChatCompletionRequest.parse({
      model: 'alias',
      messages: [{ role: 'user', content: 'hi' }],
      ...body,
    }),
  );
const target = { dropParams: true, target: "model 'm'" };

describe('golden: a policy on an OpenAI-format request', () => {
  const request = openai({ temperature: 0.9, top_k: 5, presence_penalty: 0.5, seed: 7 });

  it('to Claude: forced temperature, default max_tokens and top_p, native fields', () => {
    const { request: shaped, applied } = applyParamPolicy(
      request,
      {
        overrides: { temperature: 0.2, 'metadata.user_id': 'team-a' },
        defaults: { max_tokens: 2048, top_p: 0.9, temperature: 1 },
        drop: ['seed'],
      },
      target,
    );
    expect(applied).toEqual({
      overrides: ['temperature', 'metadata.user_id'],
      defaults: ['max_tokens', 'top_p'],
      dropped: ['seed'],
    });
    const drops: string[] = [];
    const body = canonicalToAnthropicRequest(shaped, {
      upstreamModel: 'claude-sonnet-4-5',
      onDrop: (field) => drops.push(field),
    });
    expect(AnthropicMessagesRequest.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      temperature: 0.2,
      max_tokens: 2048,
      top_p: 0.9,
      metadata: { user_id: 'team-a' },
    });
    expect(body.seed).toBeUndefined();
    // top_k and presence_penalty arrived as the OpenAI client's own extras: no Anthropic field.
    expect(drops).toEqual(['presence_penalty', 'top_k']);
  });

  it('to OpenAI: native fields set and removed in the provider body', () => {
    const { request: shaped } = applyParamPolicy(
      request,
      {
        overrides: { service_tier: 'flex', top_k: 40 },
        defaults: { presence_penalty: 0, frequency_penalty: 0.1 },
        drop: ['presence_penalty', 'stream_options'],
      },
      target,
    );
    const body = canonicalToOpenAIRequest(
      { ...shaped, stream: true },
      { upstreamModel: 'gpt-4.1' },
    );
    expect(body.service_tier).toBe('flex');
    // The client's presence_penalty is removed by `drop`; the default does not bring it back.
    expect(body.presence_penalty).toBeUndefined();
    expect(body.frequency_penalty).toBe(0.1);
    expect(body.stream_options).toBeUndefined();
    expect(body.seed).toBe(7);
  });

  it('to Gemini: a dotted path reaches a nested field', () => {
    const { request: shaped } = applyParamPolicy(
      openai({}),
      { overrides: { 'generationConfig.topK': 32, 'generationConfig.candidateCount': 1 } },
      target,
    );
    const body = canonicalToGeminiRequest(shaped, {});
    expect(body.generationConfig).toEqual({ topK: 32, candidateCount: 1 });
  });

  it('the same policy works on an Anthropic-format request', () => {
    const anthropic = anthropicRequestToCanonical(
      AnthropicMessagesRequest.parse({
        model: 'alias',
        max_tokens: 100,
        temperature: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    const { request: shaped } = applyParamPolicy(
      anthropic,
      { overrides: { temperature: 0, max_tokens: 50, stop: 'END' } },
      target,
    );
    const body = canonicalToOpenAIRequest(shaped, { upstreamModel: 'gpt-4.1' });
    expect(body).toMatchObject({ temperature: 0, max_tokens: 50, stop: ['END'] });
  });
});

describe('unsupported parameters and drop_params', () => {
  const request = openai({ top_k: 5, presence_penalty: 0.5 });
  const policy = { unsupported: ['top_k', 'presence_penalty', 'logit_bias'] };

  it('drop_params on: the parameters the model refuses are removed', () => {
    const { request: shaped, applied } = applyParamPolicy(request, policy, target);
    expect(applied.dropped).toEqual(['top_k', 'presence_penalty']);
    expect(shaped.topK).toBeUndefined();
    expect(shaped.passthrough?.presence_penalty).toBeUndefined();
  });

  it('drop_params off: a clear 400 naming every parameter present', () => {
    const run = () => applyParamPolicy(request, policy, { dropParams: false, target: "model 'm'" });
    expect(run).toThrow(UnsupportedParameterError);
    expect(run).toThrow(UnsupportedContentError);
    expect(run).toThrow(
      "Unsupported parameters for model 'm': 'top_k', 'presence_penalty'. Remove them, or set drop_params to true to have unsupported parameters dropped.",
    );
    // Absent parameters are never a reason to refuse.
    expect(applyParamPolicy(openai({}), policy, { ...target, dropParams: false }).applied).toEqual({
      overrides: [],
      defaults: [],
      dropped: [],
    });
  });

  it('drop_params off: a parameter the translator cannot carry is refused, content is not', () => {
    const seen: string[] = [];
    const strict = guardParameterDrops((field) => seen.push(field), {
      dropParams: false,
      target: "model 'gpt'",
    });
    // top_k from an Anthropic client has no OpenAI equivalent.
    const withTopK = anthropicRequestToCanonical(
      AnthropicMessagesRequest.parse({
        model: 'alias',
        max_tokens: 100,
        top_k: 5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(() =>
      canonicalToOpenAIRequest(withTopK, { upstreamModel: 'gpt', onDrop: strict }),
    ).toThrow("Unsupported parameter for model 'gpt': 'top_k'.");
    const claude = (req: CanonicalRequest) =>
      canonicalToAnthropicRequest(req, { upstreamModel: 'claude-sonnet-4-5', onDrop: strict });
    expect(() => claude(openai({ seed: 1 }))).toThrow("'seed'");
    expect(() => claude(openai({ logit_bias: { 1: 2 } }))).toThrow("'logit_bias'");
    // An unsigned reasoning part is content, not a parameter: only reported.
    const lenient = claude({
      ...openai({}),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'x' },
            { type: 'text', text: 'y' },
          ],
        },
      ],
    });
    expect(lenient.messages).toHaveLength(2);
    expect(seen).toEqual(['assistant.reasoning']);
  });

  it('a value of the wrong type in a policy is a 400 too', () => {
    expect(() =>
      applyParamPolicy(openai({}), { overrides: { temperature: 'hot' } }, target),
    ).toThrow("Parameter policy: 'temperature' must be a number");
    expect(() =>
      applyParamPolicy(openai({}), { defaults: { reasoning_effort: 'extreme' } }, target),
    ).toThrow(UnsupportedContentError);
  });
});

describe('applyUpstreamFields', () => {
  it('drops, fills defaults and forces values, nested or not', () => {
    const body: Record<string, unknown> = { a: 1, nested: { x: 1, y: 2 }, keep: true };
    applyUpstreamFields(body, {
      upstreamFields: {
        drop: ['a', 'nested.y', 'missing.path'],
        defaults: { 'nested.x': 9, 'nested.z': 3, b: 2 },
        set: { keep: false, 'deep.er': 1 },
      },
    });
    expect(body).toEqual({ nested: { x: 1, z: 3 }, keep: false, b: 2, deep: { er: 1 } });
  });

  it('does not walk through a non-object', () => {
    const body: Record<string, unknown> = { a: 'text' };
    applyUpstreamFields(body, { upstreamFields: { set: { 'a.b': 1 } } });
    expect(body).toEqual({ a: 'text' });
  });
});
