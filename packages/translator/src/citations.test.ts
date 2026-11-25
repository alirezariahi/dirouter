/**
 * Card 31.7: citations, log probabilities and server-side tools across the formats. Golden
 * answers with sources from Anthropic, OpenAI and Gemini, each encoded for every client format.
 */
import {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
  type CanonicalResponse,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  ResponsesRequest,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  AnthropicStreamDecoder,
  AnthropicStreamEncoder,
  anthropicRequestToCanonical,
  anthropicResponseToCanonical,
  canonicalToAnthropicRequest,
  canonicalToAnthropicResponse,
  canonicalToGeminiRequest,
  canonicalToGeminiResponse,
  canonicalToOpenAIRequest,
  canonicalToOpenAIResponse,
  canonicalToResponsesResponse,
  geminiRequestToCanonical,
  geminiResponseToCanonical,
  OpenAIStreamEncoder,
  openAIRequestToCanonical,
  openAIResponseToCanonical,
  ResponsesStreamEncoder,
  responsesRequestToCanonical,
  SseParser,
  UnsupportedContentError,
} from './index.js';

const URL_A = 'https://example.org/tehran-weather';
const URL_B = 'https://example.org/climate';

/** Every client format of one canonical answer. */
const encodeAll = (answer: CanonicalResponse) => ({
  openai: canonicalToOpenAIResponse(answer, { model: 'm' }),
  responses: canonicalToResponsesResponse(answer, { model: 'm' }),
  anthropic: canonicalToAnthropicResponse(answer, { model: 'm' }),
  gemini: canonicalToGeminiResponse(answer, { model: 'm' }),
});

describe('golden: citations from Anthropic (web search and a document)', () => {
  const answer = anthropicResponseToCanonical(
    AnthropicMessagesResponse.parse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'text', text: 'Weather report: ' },
        {
          type: 'text',
          text: 'Tehran is sunny today.',
          citations: [
            {
              type: 'web_search_result_location',
              url: URL_A,
              title: 'Tehran weather',
              encrypted_index: 'Eo8BCioIAhgBIiQ',
              cited_text: 'Sunny, 21°C',
            },
          ],
        },
        {
          type: 'text',
          text: ' The report says so.',
          citations: [
            {
              type: 'char_location',
              cited_text: 'It will be sunny.',
              document_index: 0,
              document_title: 'Report',
              start_char_index: 10,
              end_char_index: 27,
            },
          ],
        },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 8 },
    }),
  );
  const out = encodeAll(answer);
  const text = 'Weather report: Tehran is sunny today. The report says so.';

  it('canonical keeps both kinds', () => {
    expect(answer.content[1]).toMatchObject({
      citations: [{ kind: 'url', url: URL_A, title: 'Tehran weather', citedText: 'Sunny, 21°C' }],
    });
    expect(answer.content[2]).toMatchObject({
      citations: [{ kind: 'document', documentIndex: 0, location: 'char', from: 10, to: 27 }],
    });
  });

  it('OpenAI Chat: a url_citation over the cited text in the message', () => {
    const message = out.openai.choices[0]?.message as { content: string; annotations?: unknown };
    expect(message.content).toBe(text);
    expect(message.annotations).toEqual([
      {
        type: 'url_citation',
        url_citation: { url: URL_A, title: 'Tehran weather', start_index: 16, end_index: 38 },
      },
    ]);
    expect(text.slice(16, 38)).toBe('Tehran is sunny today.');
    expect(OpenAIChatCompletionResponse.safeParse(out.openai).success).toBe(true);
  });

  it('Responses: output_text annotations', () => {
    const message = out.responses.output[0] as { content: { annotations: unknown[] }[] };
    expect(message.content[0]?.annotations).toEqual([
      { type: 'url_citation', url: URL_A, title: 'Tehran weather', start_index: 16, end_index: 38 },
    ]);
  });

  it('Anthropic: the same citations on the same blocks', () => {
    expect(out.anthropic.content).toEqual([
      { type: 'text', text: 'Weather report: ' },
      {
        type: 'text',
        text: 'Tehran is sunny today.',
        citations: [
          {
            type: 'web_search_result_location',
            url: URL_A,
            title: 'Tehran weather',
            cited_text: 'Sunny, 21°C',
            encrypted_index: '',
          },
        ],
      },
      {
        type: 'text',
        text: ' The report says so.',
        citations: [
          {
            type: 'char_location',
            cited_text: 'It will be sunny.',
            document_index: 0,
            document_title: 'Report',
            start_char_index: 10,
            end_char_index: 27,
          },
        ],
      },
    ]);
    expect(AnthropicMessagesResponse.safeParse(out.anthropic).success).toBe(true);
  });

  it('Gemini: groundingMetadata with a support over the cited segment', () => {
    expect(out.gemini.candidates[0]).toMatchObject({
      groundingMetadata: {
        groundingChunks: [{ web: { uri: URL_A, title: 'Tehran weather' } }],
        groundingSupports: [
          {
            segment: { startIndex: 16, endIndex: 38, text: 'Tehran is sunny today.' },
            groundingChunkIndices: [0],
          },
        ],
      },
    });
  });
});

