import { AnthropicMessagesRequest, OpenAIChatCompletionResponse } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  anthropicRequestToCanonical,
  canonicalToAnthropicResponse,
  canonicalToOpenAIRequest,
  openAIResponseToCanonical,
} from './index.js';

describe('remaining API defaults', () => {
  it('keeps optional request fields and responses with no usage', () => {
    const req = anthropicRequestToCanonical(
      AnthropicMessagesRequest.parse({
        model: 'c',
        max_tokens: 100,
        top_k: 5,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't',
                content: [{ type: 'image', source: { type: 'url', url: 'https://x/i' } }],
              },
            ],
          },
        ],
      }),
    );
    expect(req.topK).toBe(5);
    expect(
      openAIResponseToCanonical(
        OpenAIChatCompletionResponse.parse({
          id: 'r',
          object: 'chat.completion',
          created: 1,
          model: 'm',
          choices: [],
        }),
      ).usage,
    ).toBeUndefined();
    expect(
      canonicalToOpenAIRequest(
        {
          inboundApi: 'anthropic.messages',
          model: 'm',
          system: [],
          stream: false,
          messages: [
            { role: 'assistant', content: [{ type: 'tool_result', toolCallId: 'x', content: [] }] },
          ],
          topK: 1,
          seed: 1,
          metadata: { a: '1' },
        },
        { upstreamModel: 'g', onDrop: () => undefined },
      ),
    ).toHaveProperty('seed');
    expect(
      canonicalToAnthropicResponse(
        {
          id: 'msg_x',
          model: 'm',
          content: [{ type: 'image', source: { kind: 'url', url: 'x' } }],
          finishReason: 'other',
          created: 1,
        },
        { model: 'c' },
      ).id,
    ).toBe('msg_x');
  });
});
