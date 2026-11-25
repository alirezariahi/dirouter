/**
 * Card 31.1: JSON and tool-call repair. A corpus of common broken JSON is repaired, valid JSON is
 * never touched, and broken tool histories become ones Anthropic, OpenAI and Gemini accept.
 */
import {
  AnthropicMessagesRequest,
  type CanonicalRequest,
  type CanonicalResponse,
  OpenAIChatCompletionRequest,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  anthropicRequestToCanonical,
  canonicalToAnthropicRequest,
  canonicalToGeminiRequest,
  canonicalToOpenAIRequest,
  openAIRequestToCanonical,
  parseRepairHeader,
  repairJson,
  repairResponse,
  repairToolHistory,
} from './index.js';

describe('repairJson: common broken JSON', () => {
  const cases: [string, string, unknown][] = [
    [
      'markdown fence',
      '```json\n{"city": "Tehran", "temp": 21}\n```',
      { city: 'Tehran', temp: 21 },
    ],
    ['bare fence', '```\n[1, 2, 3]\n```', [1, 2, 3]],
    [
      'prose around the object',
      'Sure! Here is the JSON:\n{"ok": true}\nLet me know if you need more.',
      { ok: true },
    ],
    ['trailing comma in object', '{"a": 1, "b": 2,}', { a: 1, b: 2 }],
    ['trailing comma in array', '{"tags": ["x", "y",]}', { tags: ['x', 'y'] }],
    ['single quotes', "{'name': 'Ali', 'note': 'say \"hi\"'}", { name: 'Ali', note: 'say "hi"' }],
    ['escaped single quote', "{'text': 'it\\'s'}", { text: "it's" }],
    ['unquoted keys', '{city: "Tehran", temp_c: 21}', { city: 'Tehran', temp_c: 21 }],
    [
      'python literals',
      "{'ok': True, 'err': None, 'done': False}",
      { ok: true, err: null, done: false },
    ],
    [
      'comments',
      '{\n  // the city\n  "city": "Tehran", /* celsius */ "temp": 21\n}',
      { city: 'Tehran', temp: 21 },
    ],
    [
      'truncated object',
      '{"city": "Tehran", "tags": ["a", "b"',
      { city: 'Tehran', tags: ['a', 'b'] },
    ],
    ['truncated string', '{"summary": "The weather is', { summary: 'The weather is' }],
    ['truncated after key', '{"a": 1, "b":', { a: 1, b: null }],
    ['missing comma between members', '{"a": 1 "b": 2}', { a: 1, b: 2 }],
    ['raw newline in a string', '{"text": "line one\nline two"}', { text: 'line one\nline two' }],
    ['leading plus and bare decimals', '{"x": +1, "y": .5, "z": 2.}', { x: 1, y: 0.5, z: 2 }],
    ['trailing text after the root', '{"a": [1, 2]} and that is all', { a: [1, 2] }],
  ];

  it.each(cases)('%s', (_name, broken, expected) => {
    const fixed = repairJson(broken);
    expect(fixed).toBeDefined();
    expect(JSON.parse(fixed ?? '')).toEqual(expected);
  });

  it.each([
    '{"a": 1}',
    '[]',
    '"just a string"',
    '42',
    'null',
    '{"nested": {"deep": [1, {"x": "y"}]}, "s": "with, commas: and } braces"}',
    '  {"padded": true}  ',
  ])('leaves valid JSON untouched: %s', (valid) => {
    expect(repairJson(valid)).toBeUndefined();
  });

  it.each([
    'I could not find the weather.',
    '{"a": nonsense value}',
    '{"a": 1 + 2}',
    '{"a": @}',
    '',
  ])('gives up on text it cannot repair with confidence: %s', (text) => {
    expect(repairJson(text)).toBeUndefined();
  });
});

const response = (content: CanonicalResponse['content']): CanonicalResponse => ({
  id: 'r1',
  model: 'm',
  content,
  finishReason: 'stop',
  created: 1,
});

