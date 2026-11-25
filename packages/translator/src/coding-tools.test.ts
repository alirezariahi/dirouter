/**
 * Card 31.2: Codex's `apply_patch` (a `custom` tool with a Lark grammar) and OpenAI's built-in
 * `apply_patch` tool reach models that do not know them as function tools, and their calls come
 * back as the items Codex expects.
 */
import {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  ResponsesRequest,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  anthropicResponseToCanonical,
  canonicalToAnthropicRequest,
  canonicalToGeminiRequest,
  canonicalToResponsesResponse,
  geminiResponseToCanonical,
  responsesRequestToCanonical,
  ResponsesStreamEncoder,
  SseParser,
} from './index.js';

const GRAMMAR = 'start: begin_patch hunk+ end_patch\nbegin_patch: "*** Begin Patch" LF';
const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/app.ts',
  '@@',
  "-const greeting = 'hi';",
  "+const greeting = 'hello';",
  '*** End Patch',
].join('\n');

/** What Codex sends: its free-form apply_patch tool, a shell function, and a replayed edit. */
const codexRequest = (input: unknown[]) =>
  ResponsesRequest.parse({
    model: 'claude-sonnet-4-5',
    instructions: 'You are Codex.',
    input,
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Use the `apply_patch` tool to edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: GRAMMAR },
      },
      {
        type: 'function',
        name: 'shell',
        parameters: { type: 'object', properties: { command: { type: 'array' } } },
      },
    ],
    tool_choice: 'auto',
    stream: false,
  });

describe('golden: Codex apply_patch (custom tool) to Claude and Gemini', () => {
  const first = codexRequest([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] },
  ]);

  it('the custom tool becomes a function taking {input}, with the grammar in its description', () => {
    const canonical = responsesRequestToCanonical(first);
    const body = canonicalToAnthropicRequest(canonical, { upstreamModel: 'claude-sonnet-4-5' });
    expect(AnthropicMessagesRequest.safeParse(body).success).toBe(true);
    expect(body.tools).toEqual([
      {
        name: 'apply_patch',
        description: `Use the \`apply_patch\` tool to edit files.\n\nThe input must match this lark grammar exactly:\n${GRAMMAR}`,
        input_schema: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description:
                'The complete free-form input of the tool, exactly as the tool expects it.',
            },
          },
          required: ['input'],
          additionalProperties: false,
        },
      },
      {
        name: 'shell',
        input_schema: { type: 'object', properties: { command: { type: 'array' } } },
      },
    ]);
    const gemini = canonicalToGeminiRequest(canonical, {});
    const declarations = (gemini.tools as { functionDeclarations: { name: string }[] }[])[0]
      ?.functionDeclarations;
    expect(declarations?.map((d) => d.name)).toEqual(['apply_patch', 'shell']);
  });

  it("Claude's call comes back as a custom_tool_call with the patch as its input", () => {
    const answer = anthropicResponseToCanonical(
      AnthropicMessagesResponse.parse({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'Editing the file.' },
          { type: 'tool_use', id: 'toolu_1', name: 'apply_patch', input: { input: PATCH } },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const out = canonicalToResponsesResponse(answer, {
      model: 'claude',
      tools: responsesRequestToCanonical(first).tools,
    });
    expect(out.output[1]).toEqual({
      type: 'custom_tool_call',
      id: 'ctc_toolu_1',
      call_id: 'toolu_1',
      name: 'apply_patch',
      input: PATCH,
      status: 'completed',
    });
    // Without the request's tools it stays an ordinary function call.
    expect(canonicalToResponsesResponse(answer, { model: 'claude' }).output[1]).toMatchObject({
      type: 'function_call',
    });
  });

  it('the replayed call and its output go back to Claude as a paired tool_use and tool_result', () => {
    const second = codexRequest([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] },
      {
        type: 'custom_tool_call',
        id: 'ctc_toolu_1',
        call_id: 'toolu_1',
        name: 'apply_patch',
        input: PATCH,
        status: 'completed',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'toolu_1',
        output: 'Success. Updated the following files:\nM src/app.ts',
      },
    ]);
    const body = canonicalToAnthropicRequest(responsesRequestToCanonical(second), {
      upstreamModel: 'claude-sonnet-4-5',
    });
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'apply_patch', input: { input: PATCH } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              { type: 'text', text: 'Success. Updated the following files:\nM src/app.ts' },
            ],
          },
        ],
      },
    ]);
  });

  it('tool_choice for a custom tool forces it', () => {
    const canonical = responsesRequestToCanonical(
      ResponsesRequest.parse({ ...first, tool_choice: { type: 'custom', name: 'apply_patch' } }),
    );
    expect(canonical.toolChoice).toEqual({ name: 'apply_patch' });
  });
});

