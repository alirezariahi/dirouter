/**
 * Card 27.3: prompt-cache breakpoints (`cache_control`, with TTL) survive the canonical model at
 * every place Anthropic accepts them.
 */
import { AnthropicMessagesRequest, OpenAIChatCompletionRequest } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  anthropicRequestToCanonical,
  canonicalToAnthropicRequest,
  canonicalToOpenAIRequest,
} from './index.js';

const EPHEMERAL = { type: 'ephemeral' };
const HOUR = { type: 'ephemeral', ttl: '1h' };

const roundTrip = (body: Record<string, unknown>) => {
  const request = AnthropicMessagesRequest.parse({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    ...body,
  });
  const canonical = anthropicRequestToCanonical(request);
  const out = canonicalToAnthropicRequest(canonical, { upstreamModel: 'claude-sonnet-4-5' });
  expect(AnthropicMessagesRequest.safeParse(out).success).toBe(true);
  return { canonical, out };
};

const user = (content: unknown[]) => [{ role: 'user', content }];

describe('golden: cache_control round trip per breakpoint location', () => {
  it('system block, with a 1h TTL', () => {
    const system = [
      { type: 'text', text: 'You are Claude Code.', cache_control: HOUR },
      { type: 'text', text: 'Project notes', cache_control: EPHEMERAL },
    ];
    const { canonical, out } = roundTrip({
      system,
      messages: user([{ type: 'text', text: 'hi' }]),
    });
    expect(canonical.system).toEqual([
      { type: 'text', text: 'You are Claude Code.', cache: true, cacheTtl: '1h' },
      { type: 'text', text: 'Project notes', cache: true },
    ]);
    expect(out.system).toEqual(system);
  });

  it('tool definition', () => {
    const tools = [
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'Edit', input_schema: { type: 'object' }, cache_control: EPHEMERAL },
    ];
    const { canonical, out } = roundTrip({ tools, messages: user([{ type: 'text', text: 'hi' }]) });
    expect(canonical.tools?.[1]).toMatchObject({ name: 'Edit', cache: true });
    expect(out.tools).toEqual(tools);
  });

  it.each([
    ['text', { type: 'text', text: 'long context', cache_control: HOUR }],
    [
      'image',
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBO' },
        cache_control: EPHEMERAL,
      },
    ],
    [
      'document',
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
        cache_control: HOUR,
      },
    ],
  ])('%s block in a user message', (_name, block) => {
    const { out } = roundTrip({ messages: user([block]) });
    expect((out.messages as { content: unknown[] }[])[0]?.content).toEqual([block]);
  });

  it('tool_use and tool_result (and text inside the result)', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Read',
            input: { path: 'a.ts' },
            cache_control: EPHEMERAL,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: 'file body', cache_control: EPHEMERAL }],
            cache_control: HOUR,
          },
        ],
      },
    ];
    const { canonical, out } = roundTrip({ messages });
    expect(canonical.messages[1]?.content[0]).toMatchObject({ type: 'tool_call', cache: true });
    expect(canonical.messages[2]?.content[0]).toMatchObject({
      type: 'tool_result',
      cache: true,
      cacheTtl: '1h',
    });
    expect(out.messages).toEqual(messages);
  });

  it('top-level automatic caching passes through to Anthropic', () => {
    const { out } = roundTrip({
      cache_control: EPHEMERAL,
      messages: user([{ type: 'text', text: 'hi' }]),
    });
    expect(out.cache_control).toEqual(EPHEMERAL);
  });
});

describe('cache markers to providers without explicit caching', () => {
  it('OpenAI receives the same content without cache fields', () => {
    const canonical = anthropicRequestToCanonical(
      AnthropicMessagesRequest.parse({
        model: 'x',
        max_tokens: 10,
        system: [{ type: 'text', text: 'sys', cache_control: EPHEMERAL }],
        tools: [{ name: 't', input_schema: { type: 'object' }, cache_control: EPHEMERAL }],
        messages: user([{ type: 'text', text: 'hi', cache_control: EPHEMERAL }]),
      }),
    );
    const body = canonicalToOpenAIRequest(canonical, { upstreamModel: 'gpt-4.1' });
    expect(OpenAIChatCompletionRequest.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain('cache');
  });
});