describe('repairResponse', () => {
  const json = { responseFormat: { type: 'json_object' as const } };

  it('repairs JSON text when the request asked for JSON', () => {
    const out = repairResponse(
      response([
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: '```json\n{"a": 1,' },
        { type: 'text', text: '}\n```' },
      ]),
      json,
      ['json'],
    );
    expect(out.actions).toEqual(['json']);
    expect(out.response.content).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: '{"a": 1}' },
    ]);
  });

  it('returns the same object for valid JSON, plain text requests or disabled repair', () => {
    const valid = response([{ type: 'text', text: '{"a": 1}' }]);
    expect(repairResponse(valid, json, ['json']).response).toBe(valid);
    const broken = response([{ type: 'text', text: '{"a": 1,}' }]);
    expect(repairResponse(broken, {}, ['json']).response).toBe(broken);
    expect(repairResponse(broken, json, ['tools']).response).toBe(broken);
    expect(repairResponse(broken, json, []).actions).toEqual([]);
  });

  it('repairs tool-call arguments', () => {
    const out = repairResponse(
      response([
        { type: 'tool_call', id: 'c1', name: 'f', arguments: "{'city': 'Tehran'" },
        { type: 'tool_call', id: 'c2', name: 'g', arguments: '{"ok":true}' },
        { type: 'tool_call', id: 'c3', name: 'h', arguments: '' },
      ]),
      {},
      ['tools'],
    );
    expect(out.actions).toEqual(['tool_arguments']);
    expect(out.response.content).toEqual([
      { type: 'tool_call', id: 'c1', name: 'f', arguments: '{"city": "Tehran"}' },
      { type: 'tool_call', id: 'c2', name: 'g', arguments: '{"ok":true}' },
      { type: 'tool_call', id: 'c3', name: 'h', arguments: '' },
    ]);
  });
});

/**
 * Anthropic's own rules for a conversation with tools: every `tool_use` id is unique and is
 * answered by a `tool_result` at the start of the very next (user) message, and every
 * `tool_result` answers a `tool_use` of the message right before it. The provider answers a
 * violation with a 400.
 */
function anthropicToolErrors(body: Record<string, unknown>): string[] {
  const messages = body.messages as { role: string; content: Record<string, unknown>[] }[];
  const errors: string[] = [];
  const seen = new Set<string>();
  messages.forEach((message, i) => {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const uses = blocks.filter((b) => b.type === 'tool_use').map((b) => String(b.id));
    for (const id of uses) {
      if (seen.has(id)) errors.push(`duplicate tool_use id ${id}`);
      seen.add(id);
    }
    const previous = messages[i - 1];
    const previousUses = new Set(
      (Array.isArray(previous?.content) ? previous.content : [])
        .filter((b) => b.type === 'tool_use')
        .map((b) => String(b.id)),
    );
    const results = blocks.filter((b) => b.type === 'tool_result');
    for (const result of results)
      if (!previousUses.has(String(result.tool_use_id)))
        errors.push(`tool_result ${String(result.tool_use_id)} without tool_use before it`);
    if (message.role === 'assistant' && uses.length && i < messages.length - 1) {
      const next = messages[i + 1];
      const answered = new Set(
        (Array.isArray(next?.content) ? next.content : [])
          .filter((b) => b.type === 'tool_result')
          .map((b) => String(b.tool_use_id)),
      );
      for (const id of uses) if (!answered.has(id)) errors.push(`tool_use ${id} without result`);
    }
  });
  return errors;
}

/** OpenAI's rule: an assistant message with tool_calls is followed by a tool message per call. */
function openAIToolErrors(body: Record<string, unknown>): string[] {
  const messages = body.messages as Record<string, unknown>[];
  const errors: string[] = [];
  messages.forEach((message, i) => {
    if (message.role === 'tool') {
      let j = i - 1;
      while (j >= 0 && messages[j]?.role === 'tool') j--;
      const calls = (messages[j]?.tool_calls as { id: string }[] | undefined) ?? [];
      if (!calls.some((c) => c.id === message.tool_call_id))
        errors.push(`tool message ${String(message.tool_call_id)} without a preceding tool call`);
    }
    const calls = (message.tool_calls as { id: string }[] | undefined) ?? [];
    if (calls.length && i < messages.length - 1) {
      const answered = new Set<string>();
      for (let j = i + 1; messages[j]?.role === 'tool'; j++)
        answered.add(String(messages[j]?.tool_call_id));
      for (const c of calls) if (!answered.has(c.id)) errors.push(`tool call ${c.id} unanswered`);
    }
  });
  return errors;
}

/** A Claude Code / OpenAI-style history with every common defect at once. */
const brokenOpenAIHistory = OpenAIChatCompletionRequest.parse({
  model: 'gpt-4.1',
  messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Fix the bug.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: { name: 'read', arguments: '{"path":"a.ts"}' },
        },
        { id: 'call_grep', type: 'function', function: { name: 'grep', arguments: "{'q': 'bug'" } },
      ],
    },
    // Only one of the two calls was answered; the other was lost by the client.
    { role: 'tool', tool_call_id: 'call_read', content: 'export const a = 1;' },
    { role: 'user', content: 'Also check b.ts' },
    // A result whose call was trimmed from the history by the client's context management.
    { role: 'tool', tool_call_id: 'call_trimmed', content: 'old output' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_b',
          type: 'function',
          function: { name: 'read', arguments: '{"path":"b.ts"}' },
        },
        // The same call replayed twice.
        {
          id: 'call_b',
          type: 'function',
          function: { name: 'read', arguments: '{"path":"b.ts"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_b', content: 'export const b = 2;' },
    { role: 'tool', tool_call_id: 'call_b', content: 'export const b = 2;' },
    { role: 'user', content: 'Go on.' },
  ],
});

