/**
 * OpenAI Responses API (card 11.2): inbound requests, non-stream responses and the SSE event
 * sequence that the official SDK expects (created, deltas, completed).
 */
import {
  type CanonicalResponse,
  type CanonicalStreamEvent,
  ResponsesRequest,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  ResponsesStreamEncoder,
  canonicalToResponsesResponse,
  responsesFinishToCanonical,
  responsesRequestToCanonical,
  responsesUsage,
} from './index.js';

const usage = {
  inputTokens: 12,
  outputTokens: 5,
  cacheReadTokens: 3,
  cacheWriteTokens: 0,
  reasoningTokens: 2,
};

const canonical = (over: Partial<CanonicalResponse> = {}): CanonicalResponse => ({
  id: 'cmpl_1',
  model: 'gpt',
  content: [{ type: 'text', text: 'hello' }],
  finishReason: 'stop',
  created: 1_700_000_000,
  usage,
  ...over,
});

describe('Responses request → canonical', () => {
  it('maps a string input and instructions', () => {
    const request: ResponsesRequest = {
      model: 'gpt',
      input: 'hi',
      instructions: 'be brief',
      max_output_tokens: 64,
      temperature: 0.1,
      top_p: 0.9,
      stream: true,
      user: 'u1',
      metadata: { trace: 'abc' },
      reasoning: { effort: 'high' },
    };
    const out = responsesRequestToCanonical(request);
    expect(out).toMatchObject({
      inboundApi: 'openai.responses',
      model: 'gpt',
      stream: true,
      maxOutputTokens: 64,
      temperature: 0.1,
      topP: 0.9,
      user: 'u1',
      metadata: { trace: 'abc' },
      reasoning: { effort: 'high' },
    });
    expect(out.system).toEqual([{ type: 'text', text: 'be brief' }]);
    expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('maps message items, developer messages, images and tool replays', () => {
    const out = responsesRequestToCanonical({
      model: 'gpt',
      input: [
        { type: 'message', role: 'developer', content: 'dev rules' },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'what is this?' },
            { type: 'input_image', image_url: 'https://example.test/cat.png' },
          ],
        },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'checked the docs' }],
        },
      ],
    });
    expect(out.system).toEqual([{ type: 'text', text: 'dev rules' }]);
    expect(out.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { kind: 'url', url: 'https://example.test/cat.png' } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', content: [{ type: 'text', text: 'sunny' }] },
        ],
      },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'checked the docs' }] },
    ]);
  });

  it('maps tools, tool choice and structured output', () => {
    const out = responsesRequestToCanonical({
      model: 'gpt',
      input: 'x',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'forecast',
          parameters: { type: 'object', properties: {} },
          strict: true,
        },
      ],
      tool_choice: { type: 'function', name: 'get_weather' },
      parallel_tool_calls: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'weather',
          schema: { type: 'object' },
          strict: true,
        },
      },
    });
    expect(out.tools).toEqual([
      {
        name: 'get_weather',
        description: 'forecast',
        parameters: { type: 'object', properties: {} },
        strict: true,
      },
    ]);
    expect(out.toolChoice).toEqual({ name: 'get_weather' });
    expect(out.parallelToolCalls).toBe(false);
    expect(out.responseFormat).toEqual({
      type: 'json_schema',
      name: 'weather',
      schema: { type: 'object' },
      strict: true,
    });
    expect(
      responsesRequestToCanonical({
        model: 'gpt',
        input: 'x',
        text: { format: { type: 'json_object' } },
        tool_choice: 'required',
      }),
    ).toMatchObject({ responseFormat: { type: 'json_object' }, toolChoice: 'required' });
    expect(
      responsesRequestToCanonical({
        model: 'gpt',
        input: 'x',
        text: { format: { type: 'text' } },
      }).responseFormat,
    ).toEqual({ type: 'text' });
  });

  it('reports dropped items instead of guessing', () => {
    const drops: { field: string; reason: string }[] = [];
    const out = responsesRequestToCanonical(
      {
        model: 'gpt',
        input: [
          { type: 'reasoning' },
          { type: 'unknown_item' },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_video', video_url: 'v' }],
          },
        ],
      },
      { onDrop: (field, reason) => drops.push({ field, reason }) },
    );
    expect(out.messages).toEqual([{ role: 'user', content: [] }]);
    expect(drops.map((d) => d.field)).toEqual(['input[]', 'input[]', 'input[].content[]']);
  });

  it('handles array system content and tool-role items', () => {
    const out = responsesRequestToCanonical({
      model: 'gpt',
      input: [
        {
          type: 'message',
          role: 'system',
          content: [
            { type: 'input_text', text: 'system one' },
            { type: 'input_text', text: 'system two' },
          ],
        },
        { role: 'tool', call_id: 'call_1', output: 'ok' },
        { role: 'tool' },
        { type: 'message', content: 'implicit user role' },
      ],
    });
    expect(out.system).toEqual([
      { type: 'text', text: 'system one' },
      { type: 'text', text: 'system two' },
    ]);
    expect(out.messages).toEqual([
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'implicit user role' }] },
    ]);
  });

  it('falls back to ids and arguments when replayed function calls are incomplete', () => {
    const out = responsesRequestToCanonical({
      model: 'gpt',
      input: [
        { type: 'function_call', name: 'no_id' },
        { type: 'function_call', id: 'fc_2', name: 'with_id' },
        { type: 'function_call_output', call_id: 'fc_2' },
        { role: 'user' },
      ],
    });
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'no_id', name: 'no_id', arguments: '{}' },
          { type: 'tool_call', id: 'fc_2', name: 'with_id', arguments: '{}' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolCallId: 'fc_2', content: [{ type: 'text', text: '' }] },
        ],
      },
      { role: 'user', content: [] },
    ]);
  });

  it('applies tool defaults when optional fields are absent', () => {
    const out = responsesRequestToCanonical({
      model: 'gpt',
      input: 'x',
      tools: [{ type: 'function', name: 'no_args', description: null, strict: null }],
    });
    expect(out.tools).toEqual([{ name: 'no_args', parameters: { type: 'object' } }]);
  });

  it('accepts the nested Chat Completions tool form and drops non-function tools', () => {
    const drops: string[] = [];
    const out = responsesRequestToCanonical(
      {
        model: 'gpt',
        input: 'x',
        tools: [
          { type: 'function', function: { name: 'nested', parameters: { type: 'object' } } },
          { type: 'web_search' },
          { type: 'local_shell' },
          { type: 'custom', name: 'apply_patch' },
        ],
        tool_choice: { type: 'allowed_tools' },
      },
      { onDrop: (field, reason) => drops.push(`${field}: ${reason}`) },
    );
    // A custom tool is carried as a function since card 31.2.
    expect(out.tools).toEqual([
      { name: 'nested', parameters: { type: 'object' } },
      expect.objectContaining({ name: 'apply_patch', kind: 'custom' }),
    ]);
    expect(out.toolChoice).toBeUndefined();
    expect(drops).toEqual([
      "tools[]: unsupported tool type 'web_search'",
      "tools[]: unsupported tool type 'local_shell'",
      "tool_choice: unsupported tool choice 'allowed_tools'",
    ]);
  });

  it('maps every documented reasoning effort', () => {
    const effort = (value: NonNullable<ResponsesRequest['reasoning']>['effort']) =>
      responsesRequestToCanonical({ model: 'gpt', input: 'x', reasoning: { effort: value } })
        .reasoning;
    expect(effort('minimal')).toEqual({ effort: 'minimal' });
    expect(effort('low')).toEqual({ effort: 'low' });
    expect(effort('medium')).toEqual({ effort: 'medium' });
    expect(effort('xhigh')).toEqual({ effort: 'high' });
    expect(effort('max')).toEqual({ effort: 'high' });
    expect(effort('none')).toBeUndefined();
    expect(effort(null)).toBeUndefined();
  });

  it('translates a second agent turn the way a coding agent replays it', () => {
    // Shape of a real second-turn request: flat tools, built-in tools, replayed assistant
    // output, parallel function calls with string and array outputs, and unknown fields.
    const body: unknown = {
      model: 'gpt',
      instructions: 'You are a coding agent.',
      store: false,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'abc',
      parallel_tool_calls: true,
      reasoning: { effort: 'xhigh', summary: 'auto' },
      text: { verbosity: 'low' },
      tool_choice: 'auto',
      tools: [
        {
          type: 'function',
          name: 'shell',
          description: 'Runs a shell command',
          strict: false,
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
        { type: 'web_search', external_web_access: false },
        { type: 'custom', name: 'apply_patch', format: { type: 'grammar' } },
      ],
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'sandbox rules' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'need ls' }],
          content: null,
          encrypted_content: 'gAAAA',
        },
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'Looking. ', annotations: [], logprobs: [] },
            { type: 'refusal', refusal: '(partly declined)' },
          ],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{"command":"ls"}',
        },
        {
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_2',
          name: 'shell',
          arguments: '{"command":"pwd"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
        {
          type: 'function_call_output',
          call_id: 'call_2',
          output: [
            { type: 'input_text', text: '/work' },
            { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
            { type: 'input_file', file_id: 'f1' },
          ],
        },
        { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search' } },
        { type: 'local_shell_call_output', call_id: 'call_3', output: { stdout: 'x' } },
        { type: 'tool_search_call', arguments: { query: 'x' } },
      ],
    };
    const parsed = ResponsesRequest.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const drops: string[] = [];
    const out = responsesRequestToCanonical(parsed.data, {
      onDrop: (field, reason) => drops.push(`${field}: ${reason}`),
    });
    expect(out.system).toEqual([
      { type: 'text', text: 'You are a coding agent.' },
      { type: 'text', text: 'sandbox rules' },
    ]);
    expect(out.tools).toEqual([
      {
        name: 'shell',
        description: 'Runs a shell command',
        strict: false,
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
      // Codex's apply_patch, carried as a function (card 31.2).
      expect.objectContaining({ name: 'apply_patch', kind: 'custom' }),
    ]);
    expect(out.toolChoice).toBe('auto');
    expect(out.reasoning).toEqual({ effort: 'high' });
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'list files' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need ls' },
          { type: 'text', text: 'Looking. ' },
          { type: 'text', text: '(partly declined)' },
          { type: 'tool_call', id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
          { type: 'tool_call', id: 'call_2', name: 'shell', arguments: '{"command":"pwd"}' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.txt' }] },
          {
            type: 'tool_result',
            toolCallId: 'call_2',
            content: [
              { type: 'text', text: '/work' },
              { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'QUJD' } },
            ],
          },
        ],
      },
    ]);
    expect(drops).toEqual([
      "input[].output[]: unsupported part 'input_file'",
      "input[]: unsupported item 'web_search_call'",
      "input[]: unsupported item 'local_shell_call_output'",
      "input[]: unsupported item 'tool_search_call'",
      "tools[]: unsupported tool type 'web_search'",
    ]);
  });

  it('rejects only requests that are structurally unusable', () => {
    expect(ResponsesRequest.safeParse({ input: 'x' }).success).toBe(false);
    expect(ResponsesRequest.safeParse({ model: 'gpt', input: 42 }).success).toBe(false);
    expect(
      ResponsesRequest.safeParse({ model: 'gpt', input: 'x', reasoning: { effort: 'huge' } })
        .success,
    ).toBe(false);
    expect(
      ResponsesRequest.safeParse({
        model: 'gpt',
        input: [{ type: 'function_call_output', call_id: 'c', output: { ok: true } }],
        instructions: null,
        tools: null,
        metadata: null,
      }).success,
    ).toBe(true);
  });

  it('stringifies structured outputs and arguments, and skips unknown roles', () => {
    const drops: string[] = [];
    const out = responsesRequestToCanonical(
      {
        model: 'gpt',
        input: [
          { type: 'function_call', call_id: 'c1', name: 'f', arguments: { a: 1 } },
          { type: 'function_call_output', call_id: 'c1', output: { ok: true } },
          { type: 'function_call_output', call_id: 'c1', output: ['plain', 7, { type: 'x' }] },
          { role: 'critic', content: 'ignored' },
          { content: 'no role at all' },
        ],
      },
      { onDrop: (field) => drops.push(field) },
    );
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'f', arguments: '{"a":1}' }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'c1',
            content: [{ type: 'text', text: '{"ok":true}' }],
          },
          { type: 'tool_result', toolCallId: 'c1', content: [{ type: 'text', text: 'plain' }] },
        ],
      },
    ]);
    expect(drops).toEqual(['input[].output[]', 'input[]', 'input[]']);
  });
});

