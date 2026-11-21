/**
 * Gemini inbound (card 11.1): Gemini clients → canonical, and canonical → Gemini responses.
 * These are the golden tests for tool calls and streaming that the card asks for.
 */
import {
  type CanonicalResponse,
  type CanonicalStreamEvent,
  GeminiGenerateContentRequest,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  GeminiInboundStreamEncoder,
  canonicalToGeminiResponse,
  canonicalUsageForEstimate,
  encodeGeminiToolCallId,
  geminiRequestToCanonical,
  geminiUsageToMetadata,
  imageFromUrl,
  imageToUrl,
} from './index.js';

const request = (
  over: Partial<GeminiGenerateContentRequest> = {},
): GeminiGenerateContentRequest => ({
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  ...over,
});

const response = (over: Partial<CanonicalResponse> = {}): CanonicalResponse => ({
  id: 'cmpl_1',
  model: 'gemini-2.5-flash',
  content: [{ type: 'text', text: 'hi there' }],
  finishReason: 'stop',
  created: 1_700_000_000,
  ...over,
});

describe('Gemini inbound request → canonical', () => {
  it('resolves the model from the URL path and maps system instructions', () => {
    const canonical = geminiRequestToCanonical(
      request({
        systemInstruction: { parts: [{ text: 'be brief' }, { text: 'answer in Persian' }] },
      }),
      { model: 'gemini-2.5-flash' },
    );
    expect(canonical.inboundApi).toBe('gemini.generate');
    expect(canonical.model).toBe('gemini-2.5-flash');
    expect(canonical.system).toEqual([
      { type: 'text', text: 'be brief' },
      { type: 'text', text: 'answer in Persian' },
    ]);
    expect(canonical.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('maps generation config, thinking budget and stream flag', () => {
    const canonical = geminiRequestToCanonical(
      request({
        stream: true,
        generationConfig: {
          maxOutputTokens: 128,
          temperature: 0.3,
          topP: 0.8,
          topK: 20,
          stopSequences: ['END'],
          thinkingConfig: { thinkingBudget: 512 },
        },
      }),
      { model: 'm' },
    );
    expect(canonical).toMatchObject({
      stream: true,
      maxOutputTokens: 128,
      temperature: 0.3,
      topP: 0.8,
      topK: 20,
      stop: ['END'],
      reasoning: { budgetTokens: 512 },
    });
  });

  it('maps JSON response mime types to structured output', () => {
    expect(
      geminiRequestToCanonical(
        request({ generationConfig: { responseMimeType: 'application/json' } }),
        { model: 'm' },
      ).responseFormat,
    ).toEqual({ type: 'json_object' });
    expect(
      geminiRequestToCanonical(
        request({
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        }),
        { model: 'm' },
      ).responseFormat,
    ).toMatchObject({ type: 'json_schema', name: 'gemini_response' });
  });

  it('maps tool declarations and function calling modes', () => {
    const canonical = geminiRequestToCanonical(
      request({
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'forecast',
                parameters: { type: 'object', properties: { city: { type: 'string' } } },
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      }),
      { model: 'm' },
    );
    expect(canonical.tools).toEqual([
      {
        name: 'get_weather',
        description: 'forecast',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
    expect(canonical.toolChoice).toBe('required');
    expect(
      geminiRequestToCanonical(
        request({ toolConfig: { functionCallingConfig: { mode: 'NONE' } } }),
        { model: 'm' },
      ).toolChoice,
    ).toBe('none');
    expect(
      geminiRequestToCanonical(
        request({ toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }),
        { model: 'm' },
      ).toolChoice,
    ).toBe('auto');
  });

  it('round-trips a function call and its response', () => {
    const canonical = geminiRequestToCanonical(
      request({
        contents: [
          { role: 'user', parts: [{ text: 'weather in Tehran?' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: { name: 'get_weather', args: { city: 'Tehran' } },
                thoughtSignature: 'sig-1',
              },
            ],
          },
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'get_weather', response: { result: 'sunny' } } }],
          },
        ],
      }),
      { model: 'm' },
    );
    const call = canonical.messages[1]?.content[0];
    expect(call).toMatchObject({
      type: 'tool_call',
      name: 'get_weather',
      arguments: '{"city":"Tehran"}',
    });
    const result = canonical.messages[2]?.content[0];
    expect(result).toMatchObject({ type: 'tool_result', content: [{ text: 'sunny' }] });
    expect(result?.type === 'tool_result' ? result.toolCallId : '').toBe(
      call?.type === 'tool_call' ? call.id : '',
    );
  });

  it('puts tool results in a tool message and gives same-name calls distinct ids', () => {
    const contents: GeminiGenerateContentRequest['contents'] = [
      { role: 'user', parts: [{ text: 'compare a.txt and b.txt' }] },
      {
        role: 'model',
        parts: [
          { text: 'Reading both.' },
          { functionCall: { name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 's1' },
          { functionCall: { name: 'read_file', args: { path: 'b.txt' } } },
          { functionCall: { name: 'list_dir', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', response: { result: 'AAA' } } },
          { functionResponse: { name: 'list_dir', response: { result: 'a.txt b.txt' } } },
          { functionResponse: { name: 'read_file', response: { result: 'BBB' } } },
          { text: 'also check c.txt' },
        ],
      },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'c.txt' } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read_file', response: { result: 'CCC' } } }],
      },
    ];
    const canonical = geminiRequestToCanonical(request({ contents }), { model: 'm' });
    const first = encodeGeminiToolCallId('call_read_file_0', 's1');
    expect(canonical.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'compare a.txt and b.txt' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading both.' },
          { type: 'tool_call', id: first, name: 'read_file', arguments: '{"path":"a.txt"}' },
          {
            type: 'tool_call',
            id: 'call_read_file_1',
            name: 'read_file',
            arguments: '{"path":"b.txt"}',
          },
          { type: 'tool_call', id: 'call_list_dir_2', name: 'list_dir', arguments: '{}' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolCallId: first, content: [{ type: 'text', text: 'AAA' }] },
          {
            type: 'tool_result',
            toolCallId: 'call_list_dir_2',
            content: [{ type: 'text', text: 'a.txt b.txt' }],
          },
          {
            type: 'tool_result',
            toolCallId: 'call_read_file_1',
            content: [{ type: 'text', text: 'BBB' }],
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'also check c.txt' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            id: 'call_read_file_3',
            name: 'read_file',
            arguments: '{"path":"c.txt"}',
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'call_read_file_3',
            content: [{ type: 'text', text: 'CCC' }],
          },
        ],
      },
    ]);
    // The client resends the history every turn: a longer history keeps the earlier ids.
    const shorter = geminiRequestToCanonical(request({ contents: contents.slice(0, 3) }), {
      model: 'm',
    });
    expect(shorter.messages).toEqual(canonical.messages.slice(0, 4));
  });

  it('pairs responses by the id the client echoes, in any order', () => {
    const canonical = geminiRequestToCanonical(
      request({
        contents: [
          {
            role: 'model',
            parts: [
              { functionCall: { id: 'x1', name: 'read_file', args: {} }, thoughtSignature: 'sig' },
              { functionCall: { id: 'x2', name: 'read_file', args: {} } },
              { functionCall: { name: 'read_file', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [
              { functionResponse: { id: 'x2', name: 'read_file', response: { result: 'two' } } },
              { functionResponse: { id: 'stale', name: 'read_file', response: { result: 'one' } } },
              { functionResponse: { name: 'read_file', response: { result: 'three' } } },
              { functionResponse: { id: 'orphan', name: 'other', response: { result: 'o1' } } },
              { functionResponse: { name: 'other', response: { result: 'o2' } } },
            ],
          },
        ],
      }),
      { model: 'm' },
    );
    expect(canonical.messages[0]?.content.map((p) => (p.type === 'tool_call' ? p.id : ''))).toEqual(
      [encodeGeminiToolCallId('x1', 'sig'), 'x2', 'call_read_file_0'],
    );
    expect(canonical.messages[1]?.role).toBe('tool');
    expect(
      canonical.messages[1]?.content.map((p) =>
        p.type === 'tool_result' ? [p.toolCallId, p.content[0]] : [],
      ),
    ).toEqual([
      ['x2', { type: 'text', text: 'two' }],
      // An id that matches no call falls back to first-in, first-out by name.
      [encodeGeminiToolCallId('x1', 'sig'), { type: 'text', text: 'one' }],
      ['call_read_file_0', { type: 'text', text: 'three' }],
      // Responses without any matching call keep the client id or get a generated one.
      ['orphan', { type: 'text', text: 'o1' }],
      ['call_other_1', { type: 'text', text: 'o2' }],
    ]);
    expect(canonical.messages).toHaveLength(2);
  });

  it('accepts parametersJsonSchema, VALIDATED mode and unknown fields', () => {
    const body: unknown = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hi', partMetadata: { a: 1 } }, { fileData: { fileUri: 'gs://b/o' } }],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'read_file',
              description: 'Reads a file',
              parametersJsonSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
              },
              responseJsonSchema: { type: 'object' },
              behavior: 'BLOCKING',
            },
            {
              name: 'legacy',
              parameters: {
                type: 'OBJECT',
                properties: {
                  type: { type: 'STRING', enum: ['A', 'B'] },
                  tags: { type: 'ARRAY', items: { type: 'STRING' } },
                  size: { anyOf: [{ type: 'INTEGER' }, { type: 'NULL' }, true] },
                  raw: 'kept',
                },
              },
            },
            { name: 'bare' },
          ],
        },
        { googleSearch: {} },
      ],
      toolConfig: {
        functionCallingConfig: { mode: 'VALIDATED', allowedFunctionNames: ['read_file'] },
        retrievalConfig: { languageCode: 'fa' },
      },
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        thinkingConfig: { thinkingBudget: -1, thinkingLevel: 'HIGH', includeThoughts: true },
        mediaResolution: 'MEDIA_RESOLUTION_LOW',
      },
      labels: { team: 'x' },
    };
    const parsed = GeminiGenerateContentRequest.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const canonical = geminiRequestToCanonical(parsed.data, { model: 'm' });
    expect(canonical.tools).toEqual([
      {
        name: 'read_file',
        description: 'Reads a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        name: 'legacy',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['A', 'B'] },
            tags: { type: 'array', items: { type: 'string' } },
            size: { anyOf: [{ type: 'integer' }, { type: 'null' }, true] },
            raw: 'kept',
          },
        },
      },
      { name: 'bare', parameters: { type: 'object', properties: {} } },
    ]);
    expect(canonical.toolChoice).toBe('auto');
    expect(canonical.responseFormat).toEqual({
      type: 'json_schema',
      name: 'gemini_response',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    // A negative budget means "dynamic" and is not a token count.
    expect(canonical.reasoning).toEqual({ effort: 'high' });
    expect(canonical.messages[0]?.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', source: { kind: 'url', url: 'gs://b/o' } },
    ]);
    expect(
      GeminiGenerateContentRequest.safeParse({
        contents: [],
        toolConfig: { functionCallingConfig: { mode: 'SOMETIMES' } },
      }).success,
    ).toBe(false);
  });

  it('maps ANY with allowed function names and ignores unknown thinking levels', () => {
    const choice = (names?: string[]) => {
      const drops: string[] = [];
      const canonical = geminiRequestToCanonical(
        request({
          toolConfig: {
            functionCallingConfig: {
              mode: 'ANY',
              ...(names ? { allowedFunctionNames: names } : {}),
            },
          },
          generationConfig: { thinkingConfig: { thinkingLevel: 'EXTREME' } },
        }),
        { model: 'm', onDrop: (field) => drops.push(field) },
      );
      expect(canonical.reasoning).toBeUndefined();
      return [canonical.toolChoice, drops.length];
    };
    expect(choice(['only'])).toEqual([{ name: 'only' }, 0]);
    expect(choice(['a', 'b'])).toEqual(['required', 1]);
    expect(choice([])).toEqual(['required', 0]);
    expect(choice()).toEqual(['required', 0]);
    expect(
      geminiRequestToCanonical(
        request({ toolConfig: { functionCallingConfig: { mode: 'MODE_UNSPECIFIED' } } }),
        { model: 'm' },
      ).toolChoice,
    ).toBeUndefined();
  });

  it('maps thought parts, inline images and reports dropped parts', () => {
    const drops: string[] = [];
    const canonical = geminiRequestToCanonical(
      request({
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'look', thought: true },
              { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
              { fileData: { fileUri: 'https://example.test/cat.png', mimeType: 'image/png' } },
              { executableCode: { language: 'PYTHON', code: 'print(1)' } },
            ],
          },
        ],
      }),
      { model: 'm', onDrop: (field) => drops.push(field) },
    );
    expect(canonical.messages[0]?.content).toEqual([
      { type: 'reasoning', text: 'look' },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { kind: 'url', url: 'https://example.test/cat.png' } },
    ]);
    expect(drops).toEqual(['contents[].parts[]']);
  });

  it('reads tool results from a structured response and image helpers round-trip data URLs', () => {
    const canonical = geminiRequestToCanonical(
      request({
        contents: [
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'get_weather', response: { city: 'Tehran', temp: 31 } } },
            ],
          },
        ],
      }),
      { model: 'm' },
    );
    const result = canonical.messages[0]?.content[0];
    expect(result?.type === 'tool_result' ? result.content : []).toEqual([
      { type: 'text', text: '{"city":"Tehran","temp":31}' },
    ]);
    const base64 = imageFromUrl('data:image/png;base64,QUJD');
    expect(base64).toEqual({ kind: 'base64', mediaType: 'image/png', data: 'QUJD' });
    expect(imageToUrl(base64)).toBe('data:image/png;base64,QUJD');
    const normal = imageFromUrl('https://example.test/cat.png');
    expect(normal).toEqual({ kind: 'url', url: 'https://example.test/cat.png' });
    expect(imageToUrl(normal)).toBe('https://example.test/cat.png');
  });
});