describe("golden: OpenAI's built-in apply_patch tool to Gemini", () => {
  const request = ResponsesRequest.parse({
    model: 'gemini-2.5-pro',
    input: 'Create hello.py',
    tools: [{ type: 'apply_patch' }],
  });

  it('becomes a function taking the file operation', () => {
    const canonical = responsesRequestToCanonical(request);
    expect(canonical.tools?.[0]).toMatchObject({
      name: 'apply_patch',
      kind: 'apply_patch',
      parameters: { required: ['type', 'path'] },
    });
    expect(canonical.tools?.[0]?.description).toContain('V4A');
  });

  it("Gemini's call comes back as an apply_patch_call with its operation", () => {
    const answer = geminiResponseToCanonical(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'apply_patch',
                    args: { type: 'create_file', path: 'hello.py', diff: "+print('hi')\n" },
                  },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
      { model: 'gemini-2.5-pro' },
    );
    const out = canonicalToResponsesResponse(answer, {
      model: 'gemini',
      tools: responsesRequestToCanonical(request).tools,
    });
    const call = out.output[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      type: 'apply_patch_call',
      status: 'completed',
      operation: { type: 'create_file', path: 'hello.py', diff: "+print('hi')\n" },
    });
    expect(call.id).toBe(`apc_${String(call.call_id)}`);
  });

  it('a replayed apply_patch_call_output that failed is an error result', () => {
    const canonical = responsesRequestToCanonical(
      ResponsesRequest.parse({
        ...request,
        input: [
          { type: 'message', role: 'user', content: 'Delete old.py' },
          {
            type: 'apply_patch_call',
            call_id: 'call_9',
            status: 'completed',
            operation: { type: 'delete_file', path: 'old.py' },
          },
          {
            type: 'apply_patch_call_output',
            call_id: 'call_9',
            status: 'failed',
            output: 'no such file',
          },
        ],
      }),
    );
    expect(canonical.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            id: 'call_9',
            name: 'apply_patch',
            arguments: '{"type":"delete_file","path":"old.py"}',
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'call_9',
            content: [{ type: 'text', text: 'no such file' }],
            isError: true,
          },
        ],
      },
    ]);
  });
});

describe('stream: coding-tool calls are sent as their own items', () => {
  const events = (encoder: ResponsesStreamEncoder, args: string[], name: string) => {
    let wire = encoder.push({ type: 'start', id: 'r1', model: 'm', created: 1 });
    wire += encoder.push({ type: 'tool_call_start', index: 0, id: 'call_1', name });
    for (const part of args)
      wire += encoder.push({ type: 'tool_call_delta', index: 0, argumentsDelta: part });
    wire += encoder.push({ type: 'content_end', index: 0 });
    wire += encoder.push({ type: 'finish', finishReason: 'tool_calls' });
    wire += encoder.end();
    const parser = new SseParser();
    return [...parser.feed(wire), ...parser.flush()].map(
      (e) => JSON.parse(e.data) as Record<string, unknown>,
    );
  };

  it('custom: added, the whole input as delta and done, then the finished item', () => {
    const tools = [{ name: 'apply_patch', parameters: {}, kind: 'custom' as const }];
    const args = JSON.stringify({ input: PATCH });
    const list = events(
      new ResponsesStreamEncoder({ model: 'm', tools }),
      [args.slice(0, 20), args.slice(20)],
      'apply_patch',
    );
    const types = list.map((e) => e.type);
    expect(types).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.custom_tool_call_input.delta',
      'response.custom_tool_call_input.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(list[3]).toMatchObject({ item_id: 'ctc_call_1', output_index: 0, delta: PATCH });
    expect(list[5]?.item).toEqual({
      type: 'custom_tool_call',
      id: 'ctc_call_1',
      call_id: 'call_1',
      name: 'apply_patch',
      input: PATCH,
      status: 'completed',
    });
    expect((list[6]?.response as { output: unknown[] }).output).toEqual([list[5]?.item]);
  });

  it('apply_patch: the call is announced once its operation is complete', () => {
    const tools = [{ name: 'apply_patch', parameters: {}, kind: 'apply_patch' as const }];
    const list = events(
      new ResponsesStreamEncoder({ model: 'm', tools }),
      ['{"type":"update_file","path":"a.py",', '"diff":"@@\\n-a\\n+b\\n"}'],
      'apply_patch',
    );
    expect(list.map((e) => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(list[3]?.item).toEqual({
      type: 'apply_patch_call',
      id: 'apc_call_1',
      call_id: 'call_1',
      status: 'completed',
      operation: { type: 'update_file', path: 'a.py', diff: '@@\n-a\n+b\n' },
    });
  });
});
