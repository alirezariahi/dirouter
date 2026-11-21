/**
 * Contract tests for the Sprint-2 provider adapters (cards 11.3 and 11.4):
 * Cohere native v2, Mistral, Voyage/Jina embeddings, and the cheap-provider presets.
 */
import type {
  CanonicalRequest,
  ModelConfig,
  ProviderConfig,
  ProviderType,
} from '@dirouter/contracts';
import { SseParser } from '@dirouter/translator';
import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_BATCH_CONTRACT_MAX,
  MAX_EMBEDDING_BATCH,
  PRESETS,
  adapterFor,
  hasAdapter,
  maxEmbeddingBatch,
  presetFor,
} from './index.js';

const provider = (type: ProviderType, over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p',
  organizationId: 'o',
  slug: 's',
  type,
  name: 'n',
  baseUrl: 'https://example.test/v1',
  enabled: true,
  options: {},
  credentials: [],
  ...over,
});

const model = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  id: 'm',
  organizationId: 'o',
  slug: 'm',
  providerId: 'p',
  upstreamModel: 'command-r-plus',
  enabled: true,
  pricing: { inputPerMTok: '1', outputPerMTok: '2' },
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    reasoning: false,
    jsonMode: false,
    embeddings: false,
  },
  ...over,
});

const request = (over: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  inboundApi: 'openai.chat',
  model: 'm',
  system: [{ type: 'text', text: 'be brief' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  stream: false,
  ...over,
});

describe('Cohere native adapter', () => {
  it('builds a v2 chat request with tools and Cohere sampling fields', () => {
    const built = adapterFor('cohere').buildRequest({
      provider: provider('cohere', { baseUrl: 'https://api.cohere.com' }),
      model: model(),
      apiKey: 'co-key',
      request: request({
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 200,
        stop: ['END'],
        tools: [{ name: 'weather', description: 'forecast', parameters: { type: 'object' } }],
        toolChoice: 'required',
      }),
    });
    expect(built.url).toBe('https://api.cohere.com/v2/chat');
    expect(built.headers.authorization).toBe('Bearer co-key');
    const body = JSON.parse(built.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'command-r-plus',
      max_tokens: 200,
      temperature: 0.2,
      p: 0.9,
      k: 40,
      stop_sequences: ['END'],
      tool_choice: 'REQUIRED',
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'weather', description: 'forecast', parameters: { type: 'object' } },
      },
    ]);
  });

  it('parses text, tool calls, finish reason and usage', () => {
    const parsed = adapterFor('cohere').parseResponse({
      id: 'co-1',
      message: {
        content: [{ type: 'text', text: 'sunny' }],
        tool_calls: [
          { id: 'call-1', function: { name: 'weather', arguments: '{"city":"Tehran"}' } },
        ],
      },
      finish_reason: 'TOOL_CALL',
      usage: { tokens: { input_tokens: 11, output_tokens: 7 } },
    });
    expect(parsed.id).toBe('co-1');
    expect(parsed.finishReason).toBe('tool_calls');
    expect(parsed.content).toEqual([
      { type: 'text', text: 'sunny' },
      { type: 'tool_call', id: 'call-1', name: 'weather', arguments: '{"city":"Tehran"}' },
    ]);
    expect(parsed.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
  });

  it('decodes Cohere stream events into canonical deltas', () => {
    const decoder = adapterFor('cohere').createStreamDecoder();
    const parser = new SseParser();
    const events = [
      { type: 'message-start', id: 'co-stream' },
      { type: 'content-delta', delta: { message: { content: { text: 'hel' } } } },
      { type: 'content-delta', delta: { message: { content: { text: 'lo' } } } },
      {
        type: 'message-end',
        delta: {
          finish_reason: 'COMPLETE',
          usage: { tokens: { input_tokens: 3, output_tokens: 2 } },
        },
      },
    ];
    const canonical = events.flatMap((event) =>
      decoder.push({ event: 'message', data: JSON.stringify(event) }),
    );
    expect(canonical.map((event) => event.type)).toEqual([
      'start',
      'text_delta',
      'text_delta',
      'usage',
      'finish',
    ]);
    expect(
      canonical
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('hello');
    expect(parser).toBeDefined();
  });

  it.each([
    ['a single object (documented v2 shape)', (call: unknown) => call],
    ['a one-element array', (call: unknown) => [call]],
  ])('decodes streamed tool calls sent as %s', (_label, wrap) => {
    const decoder = adapterFor('cohere').createStreamDecoder();
    const events = [
      { type: 'message-start', id: 'co-tools' },
      { type: 'tool-plan-delta', delta: { message: { tool_plan: 'I will look it up' } } },
      {
        type: 'tool-call-start',
        index: 0,
        delta: {
          message: {
            tool_calls: wrap({
              id: 'get_weather_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '' },
            }),
          },
        },
      },
      {
        type: 'tool-call-delta',
        index: 0,
        delta: { message: { tool_calls: wrap({ function: { arguments: '{"city":' } }) } },
      },
      {
        type: 'tool-call-delta',
        index: 0,
        delta: { message: { tool_calls: wrap({ function: { arguments: '"Tehran"}' } }) } },
      },
      { type: 'tool-call-end', index: 0 },
      {
        type: 'message-end',
        delta: {
          finish_reason: 'TOOL_CALL',
          usage: { tokens: { input_tokens: 9, output_tokens: 4 } },
        },
      },
    ];
    const canonical = events.flatMap((event) =>
      decoder.push({ event: 'message', data: JSON.stringify(event) }),
    );
    const start = canonical.find((event) => event.type === 'tool_call_start');
    expect(start).toMatchObject({ id: 'get_weather_1', name: 'get_weather' });
    const deltas = canonical.filter((event) => event.type === 'tool_call_delta');
    expect(deltas.map((event) => event.argumentsDelta).join('')).toBe('{"city":"Tehran"}');
    expect(deltas.every((event) => event.index === start?.index)).toBe(true);
    expect(canonical.at(-1)).toMatchObject({ type: 'finish', finishReason: 'tool_calls' });
  });

  it('uses Cohere /v2/embed and parses float embeddings', () => {
    const adapter = adapterFor('cohere');
    const built = adapter.buildEmbeddingsRequest?.({
      provider: provider('cohere', { baseUrl: 'https://api.cohere.com' }),
      model: model({ upstreamModel: 'embed-multilingual-v3.0' }),
      apiKey: 'co-key',
      texts: ['a', 'b'],
    });
    expect(built?.url).toBe('https://api.cohere.com/v2/embed');
    expect(JSON.parse(built?.body ?? '{}')).toMatchObject({
      model: 'embed-multilingual-v3.0',
      texts: ['a', 'b'],
      input_type: 'search_document',
    });
    expect(
      adapter.parseEmbeddingsResponse?.({
        embeddings: {
          float: [
            [0.1, 0.2],
            [0.3, 0.4],
          ],
        },
        meta: { billed_units: { input_tokens: 8 } },
      }),
    ).toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      usage: { inputTokens: 8 },
    });
  });
});

