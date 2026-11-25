/** Native legacy completions (card 30.4): request per provider type and response parsing. */
import type { ModelConfig, ProviderConfig, ProviderType } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  nativeCompletionsRequest,
  parseCompletion,
  supportsNativeCompletions,
} from './completions.js';

const ctx = (type: ProviderType, baseUrl: string, options = {}) => ({
  provider: {
    id: 'p',
    organizationId: 'o',
    slug: type,
    type,
    name: type,
    baseUrl,
    enabled: true,
    options,
    credentials: [],
  } satisfies ProviderConfig,
  model: {
    id: 'm',
    organizationId: 'o',
    slug: 'instruct',
    providerId: 'p',
    upstreamModel: 'gpt-3.5-turbo-instruct',
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
  } satisfies ModelConfig,
  apiKey: 'secret',
});

describe('native completions', () => {
  const body = { model: 'instruct', prompt: 'hi', echo: true, stream: true, stream_options: {} };

  it('OpenAI-style: the upstream model, never streaming, every other option kept', () => {
    const up = nativeCompletionsRequest(ctx('openai', 'https://api.openai.com/v1/'), body);
    expect(up?.url).toBe('https://api.openai.com/v1/completions');
    expect(up?.headers).toMatchObject({ authorization: 'Bearer secret' });
    expect(JSON.parse(String(up?.body))).toEqual({
      model: 'gpt-3.5-turbo-instruct',
      prompt: 'hi',
      echo: true,
    });
  });

  it('Azure: the deployment in the path with api-key, or Entra as Bearer', () => {
    const up = nativeCompletionsRequest(ctx('azure-openai', 'https://r.openai.azure.com'), body);
    expect(up?.url).toBe(
      'https://r.openai.azure.com/openai/deployments/gpt-3.5-turbo-instruct/completions?api-version=2024-10-21',
    );
    expect(up?.headers).toMatchObject({ 'api-key': 'secret' });
    expect(JSON.parse(String(up?.body))).toEqual({ prompt: 'hi', echo: true });
    const entra = nativeCompletionsRequest(
      ctx('azure-openai', 'https://r.openai.azure.com', { authMode: 'entra', apiVersion: 'v9' }),
      body,
    );
    expect(entra?.url).toMatch(/api-version=v9$/);
    expect(entra?.headers).toMatchObject({ authorization: 'Bearer secret' });
  });

  it('other provider types have no native endpoint', () => {
    expect(nativeCompletionsRequest(ctx('anthropic', 'https://x'), body)).toBeUndefined();
    expect(supportsNativeCompletions('gemini')).toBe(false);
  });

  it('parses choices and usage', () => {
    expect(
      parseCompletion({
        choices: [
          { text: 'a', index: 0, finish_reason: 'stop', logprobs: { tokens: ['a'] } },
          { text: 'b', finish_reason: null },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      }),
    ).toEqual({
      choices: [
        { text: 'a', index: 0, finishReason: 'stop', logprobs: { tokens: ['a'] } },
        { text: 'b', index: 1, finishReason: null },
      ],
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    expect(parseCompletion(null)).toEqual({ choices: [] });
  });
});