describe('golden: citations from OpenAI (a search model)', () => {
  const text = 'It is sunny [1] and dry [2].';
  const answer = openAIResponseToCanonical(
    OpenAIChatCompletionResponse.parse({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5-search-api',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text,
            annotations: [
              {
                type: 'url_citation',
                url_citation: { url: URL_A, title: 'A', start_index: 12, end_index: 15 },
              },
              {
                type: 'url_citation',
                url_citation: { url: URL_B, title: 'B', start_index: 24, end_index: 27 },
              },
            ],
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
    }),
  );
  const out = encodeAll(answer);

  it('round trip to OpenAI keeps the offsets', () => {
    expect(
      (out.openai.choices[0]?.message as unknown as { annotations: unknown[] }).annotations,
    ).toEqual([
      {
        type: 'url_citation',
        url_citation: { url: URL_A, title: 'A', start_index: 12, end_index: 15 },
      },
      {
        type: 'url_citation',
        url_citation: { url: URL_B, title: 'B', start_index: 24, end_index: 27 },
      },
    ]);
  });

  it('Anthropic: web_search_result_location citations on the text', () => {
    expect(out.anthropic.content).toEqual([
      {
        type: 'text',
        text,
        citations: [
          {
            type: 'web_search_result_location',
            url: URL_A,
            title: 'A',
            cited_text: '',
            encrypted_index: '',
          },
          {
            type: 'web_search_result_location',
            url: URL_B,
            title: 'B',
            cited_text: '',
            encrypted_index: '',
          },
        ],
      },
    ]);
  });

  it('Gemini: one chunk per source', () => {
    const grounding = (out.gemini.candidates[0] as { groundingMetadata: Record<string, unknown> })
      .groundingMetadata;
    expect(grounding.groundingChunks).toEqual([
      { web: { uri: URL_A, title: 'A' } },
      { web: { uri: URL_B, title: 'B' } },
    ]);
    expect(grounding.groundingSupports).toEqual([
      { segment: { startIndex: 12, endIndex: 15, text: '[1]' }, groundingChunkIndices: [0] },
      { segment: { startIndex: 24, endIndex: 27, text: '[2]' }, groundingChunkIndices: [1] },
    ]);
  });
});