describe('Mistral and cheap-provider presets', () => {
  it('routes Mistral through the native OpenAI-compatible endpoint without stream_options', () => {
    const built = adapterFor('mistral').buildRequest({
      provider: provider('mistral', { baseUrl: 'https://api.mistral.ai/v1' }),
      model: model({ upstreamModel: 'mistral-large-latest' }),
      apiKey: 'ms-key',
      request: request({ stream: true }),
    });
    expect(built.url).toBe('https://api.mistral.ai/v1/chat/completions');
    const body = JSON.parse(built.body ?? '{}') as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toBeUndefined();
  });

  it.each([
    ['zai', 'https://api.z.ai/api/paas/v4'],
    ['moonshot', 'https://api.moonshot.ai/v1'],
    ['minimax', 'https://api.minimax.io/v1'],
    ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['siliconflow', 'https://api.siliconflow.cn/v1'],
  ])('preset %s points at the documented base URL', (name, url) => {
    expect(PRESETS[name]?.baseUrl).toBe(url);
    expect(presetFor(provider('openai-compatible', { options: { preset: name } })).baseUrl).toBe(
      url,
    );
  });
});

describe('Gemini embeddings', () => {
  const gemini = provider('gemini', { baseUrl: 'https://generativelanguage.googleapis.com' });

  it('repeats the model in every batchEmbedContents request', () => {
    const adapter = adapterFor('gemini');
    const built = adapter.buildEmbeddingsRequest?.({
      provider: gemini,
      model: model({ upstreamModel: 'models/gemini-embedding-001' }),
      apiKey: 'g-key',
      texts: ['one', 'two'],
      dimensions: 768,
    });
    expect(built?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
    );
    expect(JSON.parse(built?.body ?? '{}')).toEqual({
      requests: [
        {
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text: 'one' }] },
          outputDimensionality: 768,
        },
        {
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text: 'two' }] },
          outputDimensionality: 768,
        },
      ],
    });
    expect(
      adapter.parseEmbeddingsResponse?.({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }),
    ).toEqual({
      vectors: [
        [1, 2],
        [3, 4],
      ],
    });
  });

  it('uses embedContent for a single text', () => {
    const adapter = adapterFor('gemini');
    const built = adapter.buildEmbeddingsRequest?.({
      provider: gemini,
      model: model({ upstreamModel: 'gemini-embedding-001' }),
      apiKey: 'g-key',
      texts: ['one'],
    });
    expect(built?.url).toContain('/models/gemini-embedding-001:embedContent');
    expect(JSON.parse(built?.body ?? '{}')).toEqual({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: 'one' }] },
    });
    expect(adapter.parseEmbeddingsResponse?.({ embedding: { values: [0.5] } })).toEqual({
      vectors: [[0.5]],
    });
  });
});

