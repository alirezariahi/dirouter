/**
 * Card 27.1: `response_format` to Claude (native `output_config.format` or the forced-tool
 * fallback), and the fallback tool turned back into JSON text, stream and non-stream.
 */
import {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionRequest,
  validateJsonSchema,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  AnthropicStreamDecoder,
  OpenAIStreamEncoder,
  STRUCTURED_OUTPUT_TOOL,
  SseParser,
  StructuredOutputStream,
  anthropicRequestToCanonical,
  anthropicResponseToCanonical,
  bedrockStructuredOutputMode,
  canonicalToAnthropicRequest,
  canonicalToOpenAIRequest,
  canonicalToOpenAIResponse,
  claudeStructuredOutputMode,
  openAIRequestToCanonical,
  unwrapStructuredOutput,
} from './index.js';

const SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' }, temp: { type: 'number' } },
  required: ['city', 'temp'],
  additionalProperties: false,
};

const openAIJsonRequest = (extra: Record<string, unknown> = {}) =>
  openAIRequestToCanonical(
    OpenAIChatCompletionRequest.parse({
      model: 'claude',
      messages: [{ role: 'user', content: 'Weather in Tehran as JSON' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'weather', schema: SCHEMA, strict: true },
      },
      ...extra,
    }),
  );

describe('model support table', () => {
  it.each([
    ['claude-sonnet-5-5', 'native'],
    ['claude-opus-5-5', 'native'],
    ['claude-opus-4-8', 'native'],
    ['claude-haiku-4-5-20251001', 'native'],
    ['claude-fable-5-2', 'native'],
    ['us.anthropic.claude-sonnet-5-5-v1:0', 'native'],
    ['claude-sonnet-4-5', 'tool'],
    ['claude-3-5-haiku-20241022', 'tool'],
    ['claude-opus-4-10', 'tool'],
  ])('%s → %s on Anthropic', (model, mode) => {
    expect(claudeStructuredOutputMode(model)).toBe(mode);
  });

  it('the provider option overrides the table', () => {
    expect(claudeStructuredOutputMode('claude-sonnet-4-5', 'native')).toBe('native');
    expect(claudeStructuredOutputMode('claude-sonnet-5-5', 'tool')).toBe('tool');
    expect(claudeStructuredOutputMode('claude-sonnet-5-5', 'bogus')).toBe('native');
  });

  it.each([
    ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'tool'],
    ['anthropic.claude-opus-4-8-v1:0', 'tool'],
    ['us.anthropic.claude-opus-5-5-v1:0', 'native'],
    ['global.anthropic.claude-fable-5-2-v1:0', 'native'],
    ['amazon.nova-pro-v1:0', 'tool'],
  ])('%s → %s on Bedrock', (model, mode) => {
    expect(bedrockStructuredOutputMode(model)).toBe(mode);
  });
});

