import type { CanonicalRequest, CanonicalStreamEvent } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  GEMINI_SKIP_SIGNATURE,
  GeminiStreamDecoder,
  canonicalToGeminiRequest,
  decodeGeminiToolCallId,
  encodeGeminiToolCallId,
  geminiResponseToCanonical,
  geminiUsageToCanonical,
  toGeminiSchema,
} from './index.js';

const base = (over: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  inboundApi: 'openai.chat',
  model: 'x',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  stream: false,
  ...over,
});

type Body = {
  contents: { role: string; parts: Record<string, unknown>[] }[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: { functionDeclarations: { name: string; parameters: unknown }[] }[];
  toolConfig?: unknown;
  generationConfig?: Record<string, unknown>;
  safetySettings?: { category: string; threshold: string }[];
};

describe('canonical → Gemini request', () => {
  it('maps system, roles, generation config and default safety settings', () => {
    const drops: string[] = [];
    const body = canonicalToGeminiRequest(
      base({
        system: [
          { type: 'text', text: 'be brief' },
          { type: 'text', text: 'in Persian' },
        ],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }] },
          { role: 'user', content: [{ type: 'text', text: 'b' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
        ],
        maxOutputTokens: 77,
        temperature: 1.4,
        topP: 0.9,
        topK: 40,
        stop: ['END'],
        seed: 7,
        user: 'u1',
        responseFormat: { type: 'json_object' },
      }),
      { onDrop: (f) => drops.push(f) },
    ) as Body;
    expect(body.systemInstruction).toEqual({
      parts: [{ text: 'be brief' }, { text: 'in Persian' }],
    });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
      { role: 'model', parts: [{ text: 'c' }] },
    ]);
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 77,
      temperature: 1.4,
      topP: 0.9,
      topK: 40,
      stopSequences: ['END'],
      seed: 7,
      responseMimeType: 'application/json',
    });
    expect(body.safetySettings).toHaveLength(4);
    expect(body.safetySettings?.every((s) => s.threshold === 'BLOCK_NONE')).toBe(true);
    expect(drops).toContain('user');
  });

  it('safety settings can be overridden by threshold or list', () => {
    const t = canonicalToGeminiRequest(base(), { safetyThreshold: 'BLOCK_ONLY_HIGH' }) as Body;
    expect(t.safetySettings?.[0]?.threshold).toBe('BLOCK_ONLY_HIGH');
    const custom = [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_LOW_AND_ABOVE' }];
    const l = canonicalToGeminiRequest(base(), { safetySettings: custom }) as Body;
    expect(l.safetySettings).toEqual(custom);
  });

  it('images become inlineData or fileData', () => {
    const body = canonicalToGeminiRequest(
      base({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAA' } },
              { type: 'image', source: { kind: 'url', url: 'https://x.test/cat.webp?s=1' } },
            ],
          },
        ],
      }),
    ) as Body;
    expect(body.contents[0]?.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'AAA' } },
      { fileData: { mimeType: 'image/webp', fileUri: 'https://x.test/cat.webp?s=1' } },
    ]);
  });

  it('tools, tool choice and a full tool round trip', () => {
    const id = encodeGeminiToolCallId('call_1', 'SIG==');
    const body = canonicalToGeminiRequest(
      base({
        tools: [
          {
            name: 'get_weather',
            description: 'weather',
            parameters: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              type: 'object',
              additionalProperties: false,
              properties: {
                city: { type: 'string' },
                unit: { type: ['string', 'null'], enum: ['c', 'f'] },
                days: { const: 3 },
              },
              required: ['city'],
            },
          },
        ],
        toolChoice: { name: 'get_weather' },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', id, name: 'get_weather', arguments: '{"city":"Tehran"}' },
              { type: 'tool_call', id: 'call_2', name: 'get_weather', arguments: '{"city":"Qom"}' },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: id,
                content: [{ type: 'text', text: '{"c":18}' }],
              },
              {
                type: 'tool_result',
                toolCallId: 'call_2',
                content: [{ type: 'text', text: 'offline' }],
                isError: true,
              },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
        ],
      }),
    ) as Body;
    expect(body.tools?.[0]?.functionDeclarations[0]).toEqual({
      name: 'get_weather',
      description: 'weather',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          unit: { type: 'string', nullable: true, enum: ['c', 'f'] },
          days: { enum: ['3'], type: 'string' },
        },
        required: ['city'],
      },
    });
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [
        {
          functionCall: { name: 'get_weather', args: { city: 'Tehran' } },
          thoughtSignature: 'SIG==',
        },
        { functionCall: { name: 'get_weather', args: { city: 'Qom' } } },
      ],
    });
    // functionResponses come before the user text in the same user turn, and the function name is found from the tool_call.
    expect(body.contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'get_weather', response: { c: 18 } } },
        { functionResponse: { name: 'get_weather', response: { error: 'offline' } } },
        { text: 'thanks' },
      ],
    });
  });

  it('an unsigned function call from another model gets the documented skip signature', () => {
    const body = canonicalToGeminiRequest(
      base({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'toolu_1', name: 'f', arguments: '' }],
          },
        ],
      }),
    ) as Body;
    expect(body.contents[1]?.parts[0]).toEqual({
      functionCall: { name: 'f', args: {} },
      thoughtSignature: GEMINI_SKIP_SIGNATURE,
    });
  });

  it('tool choice modes and reasoning budget', () => {
    const mode = (toolChoice: CanonicalRequest['toolChoice']) =>
      (canonicalToGeminiRequest(base({ toolChoice })) as Body).toolConfig;
    expect(mode('auto')).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(mode('none')).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(mode('required')).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    const r = canonicalToGeminiRequest(base({ reasoning: { effort: 'low' } })) as Body;
    expect(r.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 1024,
      includeThoughts: true,
    });
  });

  it('json_schema becomes responseSchema in the Gemini subset', () => {
    const body = canonicalToGeminiRequest(
      base({
        responseFormat: {
          type: 'json_schema',
          name: 'x',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { a: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
          },
        },
      }),
    ) as Body;
    expect(body.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { a: { anyOf: [{ type: 'string' }, { type: 'integer' }] } },
      },
    });
  });

  it('schema sanitizer drops empty object properties and nested unknown keys', () => {
    expect(
      toGeminiSchema({
        type: 'object',
        properties: {},
        items: { type: 'string', $comment: 'x' },
      }),
    ).toEqual({ type: 'object', items: { type: 'string' } });
  });
});

