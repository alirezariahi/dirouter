/**
 * Card 31.3: automatic prompt-cache breakpoints. Golden requests from an OpenAI-format client to
 * Claude, and the rule that a request with its own breakpoints is never changed.
 */
import { AnthropicMessagesRequest, OpenAIChatCompletionRequest } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  anthropicRequestToCanonical,
  canonicalToAnthropicRequest,
  hasCacheMarkers,
  injectCacheBreakpoints,
  openAIRequestToCanonical,
} from './index.js';

const EPHEMERAL = { type: 'ephemeral' };
const toClaude = (body: Record<string, unknown>, ttl?: string) => {
  const canonical = openAIRequestToCanonical(
    OpenAIChatCompletionRequest.parse({ model: 'claude', ...body }),
  );
  const { request, breakpoints } = injectCacheBreakpoints(canonical, ttl);
  const out = canonicalToAnthropicRequest(request, { upstreamModel: 'claude-sonnet-4-5' });
  expect(AnthropicMessagesRequest.safeParse(out).success).toBe(true);
  return { out, breakpoints };
};

const tool = (name: string) => ({
  type: 'function',
  function: { name, parameters: { type: 'object', properties: {} } },
});

describe('golden: breakpoints for an OpenAI-format request to Claude', () => {
  it('first turn: tools, system and the last message', () => {
    const { out, breakpoints } = toClaude({
      messages: [
        { role: 'system', content: 'You are a careful assistant.' },
        { role: 'system', content: 'Project rules: be brief.' },
        { role: 'user', content: 'What is 2+2?' },
      ],
      tools: [tool('read'), tool('write')],
    });
    expect(breakpoints).toEqual(['tools', 'system', 'last_message']);
    expect(out.tools).toEqual([
      { name: 'read', input_schema: { type: 'object', properties: {} } },
      { name: 'write', input_schema: { type: 'object', properties: {} }, cache_control: EPHEMERAL },
    ]);
    expect(out.system).toEqual([
      { type: 'text', text: 'You are a careful assistant.' },
      { type: 'text', text: 'Project rules: be brief.', cache_control: EPHEMERAL },
    ]);
    expect(out.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'What is 2+2?', cache_control: EPHEMERAL }],
      },
    ]);
  });

  it('second turn: also the turn the previous request ended with, at most four breakpoints', () => {
    const { out, breakpoints } = toClaude(
      {
        messages: [
          { role: 'system', content: 'You are a careful assistant.' },
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'And 3+3?' },
        ],
        tools: [tool('read')],
      },
      '1h',
    );
    const HOUR = { type: 'ephemeral', ttl: '1h' };
    expect(breakpoints).toEqual(['tools', 'system', 'last_message', 'previous_turn']);
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'What is 2+2?', cache_control: HOUR }] },
      { role: 'assistant', content: [{ type: 'text', text: '4' }] },
      { role: 'user', content: [{ type: 'text', text: 'And 3+3?', cache_control: HOUR }] },
    ]);
    expect(out.system).toEqual([
      { type: 'text', text: 'You are a careful assistant.', cache_control: HOUR },
    ]);
  });

  it('an agent loop: the breakpoint goes on the last tool result, not on reasoning', () => {
    const { out, breakpoints } = toClaude({
      messages: [
        { role: 'user', content: 'List files' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'a.ts b.ts' },
      ],
      tools: [tool('ls')],
    });
    expect(breakpoints).toEqual(['tools', 'last_message', 'previous_turn']);
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'List files', cache_control: EPHEMERAL }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'ls', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            content: [{ type: 'text', text: 'a.ts b.ts' }],
            cache_control: EPHEMERAL,
          },
        ],
      },
    ]);
  });
});

describe('requests with their own breakpoints are not changed', () => {
  const anthropic = (body: Record<string, unknown>) =>
    anthropicRequestToCanonical(
      AnthropicMessagesRequest.parse({ model: 'claude-sonnet-4-5', max_tokens: 100, ...body }),
    );

  it.each([
    [
      'system block',
      {
        system: [{ type: 'text', text: 'sys', cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: 'hi' }],
      },
    ],
    [
      'tool definition',
      {
        tools: [{ name: 't', input_schema: { type: 'object' }, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: 'hi' }],
      },
    ],
    [
      'message block',
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: EPHEMERAL }] },
        ],
      },
    ],
    [
      'text inside a tool result',
      {
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'ls', input: {} }] },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't',
                content: [{ type: 'text', text: 'x', cache_control: EPHEMERAL }],
              },
            ],
          },
        ],
      },
    ],
    [
      'top-level automatic cache_control',
      { cache_control: EPHEMERAL, messages: [{ role: 'user', content: 'hi' }] },
    ],
  ])('%s', (_name, body) => {
    const canonical = anthropic(body);
    expect(hasCacheMarkers(canonical)).toBe(true);
    const result = injectCacheBreakpoints(canonical);
    expect(result.breakpoints).toEqual([]);
    expect(result.request).toBe(canonical);
    // And the request that reaches Anthropic is exactly what the client sent.
    const out = canonicalToAnthropicRequest(result.request, { upstreamModel: 'claude-sonnet-4-5' });
    for (const [field, value] of Object.entries(body))
      if (field !== 'messages') expect(out[field]).toEqual(value);
  });

  it('a request with nothing cacheable stays as it is', () => {
    const canonical = anthropic({ messages: [{ role: 'user', content: [] }] });
    expect(injectCacheBreakpoints(canonical).request).toBe(canonical);
  });
});