describe('repairToolHistory', () => {
  it('golden: the broken history becomes valid for Anthropic, OpenAI and Gemini', () => {
    const canonical = openAIRequestToCanonical(brokenOpenAIHistory);
    // Without repair, Anthropic would answer 400.
    expect(
      anthropicToolErrors(
        canonicalToAnthropicRequest(canonical, { upstreamModel: 'claude-sonnet-4-5' }),
      ),
    ).not.toEqual([]);
    expect(
      openAIToolErrors(canonicalToOpenAIRequest(canonical, { upstreamModel: 'gpt-4.1' })),
    ).not.toEqual([]);

    const { request, actions } = repairToolHistory(canonical);
    expect(new Set(actions)).toEqual(
      new Set([
        'tool_arguments',
        'tool_missing_result',
        'tool_orphan_result',
        'tool_duplicate_call',
        'tool_duplicate_result',
      ]),
    );
    const anthropic = canonicalToAnthropicRequest(request, { upstreamModel: 'claude-sonnet-4-5' });
    expect(anthropicToolErrors(anthropic)).toEqual([]);
    expect(AnthropicMessagesRequest.safeParse(anthropic).success).toBe(true);
    expect(anthropic.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Fix the bug.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_read', name: 'read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'call_grep', name: 'grep', input: { q: 'bug' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_read',
            content: [{ type: 'text', text: 'export const a = 1;' }],
          },
          {
            type: 'tool_result',
            tool_use_id: 'call_grep',
            content: [
              { type: 'text', text: expect.stringContaining('No result was recorded') as string },
            ],
            is_error: true,
          },
          { type: 'text', text: 'Also check b.ts' },
          {
            type: 'text',
            text: 'Result of tool call call_trimmed:\nold output',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b.ts' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_b',
            content: [{ type: 'text', text: 'export const b = 2;' }],
          },
          { type: 'text', text: 'Go on.' },
        ],
      },
    ]);

    const openai = canonicalToOpenAIRequest(request, { upstreamModel: 'gpt-4.1' });
    expect(openAIToolErrors(openai)).toEqual([]);

    const gemini = canonicalToGeminiRequest(request, {});
    const contents = gemini.contents as { role: string; parts: Record<string, unknown>[] }[];
    const calls = contents.flatMap((c) => c.parts.filter((p) => p.functionCall)).length;
    const responses = contents.flatMap((c) => c.parts.filter((p) => p.functionResponse)).length;
    expect(calls).toBe(responses);
  });

  it('moves a result that arrived late to right after its call', () => {
    const canonical = anthropicRequestToCanonical(
      AnthropicMessagesRequest.parse({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'start' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ls', input: {} }] },
          { role: 'user', content: 'hurry' },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.ts' }],
          },
        ],
      }),
    );
    const { request, actions } = repairToolHistory(canonical);
    expect(actions).toEqual(['tool_moved_result']);
    const body = canonicalToAnthropicRequest(request, { upstreamModel: 'claude-sonnet-4-5' });
    expect(anthropicToolErrors(body)).toEqual([]);
    expect((body.messages as unknown[]).at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.ts' }] },
        { type: 'text', text: 'hurry' },
      ],
    });
  });

  it('leaves a valid history (and a trailing unanswered call) untouched', () => {
    const valid: CanonicalRequest = {
      inboundApi: 'openai.chat',
      model: 'm',
      system: [],
      stream: false,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', id: 'a', name: 'f', arguments: '{}' },
            { type: 'tool_call', id: 'b', name: 'f', arguments: '{"x":1}' },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', toolCallId: 'b', content: [{ type: 'text', text: '2' }] },
            { type: 'tool_result', toolCallId: 'a', content: [{ type: 'text', text: '1' }] },
          ],
        },
        { role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'f', arguments: '' }] },
      ],
    };
    const out = repairToolHistory(valid);
    expect(out.actions).toEqual([]);
    expect(out.request).toBe(valid);
  });
});

describe('parseRepairHeader', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['json', ['json']],
    ['tools, json', ['json', 'tools']],
    ['all', ['json', 'tools']],
    ['off', []],
    ['none', []],
    ['nonsense', []],
  ])('%s', (value, expected) => {
    expect(parseRepairHeader(value)).toEqual(expected);
  });
});