describe('golden: citations from Gemini (Google Search grounding, byte offsets)', () => {
  // Persian text: Gemini counts UTF-8 bytes, OpenAI counts characters.
  const first = 'تهران آفتابی است.';
  const second = ' Tehran is sunny.';
  const firstBytes = Buffer.byteLength(first);
  const answer = geminiResponseToCanonical(
    {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: first + second }] },
          finishReason: 'STOP',
          groundingMetadata: {
            groundingChunks: [{ web: { uri: URL_A, title: 'example.org' } }],
            groundingSupports: [
              {
                segment: { startIndex: 0, endIndex: firstBytes, text: first },
                groundingChunkIndices: [0],
              },
              {
                segment: {
                  startIndex: firstBytes + 1,
                  endIndex: firstBytes + second.length,
                  text: second.trim(),
                },
                groundingChunkIndices: [0],
              },
            ],
            webSearchQueries: ['tehran weather'],
          },
        },
      ],
    },
    { model: 'gemini-2.5-pro' },
  );
  const out = encodeAll(answer);

  it('OpenAI: character offsets', () => {
    const annotations = (out.openai.choices[0]?.message as unknown as { annotations: unknown[] })
      .annotations;
    expect(annotations).toEqual([
      {
        type: 'url_citation',
        url_citation: { url: URL_A, title: 'example.org', start_index: 0, end_index: first.length },
      },
      {
        type: 'url_citation',
        url_citation: {
          url: URL_A,
          title: 'example.org',
          start_index: first.length + 1,
          end_index: first.length + second.length,
        },
      },
    ]);
  });

  it('Gemini round trip: the same byte offsets and one chunk', () => {
    expect(out.gemini.candidates[0]).toMatchObject({
      groundingMetadata: {
        groundingChunks: [{ web: { uri: URL_A, title: 'example.org' } }],
        groundingSupports: [
          {
            segment: { startIndex: 0, endIndex: firstBytes, text: first },
            groundingChunkIndices: [0],
          },
          {
            segment: { startIndex: firstBytes + 1, endIndex: firstBytes + second.length },
            groundingChunkIndices: [0],
          },
        ],
      },
    });
  });

  it('Anthropic: the source on the text', () => {
    expect(out.anthropic.content[0]).toMatchObject({
      type: 'text',
      citations: [
        { type: 'web_search_result_location', url: URL_A },
        { type: 'web_search_result_location', url: URL_A },
      ],
    });
  });
});

describe('stream: an Anthropic citations_delta reaches every client format', () => {
  const upstream = [
    {
      type: 'message_start',
      message: {
        id: 'msg_s',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sunny today.' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'web_search_result_location',
          url: URL_A,
          title: 'A',
          encrypted_index: 'x',
          cited_text: 'Sunny',
        },
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: 'message_stop' },
  ].map((e) => AnthropicStreamEvent.parse(e));
  const decoder = new AnthropicStreamDecoder();
  const events = upstream.flatMap((e) => decoder.push(e));
  const run = (encoder: { push: (e: (typeof events)[number]) => string; end: () => string }) => {
    const wire = events.map((e) => encoder.push(e)).join('') + encoder.end();
    const parser = new SseParser();
    return [...parser.feed(wire), ...parser.flush()]
      .filter((e) => e.data !== '[DONE]')
      .map((e) => JSON.parse(e.data) as Record<string, unknown>);
  };

  it('decodes to a canonical citation event', () => {
    expect(events).toContainEqual({
      type: 'citation',
      index: 0,
      citation: { kind: 'url', url: URL_A, title: 'A', citedText: 'Sunny' },
    });
  });

  it('Anthropic client: a citations_delta on the text block', () => {
    const out = run(new AnthropicStreamEncoder({ model: 'm' }));
    expect(out).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'web_search_result_location',
          url: URL_A,
          title: 'A',
          cited_text: 'Sunny',
          encrypted_index: '',
        },
      },
    });
  });

  it('OpenAI client: a delta with annotations over the text so far', () => {
    const out = run(new OpenAIStreamEncoder({ model: 'm', includeUsage: false }));
    const deltas = out.map((c) => (c.choices as { delta: Record<string, unknown> }[])[0]?.delta);
    expect(deltas).toContainEqual({
      annotations: [
        {
          type: 'url_citation',
          url_citation: { url: URL_A, title: 'A', start_index: 0, end_index: 12 },
        },
      ],
    });
  });

  it('Responses client: annotation.added and the annotation in the finished message', () => {
    const out = run(new ResponsesStreamEncoder({ model: 'm' }));
    const annotation = {
      type: 'url_citation',
      url: URL_A,
      title: 'A',
      start_index: 0,
      end_index: 12,
    };
    expect(out.find((e) => e.type === 'response.output_text.annotation.added')).toMatchObject({
      annotation_index: 0,
      annotation,
    });
    const done = out.find((e) => e.type === 'response.output_item.done');
    expect(
      (done?.item as { content: { annotations: unknown[] }[] }).content[0]?.annotations,
    ).toEqual([annotation]);
  });
});

