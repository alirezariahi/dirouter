import { describe, expect, it } from 'vitest';

import { canonicalToGeminiRequest, geminiResponseToCanonical, toGeminiSchema } from './index.js';

const base = {
  inboundApi: 'openai.chat' as const,
  model: 'm',
  system: [],
  messages: [],
  stream: false,
};

describe('Gemini optional protocol variants', () => {
  it('normalizes unusual schemas, tool results and generation options', () => {
    expect(toGeminiSchema(null)).toBeNull();
    expect(toGeminiSchema([{ type: ['string', 'null', 'integer'] }])).toEqual([
      { nullable: true, anyOf: [{ type: 'string' }, { type: 'integer' }] },
    ]);
    expect(toGeminiSchema({ enum: [1, true] })).toEqual({ enum: ['1', 'true'], type: 'string' });
    const drops: string[] = [];
    const body = canonicalToGeminiRequest(
      {
        ...base,
        messages: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: 'missing',
                content: [
                  { type: 'text', text: '[1]' },
                  { type: 'image', source: { kind: 'url', url: 'https://x/noext' } },
                ],
              },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', id: 'f', name: 'f', arguments: 'null' },
              { type: 'reasoning', text: 'hidden' },
            ],
          },
        ],
        parallelToolCalls: false,
        reasoning: { budgetTokens: 2_000 },
        responseFormat: { type: 'json_schema', name: 'x', schema: {} },
      },
      { onDrop: (field) => drops.push(field) },
    );
    expect(body.contents).toHaveLength(2);
    expect(drops).toEqual(
      expect.arrayContaining(['tool_result.image', 'assistant.reasoning', 'parallel_tool_calls']),
    );
    expect(
      geminiResponseToCanonical(
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'f', id: 'known' } }] },
              finishReason: 'OTHER',
            },
          ],
        },
        { model: 'g' },
      ).finishReason,
    ).toBe('other');
  });
});