describe('canonical → Gemini response', () => {
  it('encodes text, usage and the model version', () => {
    const body = canonicalToGeminiResponse(
      response({
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          reasoningTokens: 1,
        },
      }),
      { model: 'gemini-2.5-flash', responseId: 'resp-1' },
    );
    expect(body).toMatchObject({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'hi there' }] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      modelVersion: 'gemini-2.5-flash',
      responseId: 'resp-1',
    });
    expect(body.usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 4,
      thoughtsTokenCount: 1,
      cachedContentTokenCount: 2,
      totalTokenCount: 14,
    });
  });

  it('encodes reasoning, tool calls and thought signatures', () => {
    const body = canonicalToGeminiResponse(
      response({
        content: [
          { type: 'reasoning', text: 'thinking' },
          {
            type: 'tool_call',
            id: encodeGeminiToolCallId('call_1', 'sig-1'),
            name: 'get_weather',
            arguments: '{"city":"Tehran"}',
          },
        ],
        finishReason: 'tool_calls',
      }),
      { model: 'm' },
    );
    expect(body.candidates[0]?.content.parts).toEqual([
      { text: 'thinking', thought: true },
      {
        functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'Tehran' } },
        thoughtSignature: 'sig-1',
      },
    ]);
    expect(body.candidates[0]?.finishReason).toBe('STOP');
  });

  it('skips canonical parts that Gemini cannot represent', () => {
    const body = canonicalToGeminiResponse(
      response({
        content: [
          {
            type: 'image',
            source: { kind: 'url', url: 'https://example.test/cat.png' },
          },
        ],
      }),
      { model: 'm' },
    );
    expect(body.candidates[0]?.content.parts).toEqual([]);
  });

  it('turns invalid tool arguments into an empty object', () => {
    const body = canonicalToGeminiResponse(
      response({
        content: [{ type: 'tool_call', id: 'call_x', name: 'broken', arguments: 'not json' }],
      }),
      { model: 'm' },
    );
    expect(body.candidates[0]?.content.parts).toEqual([
      { functionCall: { id: 'call_x', name: 'broken', args: {} } },
    ]);
  });

  it('maps finish reasons and estimates usage', () => {
    expect(
      canonicalToGeminiResponse(response({ finishReason: 'length' }), { model: 'm' }).candidates[0]
        ?.finishReason,
    ).toBe('MAX_TOKENS');
    expect(geminiUsageToMetadata(canonicalUsageForEstimate(7))).toMatchObject({
      promptTokenCount: 7,
      candidatesTokenCount: 0,
      totalTokenCount: 7,
    });
  });
});