describe('log probabilities', () => {
  const chat = (body: Record<string, unknown>) =>
    openAIRequestToCanonical(
      OpenAIChatCompletionRequest.parse({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        ...body,
      }),
    );

  it('an OpenAI request asks OpenAI and Gemini for them; Anthropic reports a parameter drop', () => {
    const request = chat({ logprobs: true, top_logprobs: 2 });
    expect(request.logprobs).toEqual({ top: 2 });
    expect(request.passthrough).toBeUndefined();
    expect(canonicalToOpenAIRequest(request, { upstreamModel: 'gpt' })).toMatchObject({
      logprobs: true,
      top_logprobs: 2,
    });
    expect(canonicalToGeminiRequest(request, {}).generationConfig).toEqual({
      responseLogprobs: true,
      logprobs: 2,
    });
    const drops: string[] = [];
    canonicalToAnthropicRequest(request, {
      upstreamModel: 'claude',
      onDrop: (field, _reason, kind) => drops.push(`${field}:${kind ?? ''}`),
    });
    expect(drops).toEqual(['logprobs:parameter']);
  });

  it('Responses and Gemini clients ask for them too', () => {
    expect(
      responsesRequestToCanonical(
        ResponsesRequest.parse({
          model: 'm',
          input: 'hi',
          include: ['message.output_text.logprobs'],
          top_logprobs: 3,
        }),
      ).logprobs,
    ).toEqual({ top: 3 });
    expect(
      geminiRequestToCanonical(
        {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { responseLogprobs: true },
        },
        { model: 'g' },
      ).logprobs,
    ).toEqual({});
  });

  it("OpenAI's log probabilities reach Responses and Gemini clients; Gemini's reach OpenAI", () => {
    const answer = openAIResponseToCanonical(
      OpenAIChatCompletionResponse.parse({
        id: 'c',
        object: 'chat.completion',
        created: 1,
        model: 'gpt',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hi' },
            finish_reason: 'stop',
            logprobs: {
              content: [
                {
                  token: 'Hi',
                  logprob: -0.1,
                  bytes: [72, 105],
                  top_logprobs: [
                    { token: 'Hi', logprob: -0.1, bytes: [72, 105] },
                    { token: 'Hello', logprob: -2.5, bytes: [72, 101, 108, 108, 111] },
                  ],
                },
              ],
              refusal: null,
            },
          },
        ],
      }),
    );
    expect(answer.logprobs).toEqual([
      {
        token: 'Hi',
        logprob: -0.1,
        top: [
          { token: 'Hi', logprob: -0.1 },
          { token: 'Hello', logprob: -2.5 },
        ],
      },
    ]);
    const responses = canonicalToResponsesResponse(answer, { model: 'm' });
    expect(
      (responses.output[0] as { content: { logprobs: unknown }[] }).content[0]?.logprobs,
    ).toEqual([
      {
        token: 'Hi',
        logprob: -0.1,
        bytes: [72, 105],
        top_logprobs: [
          { token: 'Hi', logprob: -0.1, bytes: [72, 105] },
          { token: 'Hello', logprob: -2.5, bytes: [72, 101, 108, 108, 111] },
        ],
      },
    ]);
    expect(canonicalToGeminiResponse(answer, { model: 'm' }).candidates[0]).toMatchObject({
      logprobsResult: {
        chosenCandidates: [{ token: 'Hi', logProbability: -0.1 }],
        topCandidates: [
          {
            candidates: [
              { token: 'Hi', logProbability: -0.1 },
              { token: 'Hello', logProbability: -2.5 },
            ],
          },
        ],
      },
    });

    const fromGemini = geminiResponseToCanonical(
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hi' }] },
            finishReason: 'STOP',
            logprobsResult: {
              chosenCandidates: [{ token: 'Hi', logProbability: -0.2 }],
              topCandidates: [{ candidates: [{ token: 'Hi', logProbability: -0.2 }] }],
            },
          },
        ],
      },
      { model: 'g' },
    );
    expect(canonicalToOpenAIResponse(fromGemini, { model: 'm' }).choices[0]?.logprobs).toEqual({
      content: [
        {
          token: 'Hi',
          logprob: -0.2,
          bytes: [72, 105],
          top_logprobs: [{ token: 'Hi', logprob: -0.2, bytes: [72, 105] }],
        },
      ],
      refusal: null,
    });
  });
});