describe('golden: OpenAI json_schema → Anthropic request', () => {
  it('native models get output_config.format and no extra tool', () => {
    const body = canonicalToAnthropicRequest(openAIJsonRequest(), {
      upstreamModel: 'claude-sonnet-5-5',
    });
    expect(body).toEqual({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Tehran as JSON' }] }],
      max_tokens: 4096,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
    expect(AnthropicMessagesRequest.safeParse(body).success).toBe(true);
  });

  it('older models get one forced tool with the schema as its input', () => {
    const body = canonicalToAnthropicRequest(openAIJsonRequest({ stream: true }), {
      upstreamModel: 'claude-sonnet-4-5',
    });
    expect(body).toEqual({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Tehran as JSON' }] }],
      tools: [
        {
          name: STRUCTURED_OUTPUT_TOOL,
          description:
            'Return the final answer (weather) by calling this tool. Its input is the answer.',
          input_schema: SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: STRUCTURED_OUTPUT_TOOL, disable_parallel_tool_use: true },
      max_tokens: 4096,
      stream: true,
    });
    expect(AnthropicMessagesRequest.safeParse(body).success).toBe(true);
  });

  it('with client tools the fallback joins them and tool_choice becomes any', () => {
    const body = canonicalToAnthropicRequest(
      openAIJsonRequest({
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      }),
      { upstreamModel: 'claude-3-7-sonnet-latest' },
    );
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual([
      'lookup',
      STRUCTURED_OUTPUT_TOOL,
    ]);
    expect(body.tool_choice).toEqual({ type: 'any' });
  });

  it('with extended thinking the tool is asked for, not forced (Anthropic rejects both)', () => {
    const body = canonicalToAnthropicRequest(openAIJsonRequest({ reasoning_effort: 'low' }), {
      upstreamModel: 'claude-sonnet-4-5',
    });
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.system).toContain(STRUCTURED_OUTPUT_TOOL);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('json_object on a native model becomes an instruction and is reported', () => {
    const drops: string[] = [];
    const body = canonicalToAnthropicRequest(
      openAIRequestToCanonical(
        OpenAIChatCompletionRequest.parse({
          model: 'claude',
          messages: [
            { role: 'system', content: 'Be brief.' },
            { role: 'user', content: 'JSON please' },
          ],
          response_format: { type: 'json_object' },
        }),
      ),
      { upstreamModel: 'claude-opus-5-5', onDrop: (f) => drops.push(f) },
    );
    expect(body.system).toBe(
      'Be brief.\n\nRespond with a single valid JSON object and nothing else: no prose and no code fences.',
    );
    expect(body.output_config).toBeUndefined();
    expect(drops).toEqual(['response_format']);
  });

  it('json_object on an older model uses the fallback tool with an object schema', () => {
    const body = canonicalToAnthropicRequest(
      openAIRequestToCanonical(
        OpenAIChatCompletionRequest.parse({
          model: 'claude',
          messages: [{ role: 'user', content: 'JSON please' }],
          response_format: { type: 'json_object' },
        }),
      ),
      { upstreamModel: 'claude-3-5-haiku-latest' },
    );
    expect(body.tools).toEqual([expect.objectContaining({ input_schema: { type: 'object' } })]);
  });

  it('response_format text sends nothing extra', () => {
    const body = canonicalToAnthropicRequest(
      openAIRequestToCanonical(
        OpenAIChatCompletionRequest.parse({
          model: 'claude',
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'text' },
        }),
      ),
      { upstreamModel: 'claude-sonnet-4-5' },
    );
    expect(body.tools).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });
});

describe('golden: Anthropic output_config.format → other providers', () => {
  const anthropicClient = (extra: Record<string, unknown>) =>
    anthropicRequestToCanonical(
      AnthropicMessagesRequest.parse({
        model: 'x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        ...extra,
      }),
    );

  it('becomes response_format for OpenAI, and stays native (with effort) for Anthropic', () => {
    const canonical = anthropicClient({
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    });
    expect(canonical.responseFormat).toEqual({
      type: 'json_schema',
      name: 'output',
      schema: SCHEMA,
    });
    expect(
      canonicalToOpenAIRequest(canonical, { upstreamModel: 'gpt-4.1' }).response_format,
    ).toEqual({ type: 'json_schema', json_schema: { name: 'output', schema: SCHEMA } });
    expect(
      canonicalToAnthropicRequest(canonical, { upstreamModel: 'claude-opus-5-5' }).output_config,
    ).toEqual({ effort: 'low', format: { type: 'json_schema', schema: SCHEMA } });
  });

  it('accepts the older output_format field too', () => {
    const canonical = anthropicClient({ output_format: { type: 'json_schema', schema: SCHEMA } });
    expect(canonical.responseFormat?.type).toBe('json_schema');
    expect(canonical.passthrough?.output_format).toBeUndefined();
  });
});

const FALLBACK_RESPONSE = AnthropicMessagesResponse.parse({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: STRUCTURED_OUTPUT_TOOL,
      input: { city: 'Tehran', temp: 21.5 },
    },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 40, output_tokens: 12 },
});

describe('golden: fallback tool → JSON text (non-stream)', () => {
  it('an OpenAI client gets message.content that validates against the schema', () => {
    const canonical = anthropicResponseToCanonical(FALLBACK_RESPONSE);
    expect(canonical.content).toEqual([{ type: 'text', text: '{"city":"Tehran","temp":21.5}' }]);
    expect(canonical.finishReason).toBe('stop');
    const out = canonicalToOpenAIResponse(canonical, { model: 'claude' });
    const choice = out.choices[0];
    expect(choice?.finish_reason).toBe('stop');
    expect(choice?.message.tool_calls).toBeUndefined();
    const parsed: unknown = JSON.parse(choice?.message.content ?? '');
    expect(validateJsonSchema(parsed, SCHEMA)).toEqual([]);
  });

  it('other tool calls are left alone and keep finish tool_calls', () => {
    const res = unwrapStructuredOutput({
      id: 'a',
      model: 'm',
      created: 1,
      finishReason: 'tool_calls',
      content: [{ type: 'tool_call', id: 't', name: 'lookup', arguments: '{}' }],
    });
    expect(res.finishReason).toBe('tool_calls');
    expect(res.content[0]?.type).toBe('tool_call');
  });

  it('a native response is plain text already and passes unchanged', () => {
    const native = AnthropicMessagesResponse.parse({
      ...FALLBACK_RESPONSE,
      content: [{ type: 'text', text: '{"city":"Tehran","temp":21.5}' }],
      stop_reason: 'end_turn',
    });
    const out = canonicalToOpenAIResponse(anthropicResponseToCanonical(native), { model: 'c' });
    expect(out.choices[0]?.message.content).toBe('{"city":"Tehran","temp":21.5}');
  });
});

const FALLBACK_STREAM = [
  {
    type: 'message_start',
    message: {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 1 },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_2', name: STRUCTURED_OUTPUT_TOOL, input: {} },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"city": "Teh' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: 'ran", "temp": 21.5}' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 12 },
  },
  { type: 'message_stop' },
];

