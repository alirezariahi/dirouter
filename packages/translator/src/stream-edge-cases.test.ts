import { AnthropicStreamEvent, OpenAIChatCompletionChunk } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  AnthropicStreamDecoder,
  AnthropicStreamEncoder,
  OpenAIStreamDecoder,
  OpenAIStreamEncoder,
} from './index.js';

describe('stream optional variants', () => {
  it('handles empty deltas, usage-only messages and duplicate finishes', () => {
    const decoder = new OpenAIStreamDecoder();
    const chunk = OpenAIChatCompletionChunk.parse({
      id: 'c',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 't', function: { name: 'f' } }] },
          finish_reason: null,
        },
      ],
    });
    expect(decoder.push(chunk).map((event) => event.type)).toEqual(['start', 'tool_call_start']);
    expect(
      decoder.push({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ).toHaveLength(2);
    expect(
      decoder.push({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ).toEqual([]);
    const anthropic = new AnthropicStreamDecoder();
    expect(
      anthropic.push(
        AnthropicStreamEvent.parse({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        }),
      ),
    ).toHaveLength(2);
    expect(anthropic.push(AnthropicStreamEvent.parse({ type: 'ping' }))).toEqual([]);
  });

  it('closes encoders consistently without usage or a start event', () => {
    const openai = new OpenAIStreamEncoder({ model: 'm', includeUsage: true });
    openai.push({ type: 'finish', finishReason: 'stop' });
    expect(openai.push({ type: 'finish', finishReason: 'stop' })).toBe('');
    expect(openai.end()).toContain('[DONE]');
    const anthropic = new AnthropicStreamEncoder({ model: 'm' });
    expect(anthropic.push({ type: 'content_end', index: 3 })).toBe('');
    expect(anthropic.end()).toContain('message_stop');
  });
});