describe('canonical → Gemini stream', () => {
  const drain = (encoder: GeminiInboundStreamEncoder, events: CanonicalStreamEvent[]) =>
    events.map((event) => encoder.push(event)).join('') + encoder.end();

  it('emits one SSE chunk per delta and a final chunk with finish and usage', () => {
    const encoder = new GeminiInboundStreamEncoder({ model: 'gemini-2.5-flash' });
    const sse = drain(encoder, [
      { type: 'start', id: 'cmpl_1', model: 'gemini-2.5-flash', created: 1 },
      { type: 'text_delta', index: 0, text: 'Hel' },
      { type: 'reasoning_delta', index: 0, text: 'why' },
      {
        type: 'usage',
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 1,
        },
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const chunks = sse
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as Record<string, unknown>);
    expect(chunks).toHaveLength(4);
    expect(chunks[1]).toMatchObject({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }],
      modelVersion: 'gemini-2.5-flash',
    });
    expect(chunks[2]).toMatchObject({
      candidates: [{ content: { parts: [{ text: 'why', thought: true }] } }],
    });
    expect(chunks[3]).toMatchObject({
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, thoughtsTokenCount: 1 },
    });
    expect(encoder.usage).toMatchObject({ inputTokens: 2, outputTokens: 3 });
  });

  const parse = (sse: string) =>
    sse
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as Record<string, unknown>);

  it('buffers streamed tool call arguments and emits one complete functionCall part', () => {
    const encoder = new GeminiInboundStreamEncoder({ model: 'm' });
    const chunks = parse(
      drain(encoder, [
        { type: 'start', id: 'x', model: 'm', created: 1 },
        {
          type: 'tool_call_start',
          index: 0,
          id: encodeGeminiToolCallId('call_1', 'sig-1'),
          name: 'get_weather',
        },
        { type: 'tool_call_delta', index: 0, argumentsDelta: '{"city"' },
        { type: 'tool_call_delta', index: 0, argumentsDelta: ':"Tehran","days":3}' },
        { type: 'content_end', index: 0 },
        { type: 'finish', finishReason: 'tool_calls' },
      ]),
    );
    expect(chunks).toEqual([
      {
        candidates: [{ content: { role: 'model', parts: [] }, index: 0 }],
        modelVersion: 'm',
        responseId: 'x',
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call_1',
                    name: 'get_weather',
                    args: { city: 'Tehran', days: 3 },
                  },
                  thoughtSignature: 'sig-1',
                },
              ],
            },
            index: 0,
          },
        ],
        modelVersion: 'm',
        responseId: 'x',
      },
      {
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
        modelVersion: 'm',
        responseId: 'x',
      },
    ]);
  });

  it('flushes calls that never received content_end, with {} for invalid arguments', () => {
    const calls = (events: CanonicalStreamEvent[]) =>
      parse(drain(new GeminiInboundStreamEncoder({ model: 'm' }), events)).flatMap((chunk) =>
        (
          chunk as { candidates: { content: { parts: { functionCall?: unknown }[] } }[] }
        ).candidates.flatMap((c) => c.content.parts.flatMap((p) => p.functionCall ?? [])),
      );
    // Two parallel calls closed only by the finish event share one chunk, in order.
    expect(
      calls([
        { type: 'tool_call_start', index: 1, id: 'a', name: 'read_file' },
        { type: 'tool_call_start', index: 2, id: 'b', name: 'read_file' },
        { type: 'tool_call_delta', index: 2, argumentsDelta: '{"path":"b"}' },
        { type: 'tool_call_delta', index: 1, argumentsDelta: '{"path":"a"}' },
        { type: 'tool_call_delta', index: 9, argumentsDelta: 'ignored' },
        { type: 'content_end', index: 9 },
        { type: 'finish', finishReason: 'tool_calls' },
      ]),
    ).toEqual([
      { id: 'a', name: 'read_file', args: { path: 'a' } },
      { id: 'b', name: 'read_file', args: { path: 'b' } },
    ]);
    // No finish event at all: end() still delivers the call.
    expect(
      calls([
        { type: 'tool_call_start', index: 0, id: 'c', name: 'broken' },
        { type: 'tool_call_delta', index: 0, argumentsDelta: '{"city"' },
      ]),
    ).toEqual([{ id: 'c', name: 'broken', args: {} }]);
    expect(calls([{ type: 'tool_call_start', index: 0, id: 'd', name: 'no_args' }])).toEqual([
      { id: 'd', name: 'no_args', args: {} },
    ]);
  });

  it('encodes stream errors in Gemini error shape', () => {
    const encoder = new GeminiInboundStreamEncoder({ model: 'm' });
    const sse = encoder.push({ type: 'error', code: 'upstream_error', message: 'boom' });
    expect(JSON.parse(sse.replace(/^data: /, ''))).toMatchObject({
      error: { code: 500, message: 'boom' },
    });
    expect(encoder.push({ type: 'never' } as never)).toBe('');
    expect(encoder.push({ type: 'reasoning_delta', index: 0, text: '' })).toBe('');
  });
});