function openAIStreamOf(events: unknown[]) {
  const decoder = new AnthropicStreamDecoder();
  const encoder = new OpenAIStreamEncoder({ model: 'claude', includeUsage: false });
  let sse = '';
  for (const raw of events)
    for (const ev of decoder.push(AnthropicStreamEvent.parse(raw))) sse += encoder.push(ev);
  sse += encoder.end();
  const parser = new SseParser();
  const chunks = [...parser.feed(sse), ...parser.flush()]
    .filter((e) => e.data !== '[DONE]')
    .map((e) => OpenAIChatCompletionChunk.parse(JSON.parse(e.data)));
  let text = '';
  let finish: string | null = null;
  let toolCalls = 0;
  for (const c of chunks) {
    text += c.choices[0]?.delta.content ?? '';
    toolCalls += c.choices[0]?.delta.tool_calls?.length ?? 0;
    finish = c.choices[0]?.finish_reason ?? finish;
  }
  return { text, finish, toolCalls };
}

describe('golden: fallback tool → JSON text (stream)', () => {
  it('an OpenAI client receives content deltas that validate, and finish_reason stop', () => {
    const { text, finish, toolCalls } = openAIStreamOf(FALLBACK_STREAM);
    expect(text).toBe('{"city": "Tehran", "temp": 21.5}');
    expect(finish).toBe('stop');
    expect(toolCalls).toBe(0);
    expect(validateJsonSchema(JSON.parse(text), SCHEMA)).toEqual([]);
  });

  it('a native stream (text deltas) passes unchanged', () => {
    const events = FALLBACK_STREAM.map((e) => {
      if (e.type === 'content_block_start')
        return { ...e, content_block: { type: 'text', text: '' } };
      if (e.type === 'content_block_delta' && 'delta' in e) {
        const json = (e.delta as { partial_json: string }).partial_json;
        return { ...e, delta: { type: 'text_delta', text: json } };
      }
      if (e.type === 'message_delta')
        return { ...e, delta: { stop_reason: 'end_turn', stop_sequence: null } };
      return e;
    });
    const { text, finish } = openAIStreamOf(events);
    expect(text).toBe('{"city": "Tehran", "temp": 21.5}');
    expect(finish).toBe('stop');
  });

  it('keeps tool_calls when the model also called a client tool', () => {
    const stream = new StructuredOutputStream();
    const out = [
      { type: 'tool_call_start', index: 0, id: 'a', name: STRUCTURED_OUTPUT_TOOL },
      { type: 'tool_call_start', index: 1, id: 'b', name: 'lookup' },
      { type: 'finish', finishReason: 'tool_calls' },
    ].flatMap((e) => stream.push(e as Parameters<StructuredOutputStream['push']>[0]));
    expect(out).toEqual([
      { type: 'tool_call_start', index: 1, id: 'b', name: 'lookup' },
      { type: 'finish', finishReason: 'tool_calls' },
    ]);
  });
});