describe('canonical → Responses response', () => {
  it('encodes text, usage and status', () => {
    const body = canonicalToResponsesResponse(canonical(), { model: 'gpt-4.1' });
    expect(body).toMatchObject({
      id: 'resp_cmpl_1',
      object: 'response',
      created_at: 1_700_000_000,
      status: 'completed',
      model: 'gpt-4.1',
      output_text: 'hello',
      error: null,
      incomplete_details: null,
    });
    expect(body.output[0]).toMatchObject({
      type: 'message',
      id: 'msg_cmpl_1_0',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello', annotations: [] }],
    });
    expect(body.usage).toEqual({
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 2 },
    });
  });

  it('encodes reasoning and function calls, and maps finish reasons', () => {
    const body = canonicalToResponsesResponse(
      canonical({
        content: [
          { type: 'reasoning', text: 'plan' },
          { type: 'text', text: 'calling' },
          { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Tehran"}' },
        ],
        finishReason: 'tool_calls',
      }),
      { model: 'gpt' },
    );
    expect(body.output.map((item) => item.type)).toEqual(['reasoning', 'message', 'function_call']);
    expect(body.output[0]).toMatchObject({
      type: 'reasoning',
      id: 'rs_cmpl_1_0',
      summary: [{ type: 'summary_text', text: 'plan' }],
    });
    expect(body.output[2]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Tehran"}',
    });
    expect(
      canonicalToResponsesResponse(canonical({ finishReason: 'length' }), { model: 'gpt' }),
    ).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    expect(
      canonicalToResponsesResponse(canonical({ finishReason: 'content_filter' }), { model: 'gpt' })
        .incomplete_details,
    ).toEqual({ reason: 'content_filter' });
    expect(
      canonicalToResponsesResponse(canonical({ finishReason: 'error' }), { model: 'gpt' }),
    ).toMatchObject({ status: 'failed', error: { code: 'server_error' } });
    expect(responsesFinishToCanonical('max_output_tokens')).toBe('length');
    expect(responsesFinishToCanonical('completed')).toBe('stop');
    expect(responsesFinishToCanonical(undefined)).toBe('stop');
    expect(responsesUsage(usage).total_tokens).toBe(17);
  });
});