describe('embedding batch limits', () => {
  it('exposes the per-provider maximum for one upstream call', () => {
    expect(MAX_EMBEDDING_BATCH.cohere).toBe(96);
    expect(maxEmbeddingBatch(provider('cohere'))).toBe(96);
    expect(maxEmbeddingBatch(provider('gemini'))).toBe(100);
    expect(maxEmbeddingBatch(provider('voyage'))).toBe(1000);
    expect(maxEmbeddingBatch(provider('openai'))).toBe(EMBEDDING_BATCH_CONTRACT_MAX);
    // Types without a known limit fall back to the contract maximum.
    expect(maxEmbeddingBatch(provider('mistral'))).toBe(EMBEDDING_BATCH_CONTRACT_MAX);
    expect(maxEmbeddingBatch(provider('openai-compatible'))).toBe(2048);
  });

  it('lets provider options override the limit, capped by the contract', () => {
    expect(
      maxEmbeddingBatch(provider('openai-compatible', { options: { maxEmbeddingBatch: 32 } })),
    ).toBe(32);
    expect(maxEmbeddingBatch(provider('cohere', { options: { maxEmbeddingBatch: 9999 } }))).toBe(
      2048,
    );
    for (const bad of [0, -1, 1.5, '16'])
      expect(maxEmbeddingBatch(provider('cohere', { options: { maxEmbeddingBatch: bad } }))).toBe(
        96,
      );
  });
});

describe('Voyage and Jina embedding adapters', () => {
  it('registers adapters for the new provider types', () => {
    for (const type of ['cohere', 'mistral', 'voyage', 'jina'] as ProviderType[])
      expect(hasAdapter(type)).toBe(true);
  });

  it('builds and parses Voyage embeddings', () => {
    const adapter = adapterFor('voyage');
    const built = adapter.buildEmbeddingsRequest?.({
      provider: provider('voyage', { baseUrl: 'https://api.voyageai.com/v1' }),
      model: model({ upstreamModel: 'voyage-3' }),
      apiKey: 'vo-key',
      texts: ['one', 'two'],
      dimensions: 512,
    });
    expect(built?.url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(JSON.parse(built?.body ?? '{}')).toMatchObject({
      model: 'voyage-3',
      input: ['one', 'two'],
      output_dimension: 512,
    });
    expect(
      adapter.parseEmbeddingsResponse?.({
        data: [
          { embedding: [1, 2], index: 1 },
          { embedding: [3, 4], index: 0 },
        ],
        usage: { total_tokens: 9 },
      }),
    ).toEqual({
      vectors: [
        [3, 4],
        [1, 2],
      ],
      usage: { inputTokens: 9 },
    });
  });

  it('builds and parses Jina embeddings', () => {
    const adapter = adapterFor('jina');
    const built = adapter.buildEmbeddingsRequest?.({
      provider: provider('jina', { baseUrl: 'https://api.jina.ai/v1' }),
      model: model({ upstreamModel: 'jina-embeddings-v3' }),
      apiKey: 'ji-key',
      texts: ['x'],
    });
    expect(built?.url).toBe('https://api.jina.ai/v1/embeddings');
    expect(
      adapter.parseEmbeddingsResponse?.({
        data: [{ embedding: [0.5, 0.6], index: 0 }],
        usage: { total_tokens: 2 },
      }),
    ).toEqual({ vectors: [[0.5, 0.6]], usage: { inputTokens: 2 } });
  });

  it('refuses chat requests for embeddings-only providers', () => {
    expect(() =>
      adapterFor('voyage').buildRequest({
        provider: provider('voyage'),
        model: model(),
        apiKey: 'k',
        request: request(),
      }),
    ).toThrow(/only supports embeddings/);
  });
});