describe('Gemini response → canonical', () => {
  it('text, usage with thoughts and cache, finish reasons', () => {
    const res = geminiResponseToCanonical(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'thinking…', thought: true }, { text: 'Hel' }, { text: 'lo' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 40,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 25,
          toolUsePromptTokenCount: 5,
        },
        modelVersion: 'gemini-2.5-flash-001',
        responseId: 'r1',
      },
      { model: 'gemini-2.5-flash' },
    );
    expect(res).toMatchObject({
      id: 'r1',
      model: 'gemini-2.5-flash-001',
      finishReason: 'stop',
      rawFinishReason: 'STOP',
      content: [
        { type: 'reasoning', text: 'thinking…' },
        { type: 'text', text: 'Hello' },
      ],
      usage: {
        inputTokens: 105,
        outputTokens: 35,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        reasoningTokens: 25,
      },
    });
  });

  it('function calls finish as tool_calls and carry the thought signature in the id', () => {
    const res = geminiResponseToCanonical(
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'get_weather', args: { city: 'Tehran' } },
                  thoughtSignature: 'S1',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
      { model: 'g' },
    );
    expect(res.finishReason).toBe('tool_calls');
    expect(res.usage).toBeUndefined();
    const call = res.content[0];
    expect(call?.type).toBe('tool_call');
    if (call?.type !== 'tool_call') return;
    expect(JSON.parse(call.arguments)).toEqual({ city: 'Tehran' });
    expect(decodeGeminiToolCallId(call.id).signature).toBe('S1');
  });

  it('a blocked prompt and safety finishes become content_filter', () => {
    expect(
      geminiResponseToCanonical({ promptFeedback: { blockReason: 'SAFETY' } }, { model: 'g' })
        .finishReason,
    ).toBe('content_filter');
    for (const reason of ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT'])
      expect(
        geminiResponseToCanonical({ candidates: [{ finishReason: reason }] }, { model: 'g' })
          .finishReason,
      ).toBe('content_filter');
    expect(
      geminiResponseToCanonical({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, { model: 'g' })
        .finishReason,
    ).toBe('length');
  });

  it('usage defaults to zeros', () => {
    expect(geminiUsageToCanonical(undefined).inputTokens).toBe(0);
  });
});

describe('Gemini stream → canonical', () => {
  it('text chunks, cumulative usage reported once, finish closes blocks', () => {
    const d = new GeminiStreamDecoder('gemini-x');
    const events: CanonicalStreamEvent[] = [
      ...d.push({
        candidates: [{ content: { parts: [{ text: 'Hel' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
        responseId: 'r',
      }),
      ...d.push({
        candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
    ];
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text_delta',
      'text_delta',
      'content_end',
      'usage',
      'finish',
    ]);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    expect(events.at(-1)).toMatchObject({ finishReason: 'stop' });
  });

  it('function calls arrive whole and finish as tool_calls', () => {
    const d = new GeminiStreamDecoder('g');
    const events = d.push({
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: 'plan' },
              { functionCall: { name: 'a', args: { x: 1 } }, thoughtSignature: 'S' },
              { functionCall: { name: 'b' } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'reasoning_delta',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_start',
      'tool_call_delta',
      'content_end',
      'content_end',
      'content_end',
      'finish',
    ]);
    const starts = events.filter((e) => e.type === 'tool_call_start');
    expect(starts.map((e) => e.index)).toEqual([1, 2]);
    expect(events.find((e) => e.type === 'tool_call_delta')).toMatchObject({
      argumentsDelta: '{"x":1}',
    });
    expect(events.at(-1)).toMatchObject({ finishReason: 'tool_calls' });
  });

  it('a second finish is ignored', () => {
    const d = new GeminiStreamDecoder('g');
    d.push({ candidates: [{ finishReason: 'STOP' }] });
    expect(d.push({ candidates: [{ finishReason: 'STOP' }] })).toEqual([]);
  });
});