describe('canonical → Responses stream', () => {
  const chunks = (sse: string) =>
    sse
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => {
        const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? '';
        const data = /^data: (.*)$/m.exec(chunk)?.[1] ?? '{}';
        return { event, data: JSON.parse(data) as Record<string, unknown> };
      });

  const run = (model: string, events: CanonicalStreamEvent[]) => {
    const encoder = new ResponsesStreamEncoder({ model });
    const parsed = chunks(events.map((event) => encoder.push(event)).join('') + encoder.end());
    // Every event repeats its SSE name as `type` and numbers itself in order.
    expect(parsed.map((c) => c.data.type)).toEqual(parsed.map((c) => c.event));
    expect(parsed.map((c) => c.data.sequence_number)).toEqual(parsed.map((_, index) => index));
    return { encoder, parsed };
  };

  it('emits the full event sequence for a text answer', () => {
    const { encoder, parsed } = run('gpt-4.1', [
      { type: 'start', id: 'cmpl_1', model: 'gpt-4.1', created: 1_700_000_000 },
      { type: 'text_delta', index: 0, text: 'Hel' },
      { type: 'text_delta', index: 0, text: 'lo' },
      { type: 'content_end', index: 0 },
      { type: 'usage', usage },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const message = {
      type: 'message',
      id: 'msg_cmpl_1_0',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
    };
    const inProgress = {
      id: 'resp_cmpl_1',
      object: 'response',
      created_at: 1_700_000_000,
      status: 'in_progress',
      model: 'gpt-4.1',
      output: [],
      error: null,
      incomplete_details: null,
    };
    const at = { item_id: 'msg_cmpl_1_0', output_index: 0, content_index: 0 };
    expect(parsed.map((c) => c.data)).toEqual([
      { type: 'response.created', sequence_number: 0, response: inProgress },
      { type: 'response.in_progress', sequence_number: 1, response: inProgress },
      {
        type: 'response.output_item.added',
        sequence_number: 2,
        output_index: 0,
        item: { ...message, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added',
        sequence_number: 3,
        ...at,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      { type: 'response.output_text.delta', sequence_number: 4, ...at, delta: 'Hel', logprobs: [] },
      { type: 'response.output_text.delta', sequence_number: 5, ...at, delta: 'lo', logprobs: [] },
      { type: 'response.output_text.done', sequence_number: 6, ...at, text: 'Hello', logprobs: [] },
      {
        type: 'response.content_part.done',
        sequence_number: 7,
        ...at,
        part: { type: 'output_text', text: 'Hello', annotations: [] },
      },
      { type: 'response.output_item.done', sequence_number: 8, output_index: 0, item: message },
      {
        type: 'response.completed',
        sequence_number: 9,
        response: {
          ...inProgress,
          status: 'completed',
          output: [message],
          output_text: 'Hello',
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            total_tokens: 17,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      },
    ]);
    expect(encoder.usage).toEqual(usage);
  });

  it('emits the full event sequence for reasoning followed by a tool call', () => {
    const { parsed } = run('gpt', [
      { type: 'start', id: 'cmpl_2', model: 'gpt', created: 1 },
      { type: 'reasoning_delta', index: 0, text: 'thi' },
      { type: 'reasoning_delta', index: 0, text: 'nk' },
      { type: 'reasoning_delta', index: 0, signature: 'sig' },
      { type: 'tool_call_start', index: 1, id: 'call_1', name: 'get_weather' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '{"city":' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '"Tehran"}' },
      { type: 'content_end', index: 0 },
      { type: 'content_end', index: 1 },
      { type: 'finish', finishReason: 'tool_calls' },
    ]);
    const reasoning = {
      type: 'reasoning',
      id: 'rs_cmpl_2_0',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'think' }],
    };
    const call = {
      type: 'function_call',
      id: 'fc_call_1',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Tehran"}',
      status: 'completed',
    };
    const rs = { item_id: 'rs_cmpl_2_0', output_index: 0, summary_index: 0 };
    const fc = { item_id: 'fc_call_1', output_index: 1 };
    expect(parsed.slice(2, -1).map((c) => c.data)).toEqual([
      {
        type: 'response.output_item.added',
        sequence_number: 2,
        output_index: 0,
        item: { ...reasoning, status: 'in_progress', summary: [] },
      },
      {
        type: 'response.reasoning_summary_part.added',
        sequence_number: 3,
        ...rs,
        part: { type: 'summary_text', text: '' },
      },
      { type: 'response.reasoning_summary_text.delta', sequence_number: 4, ...rs, delta: 'thi' },
      { type: 'response.reasoning_summary_text.delta', sequence_number: 5, ...rs, delta: 'nk' },
      { type: 'response.reasoning_summary_text.done', sequence_number: 6, ...rs, text: 'think' },
      {
        type: 'response.reasoning_summary_part.done',
        sequence_number: 7,
        ...rs,
        part: { type: 'summary_text', text: 'think' },
      },
      { type: 'response.output_item.done', sequence_number: 8, output_index: 0, item: reasoning },
      {
        type: 'response.output_item.added',
        sequence_number: 9,
        output_index: 1,
        item: { ...call, arguments: '', status: 'in_progress' },
      },
      {
        type: 'response.function_call_arguments.delta',
        sequence_number: 10,
        ...fc,
        delta: '{"city":',
      },
      {
        type: 'response.function_call_arguments.delta',
        sequence_number: 11,
        ...fc,
        delta: '"Tehran"}',
      },
      {
        type: 'response.function_call_arguments.done',
        sequence_number: 12,
        ...fc,
        name: 'get_weather',
        arguments: '{"city":"Tehran"}',
      },
      { type: 'response.output_item.done', sequence_number: 13, output_index: 1, item: call },
    ]);
    expect(parsed.at(-1)).toMatchObject({
      event: 'response.completed',
      data: { response: { status: 'completed', output: [reasoning, call], output_text: '' } },
    });
  });

  it('keeps output_index equal to the position in the final output', () => {
    const { parsed } = run('gpt', [
      { type: 'start', id: 'c', model: 'gpt', created: 1 },
      { type: 'text_delta', index: 0, text: 'Let me check.' },
      { type: 'tool_call_start', index: 1, id: 'call_a', name: 'read_file' },
      { type: 'tool_call_start', index: 2, id: 'call_b', name: 'read_file' },
      // Interleaved argument deltas of two parallel calls.
      { type: 'tool_call_delta', index: 2, argumentsDelta: '{"path":"b"}' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '{"path":"a"}' },
      { type: 'finish', finishReason: 'tool_calls' },
      // Text released late by the gateway opens a new message after the calls.
      { type: 'text_delta', index: 0, text: ' Done.' },
    ]);
    const done = parsed.filter((c) => c.event === 'response.output_item.done');
    const completed = parsed.at(-1)?.data as { response: { output: Record<string, unknown>[] } };
    expect(done.map((c) => c.data.output_index)).toEqual([0, 1, 2, 3]);
    expect(completed.response.output).toEqual(done.map((c) => c.data.item));
    expect(completed.response.output.map((item) => item.arguments ?? item.type)).toEqual([
      'message',
      '{"path":"a"}',
      '{"path":"b"}',
      'message',
    ]);
    expect(completed.response).toMatchObject({ output_text: 'Let me check. Done.' });
    const added = parsed.filter((c) => c.event === 'response.output_item.added');
    expect(added.map((c) => c.data.output_index)).toEqual([0, 1, 2, 3]);
  });

  it('appends held-back text to the message that is still open', () => {
    const { parsed } = run('gpt', [
      { type: 'start', id: 'c', model: 'gpt', created: 1 },
      { type: 'text_delta', index: 0, text: 'Hel' },
      { type: 'content_end', index: 0 },
      { type: 'finish', finishReason: 'stop' },
      { type: 'text_delta', index: 0, text: 'lo' },
      { type: 'text_delta', index: 0, text: '' },
    ]);
    expect(parsed.filter((c) => c.event === 'response.output_item.added')).toHaveLength(1);
    expect(parsed.find((c) => c.event === 'response.output_text.done')?.data.text).toBe('Hello');
  });

  it('ends with response.incomplete or response.failed when the answer did not complete', () => {
    const last = (finishReason: CanonicalResponse['finishReason']) =>
      run('gpt', [
        { type: 'text_delta', index: 0, text: 'x' },
        { type: 'finish', finishReason },
      ]).parsed.at(-1);
    expect(last('length')).toMatchObject({
      event: 'response.incomplete',
      data: {
        response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      },
    });
    expect(last('content_filter')?.data).toMatchObject({
      response: { incomplete_details: { reason: 'content_filter' } },
    });
    expect(last('error')).toMatchObject({
      event: 'response.failed',
      data: { response: { status: 'failed', error: { code: 'server_error' } } },
    });
  });

  it('opens the stream by itself when no start event arrives', () => {
    const { parsed } = run('gpt', []);
    expect(parsed.map((c) => c.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.completed',
    ]);
    expect(parsed.at(-1)?.data).toMatchObject({ response: { output: [], output_text: '' } });
  });

  it('emits response.failed on upstream errors', () => {
    const encoder = new ResponsesStreamEncoder({ model: 'gpt' });
    const sse =
      encoder.push({ type: 'start', id: 'c', model: 'gpt', created: 1 }) +
      encoder.push({ type: 'start', id: 'again', model: 'gpt', created: 2 }) +
      encoder.push({ type: 'text_delta', index: 0, text: 'par' }) +
      encoder.push({ type: 'never' } as never) +
      encoder.push({ type: 'error', code: 'upstream_error', message: 'boom' }) +
      // Nothing may follow the terminal event.
      encoder.push({ type: 'text_delta', index: 0, text: 'late' }) +
      encoder.end();
    const parsed = chunks(sse);
    expect(parsed.map((c) => c.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.failed',
    ]);
    expect(parsed.at(-1)?.data).toMatchObject({
      sequence_number: 5,
      response: {
        id: 'resp_c',
        status: 'failed',
        error: { code: 'upstream_error', message: 'boom' },
      },
    });
  });

  it('ignores empty deltas and a tool delta without an open call', () => {
    const encoder = new ResponsesStreamEncoder({ model: 'gpt' });
    expect(encoder.push({ type: 'reasoning_delta', index: 0, text: '' })).toBe('');
    expect(encoder.push({ type: 'tool_call_delta', index: 0, argumentsDelta: 'x' })).toBe('');
  });

  it('defaults empty tool arguments to {} when no delta arrives', () => {
    const { parsed } = run('gpt', [
      { type: 'start', id: 'cmpl_3', model: 'gpt', created: 1 },
      { type: 'tool_call_start', index: 0, id: 'call_9', name: 'ping' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '' },
      { type: 'finish', finishReason: 'tool_calls' },
    ]);
    expect(
      parsed.find((c) => c.event === 'response.function_call_arguments.done')?.data.arguments,
    ).toBe('{}');
    const completed = parsed.at(-1)?.data as {
      response: { output: Record<string, unknown>[] };
    };
    expect(completed.response.output.at(-1)).toMatchObject({
      type: 'function_call',
      arguments: '{}',
    });
  });

  it('omits usage and text content when the response has none', () => {
    const body = canonicalToResponsesResponse(
      { id: 'c', model: 'gpt', content: [], finishReason: 'stop', created: 1 },
      { model: 'gpt' },
    );
    expect(body.usage).toBeUndefined();
    expect(body.output).toEqual([]);
    expect(body.output_text).toBe('');
    // Adjacent text parts form one message; a tool call in between starts a new one.
    const split = canonicalToResponsesResponse(
      canonical({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: '' },
          { type: 'text', text: 'b' },
          { type: 'tool_call', id: 'call_1', name: 'f', arguments: '' },
          { type: 'text', text: 'c' },
        ],
      }),
      { model: 'gpt' },
    );
    expect(split.output).toEqual([
      {
        type: 'message',
        id: 'msg_cmpl_1_0',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ab', annotations: [] }],
      },
      {
        type: 'function_call',
        id: 'fc_call_1',
        call_id: 'call_1',
        name: 'f',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'message',
        id: 'msg_cmpl_1_2',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'c', annotations: [] }],
      },
    ]);
    expect(split.output_text).toBe('abc');
  });
});
