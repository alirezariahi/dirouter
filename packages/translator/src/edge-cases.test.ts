import {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  anthropicBlockToCanonical,
  anthropicRequestToCanonical,
  anthropicResponseToCanonical,
  canonicalToAnthropicRequest,
  canonicalToOpenAIRequest,
  imageToUrl,
  openAIRequestToCanonical,
  openAIResponseToCanonical,
} from './index.js';

const canonical = {
  inboundApi: 'openai.chat' as const,
  model: 'm',
  system: [],
  messages: [],
  stream: false,
};

describe('translation compatibility edge cases', () => {
  it('preserves optional Anthropic arrays and error flags', () => {
    const request = AnthropicMessagesRequest.parse({
      model: 'c',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] },
            { type: 'tool_result', tool_use_id: 'e', content: 'failed', is_error: true },
            { type: 'tool_use', id: 'u', name: 'f', input: {} },
            { type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
      tools: [{ name: 'f', type: 'custom', input_schema: {} }],
      stop_sequences: [],
    });
    const result = anthropicRequestToCanonical(request);
    expect(result.messages[0]?.content).toHaveLength(2);
    expect(result.messages[1]?.content[1]).toMatchObject({ cache: true });
  });

  it('covers branch defaults in both response directions', () => {
    const input = anthropicResponseToCanonical(
      AnthropicMessagesResponse.parse({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'c',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 2 },
      }),
    );
    expect(input.usage?.inputTokens).toBe(3);
  });

  it('handles optional content, tool inputs and unknown output blocks safely', () => {
    expect(
      anthropicBlockToCanonical({ type: 'server_tool_use', id: 'x', name: 'web', input: {} }),
    ).toBeUndefined();
    const response = anthropicResponseToCanonical(
      AnthropicMessagesResponse.parse({
        id: 'msg_empty',
        type: 'message',
        role: 'assistant',
        model: 'c',
        content: [{ type: 'text', text: '' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    expect(response.content).toEqual([{ type: 'text', text: '' }]);
    expect(
      canonicalToAnthropicRequest(
        { ...canonical, responseFormat: { type: 'text' } },
        { upstreamModel: 'c' },
      ),
    ).toMatchObject({ max_tokens: 4096 });
    expect(
      anthropicResponseToCanonical(
        AnthropicMessagesResponse.parse({
          id: 'msg_tools',
          type: 'message',
          role: 'assistant',
          model: 'c',
          content: [{ type: 'tool_use', id: 't', name: 'f', input: null }],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      ).content,
    ).toEqual([{ type: 'tool_call', id: 't', name: 'f', arguments: '{}' }]);
  });

  it('normalizes text alternatives and keeps optional OpenAI response fields', () => {
    const req = OpenAIChatCompletionRequest.parse({
      model: 'm',
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,A', detail: 'high' } },
          ],
        },
      ],
      stop: [],
    });
    const translated = openAIRequestToCanonical(req);
    expect(translated.system).toHaveLength(2);
    expect(canonicalToOpenAIRequest(translated, { upstreamModel: 'm' }).messages).toBeDefined();
    expect(imageToUrl({ kind: 'base64', mediaType: 'image/png', data: 'A' })).toBe(
      'data:image/png;base64,A',
    );
    const refusal = openAIResponseToCanonical(
      OpenAIChatCompletionResponse.parse({
        id: 'r',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null, refusal: 'no' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    expect(refusal).toMatchObject({ finishReason: 'refusal', content: [{ text: 'no' }] });
    expect(
      canonicalToOpenAIRequest(
        {
          ...canonical,
          tools: [{ name: 'f', description: 'd', strict: true, parameters: {} }],
          parallelToolCalls: false,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
          reasoning: { budgetTokens: 100 },
        },
        { upstreamModel: 'm' },
      ),
    ).toMatchObject({ parallel_tool_calls: false, reasoning_effort: 'low' });
  });
});