describe('server-side tools', () => {
  const anthropic = (tools: unknown[]) =>
    anthropicRequestToCanonical(
      AnthropicMessagesRequest.parse({
        model: 'claude',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Search the weather' }],
        tools,
      }),
    );

  it("Anthropic's web search reaches OpenAI and Gemini; Anthropic keeps its own definition", () => {
    const tool = {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3,
      allowed_domains: ['example.org'],
    };
    const request = anthropic([tool]);
    expect(request.serverTools).toEqual([
      { type: 'web_search', maxUses: 3, allowedDomains: ['example.org'] },
    ]);
    expect(canonicalToOpenAIRequest(request, { upstreamModel: 'gpt-5-search-api' })).toMatchObject({
      web_search_options: {},
    });
    expect(canonicalToGeminiRequest(request, {}).tools).toEqual([{ googleSearch: {} }]);
    expect(canonicalToAnthropicRequest(request, { upstreamModel: 'claude' }).tools).toEqual([tool]);
  });

  it('a Responses client: web search and the code interpreter reach Claude and Gemini', () => {
    const request = responsesRequestToCanonical(
      ResponsesRequest.parse({
        model: 'm',
        input: 'hi',
        tools: [
          { type: 'web_search', filters: { allowed_domains: ['example.org'] } },
          { type: 'code_interpreter', container: { type: 'auto' } },
        ],
      }),
    );
    expect(canonicalToAnthropicRequest(request, { upstreamModel: 'claude' }).tools).toEqual([
      {
        type: 'web_search_20250305',
        name: 'web_search',
        allowed_domains: ['example.org'],
      },
      { type: 'code_execution_20250825', name: 'code_execution' },
    ]);
    expect(canonicalToGeminiRequest(request, {}).tools).toEqual([
      { googleSearch: {} },
      { codeExecution: {} },
    ]);
    // OpenAI Chat has no code execution: a clear error instead of a silent drop.
    expect(() => canonicalToOpenAIRequest(request, { upstreamModel: 'gpt' })).toThrow(
      UnsupportedContentError,
    );
    expect(() => canonicalToOpenAIRequest(request, { upstreamModel: 'gpt' })).toThrow(
      "OpenAI Chat has no equivalent of the server tool 'code_execution'",
    );
  });

  it('a Gemini client: Google Search and URL context reach Claude', () => {
    const request = geminiRequestToCanonical(
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        tools: [{ googleSearch: {} }, { urlContext: {} }],
      },
      { model: 'g' },
    );
    expect(canonicalToAnthropicRequest(request, { upstreamModel: 'claude' }).tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
      { type: 'web_fetch_20250910', name: 'web_fetch' },
    ]);
  });

  it('an Anthropic-only tool (computer use) is refused clearly elsewhere', () => {
    const request = anthropic([
      {
        type: 'computer_20250124',
        name: 'computer',
        display_width_px: 1024,
        display_height_px: 768,
      },
    ]);
    expect(() => canonicalToGeminiRequest(request, {})).toThrow(
      "Gemini has no equivalent of the server tool 'computer_20250124'",
    );
    expect(() => canonicalToOpenAIRequest(request, { upstreamModel: 'gpt' })).toThrow(
      UnsupportedContentError,
    );
  });
});
