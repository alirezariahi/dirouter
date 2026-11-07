import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  type CanonicalRequest,
  type CanonicalResponse,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  SERVER_TOOLS_KEY,
  anthropicRequestToCanonical,
  anthropicResponseToCanonical,
  anthropicStopToCanonical,
  canonicalToAnthropicRequest,
  canonicalToAnthropicResponse,
  canonicalToOpenAIRequest,
  canonicalToOpenAIResponse,
  imageFromUrl,
  openAIFinishToCanonical,
  openAIRequestToCanonical,
  openAIResponseToCanonical,
  parseToolArguments,
} from './index.js';

const fixtures = join(import.meta.dirname, '..', '..', 'contracts', 'src', '__fixtures__');
const fixture = (p: string): unknown => JSON.parse(readFileSync(join(fixtures, p), 'utf8'));

const oaReq = (body: Record<string, unknown>) =>
  OpenAIChatCompletionRequest.parse({ model: 'gpt-4.1', ...body });
const anReq = (body: Record<string, unknown>) =>
  AnthropicMessagesRequest.parse({ model: 'claude-sonnet-4-5', max_tokens: 1024, ...body });

function collectDrops() {
  const drops: string[] = [];
  return { drops, onDrop: (field: string) => drops.push(field) };
}

const baseCanonical = (over: Partial<CanonicalRequest>): CanonicalRequest => ({
  inboundApi: 'openai.chat',
  model: 'm',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  stream: false,
  ...over,
});

const baseResponse = (over: Partial<CanonicalResponse>): CanonicalResponse => ({
  id: 'abc',
  model: 'upstream',
  content: [{ type: 'text', text: 'hello' }],
  finishReason: 'stop',
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
  created: 1_700_000_000,
  ...over,
});

// ───────────── golden: OpenAI request → Anthropic request ─────────────

interface Golden {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const OPENAI_TO_ANTHROPIC: Golden[] = [
  {
    name: 'plain user message',
    input: { messages: [{ role: 'user', content: 'سلام' }] },
    expected: {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'سلام' }] }],
      max_tokens: 4096,
    },
  },
  {
    name: 'system and developer become top-level system',
    input: {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'developer', content: [{ type: 'text', text: 'Answer in Persian.' }] },
        { role: 'user', content: 'hi' },
      ],
    },
    expected: { system: 'Be brief.\n\nAnswer in Persian.' },
  },
  {
    name: 'max_completion_tokens wins over max_tokens',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 10,
      max_completion_tokens: 20,
    },
    expected: { max_tokens: 20 },
  },
  {
    name: 'stop string becomes stop_sequences',
    input: { messages: [{ role: 'user', content: 'x' }], stop: 'END' },
    expected: { stop_sequences: ['END'] },
  },
  {
    name: 'stop array',
    input: { messages: [{ role: 'user', content: 'x' }], stop: ['a', 'b'] },
    expected: { stop_sequences: ['a', 'b'] },
  },
  {
    name: 'temperature above 1 is clamped',
    input: { messages: [{ role: 'user', content: 'x' }], temperature: 1.6 },
    expected: { temperature: 1 },
  },
  {
    name: 'top_p is kept',
    input: { messages: [{ role: 'user', content: 'x' }], top_p: 0.9 },
    expected: { top_p: 0.9 },
  },
  {
    name: 'user becomes metadata.user_id',
    input: { messages: [{ role: 'user', content: 'x' }], user: 'u-1' },
    expected: { metadata: { user_id: 'u-1' } },
  },
  {
    name: 'image_url with data URL becomes base64 image',
    input: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    },
    expected: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    },
  },
  {
    name: 'image_url with https URL becomes url image',
    input: {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
      ],
    },
    expected: {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
        },
      ],
    },
  },
  {
    name: 'tools become input_schema tools',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          function: { name: 'f', description: 'd', parameters: { type: 'object' } },
        },
      ],
    },
    expected: { tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }] },
  },
  {
    name: 'tool without parameters gets an empty object schema',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
    },
    expected: { tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }] },
  },
  {
    name: 'tool_choice required → any',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: 'required',
    },
    expected: { tool_choice: { type: 'any' } },
  },
  {
    name: 'tool_choice named function → tool',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
    },
    expected: { tool_choice: { type: 'tool', name: 'f' } },
  },
  {
    name: 'tool_choice none',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: 'none',
    },
    expected: { tool_choice: { type: 'none' } },
  },
  {
    name: 'parallel_tool_calls false → disable_parallel_tool_use',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      parallel_tool_calls: false,
    },
    expected: { tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
  },
  {
    name: 'assistant tool_calls → tool_use with parsed input',
    input: {
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'w', arguments: '{"city":"Tehran"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '18C' },
      ],
    },
    expected: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'w', input: { city: 'Tehran' } }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [{ type: 'text', text: '18C' }],
            },
          ],
        },
      ],
    },
  },
  {
    name: 'parallel tool results merge into one user message, before follow-up text',
    input: {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } },
            { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: '1' },
        { role: 'tool', tool_call_id: 'b', content: '2' },
      ],
    },
    expected: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a', name: 'f', input: {} },
            { type: 'tool_use', id: 'b', name: 'g', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: '1' }] },
            { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: '2' }] },
          ],
        },
      ],
    },
  },
  {
    name: 'consecutive user messages merge',
    input: {
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    },
    expected: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    },
  },
  {
    name: 'reasoning_effort high → thinking budget, max_tokens raised above budget',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      reasoning_effort: 'high',
      max_tokens: 1000,
    },
    expected: { thinking: { type: 'enabled', budget_tokens: 16384 }, max_tokens: 17408 },
  },
  {
    name: 'stream request',
    input: { messages: [{ role: 'user', content: 'x' }], stream: true },
    expected: { stream: true },
  },
];

describe('golden: OpenAI request → Anthropic request', () => {
  it.each(OPENAI_TO_ANTHROPIC)('$name', ({ input, expected }) => {
    const canonical = openAIRequestToCanonical(oaReq(input));
    const out = canonicalToAnthropicRequest(canonical, { upstreamModel: 'claude-sonnet-4-5' });
    expect(out).toMatchObject({ model: 'claude-sonnet-4-5', ...expected });
    // خروجی باید درخواست معتبر Anthropic باشد.
    expect(AnthropicMessagesRequest.safeParse(out).success).toBe(true);
  });
});

// ───────────── golden: Anthropic request → OpenAI request ─────────────

const ANTHROPIC_TO_OPENAI: Golden[] = [
  {
    name: 'string content',
    input: { messages: [{ role: 'user', content: 'سلام' }] },
    expected: { messages: [{ role: 'user', content: 'سلام' }], max_completion_tokens: 1024 },
  },
  {
    name: 'system string → system message',
    input: { system: 'Be brief.', messages: [{ role: 'user', content: 'x' }] },
    expected: {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'x' },
      ],
    },
  },
  {
    name: 'system blocks joined',
    input: {
      system: [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'x' }],
    },
    expected: {
      messages: [
        { role: 'system', content: 'A\n\nB' },
        { role: 'user', content: 'x' },
      ],
    },
  },
  {
    name: 'stop_sequences → stop',
    input: { messages: [{ role: 'user', content: 'x' }], stop_sequences: ['END'] },
    expected: { stop: ['END'] },
  },
  {
    name: 'tool_use and tool_result round',
    input: {
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_1', name: 'w', input: { city: 'Tehran' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '18C' },
            { type: 'text', text: 'and tomorrow?' },
          ],
        },
      ],
    },
    expected: {
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: 'Checking.',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: { name: 'w', arguments: '{"city":"Tehran"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_1', content: '18C' },
        { role: 'user', content: 'and tomorrow?' },
      ],
    },
  },
  {
    name: 'base64 image → data URL',
    input: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
          ],
        },
      ],
    },
    expected: {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }],
        },
      ],
    },
  },
  {
    name: 'tool_choice any → required',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    },
    expected: {
      tool_choice: 'required',
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    },
  },
  {
    name: 'tool_choice tool → function',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'f' },
    },
    expected: { tool_choice: { type: 'function', function: { name: 'f' } } },
  },
  {
    name: 'disable_parallel_tool_use → parallel_tool_calls false',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    },
    expected: { tool_choice: 'auto', parallel_tool_calls: false },
  },
  {
    name: 'thinking budget → reasoning_effort',
    input: {
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled', budget_tokens: 8000 },
    },
    expected: { reasoning_effort: 'medium' },
  },
  {
    name: 'metadata.user_id → user',
    input: { messages: [{ role: 'user', content: 'x' }], metadata: { user_id: 'u-9' } },
    expected: { user: 'u-9' },
  },
  {
    name: 'stream adds include_usage',
    input: { messages: [{ role: 'user', content: 'x' }], stream: true },
    expected: { stream: true, stream_options: { include_usage: true } },
  },
  {
    name: 'temperature and top_p kept',
    input: { messages: [{ role: 'user', content: 'x' }], temperature: 0.3, top_p: 0.8 },
    expected: { temperature: 0.3, top_p: 0.8 },
  },
];

describe('golden: Anthropic request → OpenAI request', () => {
  it.each(ANTHROPIC_TO_OPENAI)('$name', ({ input, expected }) => {
    const canonical = anthropicRequestToCanonical(anReq(input));
    const out = canonicalToOpenAIRequest(canonical, {
      upstreamModel: 'gpt-4.1',
      maxTokensField: 'max_completion_tokens',
    });
    expect(out).toMatchObject({ model: 'gpt-4.1', ...expected });
    expect(OpenAIChatCompletionRequest.safeParse(out).success).toBe(true);
  });
});

// ───────────── golden: responses ─────────────

describe('golden: Anthropic response → OpenAI response', () => {
  it('maps the real tool_use fixture', () => {
    const res = anthropicResponseToCanonical(
      AnthropicMessagesResponse.parse(fixture('anthropic/messages-response-tool-use.json')),
    );
    const out = canonicalToOpenAIResponse(res, { model: 'best' });
    expect(OpenAIChatCompletionResponse.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({
      model: 'best',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: 'Let me check the weather in Tehran.',
            tool_calls: [
              {
                id: 'toolu_01A09q90qw90lq917835lq9',
                function: { name: 'get_weather', arguments: '{"city":"Tehran"}' },
              },
            ],
          },
        },
      ],
      // input_tokens 472 + cache read 1024 = 1496
      usage: {
        prompt_tokens: 1496,
        completion_tokens: 89,
        total_tokens: 1585,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    });
  });

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['model_context_window_exceeded', 'length'],
  ] as const)('stop_reason %s → finish_reason %s', (stop, finish) => {
    const res = anthropicResponseToCanonical(
      AnthropicMessagesResponse.parse({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'c',
        content: [{ type: 'text', text: 'x' }],
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    expect(canonicalToOpenAIResponse(res, { model: 'c' }).choices[0]?.finish_reason).toBe(finish);
  });

  it('refusal moves text into message.refusal', () => {
    const out = canonicalToOpenAIResponse(
      baseResponse({ finishReason: 'refusal', content: [{ type: 'text', text: 'no' }] }),
      { model: 'm' },
    );
    expect(out.choices[0]?.message).toMatchObject({ content: null, refusal: 'no' });
  });
});

describe('golden: OpenAI response → Anthropic response', () => {
  it('maps the real tool_calls fixture', () => {
    const res = openAIResponseToCanonical(
      OpenAIChatCompletionResponse.parse(fixture('openai/chat-response-tool-calls.json')),
    );
    const out = canonicalToAnthropicResponse(res, { model: 'gpt' });
    expect(AnthropicMessagesResponse.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({
      id: 'msg_chatcmpl-B9MHDbslfkBeAs8l4bebGdFOJ6PeG',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'call_q5PNkPXlqJTsYw0ugmoDGv2g',
          name: 'get_weather',
          input: { city: 'Tehran' },
        },
      ],
      usage: { input_tokens: 82, output_tokens: 17, cache_read_input_tokens: 0 },
    });
  });

  it('subtracts cached tokens from input_tokens', () => {
    const res = openAIResponseToCanonical(
      OpenAIChatCompletionResponse.parse({
        id: 'c',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 10,
          total_tokens: 1010,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      }),
    );
    expect(canonicalToAnthropicResponse(res, { model: 'm' }).usage).toMatchObject({
      input_tokens: 200,
      cache_read_input_tokens: 800,
    });
  });

  it.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool_calls', 'tool_use'],
    ['content_filter', 'refusal'],
  ] as const)('finish_reason %s → stop_reason %s', (finish, stop) => {
    const res = openAIResponseToCanonical(
      OpenAIChatCompletionResponse.parse({
        id: 'c',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: finish },
        ],
      }),
    );
    expect(canonicalToAnthropicResponse(res, { model: 'm' }).stop_reason).toBe(stop);
  });

  it('keeps reasoning_content from compatible providers as thinking', () => {
    const res = openAIResponseToCanonical(
      OpenAIChatCompletionResponse.parse({
        id: 'c',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-reasoner',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '42', reasoning_content: 'think' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    expect(canonicalToAnthropicResponse(res, { model: 'm' }).content).toEqual([
      { type: 'thinking', thinking: 'think', signature: '' },
      { type: 'text', text: '42' },
    ]);
  });
});

// ───────────── same-family passthrough and fixtures ─────────────

describe('passthrough', () => {
  it('forwards unknown OpenAI fields only to OpenAI providers', () => {
    const canonical = openAIRequestToCanonical(
      oaReq({
        messages: [{ role: 'user', content: 'x' }],
        logit_bias: { '1': 5 },
        prediction: { type: 'content', content: 'y' },
      }),
    );
    expect(canonicalToOpenAIRequest(canonical, { upstreamModel: 'u' })).toMatchObject({
      logit_bias: { '1': 5 },
      prediction: { type: 'content' },
    });
    expect(canonicalToAnthropicRequest(canonical, { upstreamModel: 'u' })).not.toHaveProperty(
      'logit_bias',
    );
  });

  it('forwards Anthropic server tools only to Anthropic', () => {
    const canonical = anthropicRequestToCanonical(
      AnthropicMessagesRequest.parse(fixture('anthropic/messages-request-tools.json')),
    );
    expect(canonical.passthrough?.[SERVER_TOOLS_KEY]).toHaveLength(1);
    const anthropic = canonicalToAnthropicRequest(canonical, { upstreamModel: 'c' });
    expect((anthropic.tools as { name: string }[]).map((t) => t.name)).toEqual([
      'get_weather',
      'web_search',
    ]);
    const openai = canonicalToOpenAIRequest(canonical, { upstreamModel: 'g' });
    expect((openai.tools as unknown[]).length).toBe(1);
  });

  it('round-trips the real Anthropic fixture with signed thinking intact', () => {
    const raw = AnthropicMessagesRequest.parse(fixture('anthropic/messages-request-tools.json'));
    const out = canonicalToAnthropicRequest(anthropicRequestToCanonical(raw), {
      upstreamModel: raw.model,
    });
    expect(out).toMatchObject({
      system: [
        {
          type: 'text',
          text: 'You are a helpful weather assistant.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: [
        { role: 'user' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', signature: expect.any(String) as string },
            { type: 'tool_use' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_01A09q90qw90lq917835lq9' }],
        },
      ],
    });
  });

  it('translates the real OpenAI fixture to Anthropic and reports dropped fields', () => {
    const { drops, onDrop } = collectDrops();
    const raw = OpenAIChatCompletionRequest.parse(fixture('openai/chat-request-tools.json'));
    const out = canonicalToAnthropicRequest(openAIRequestToCanonical(raw, { onDrop }), {
      upstreamModel: 'c',
      onDrop,
    });
    expect(AnthropicMessagesRequest.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({
      system: 'You are a helpful weather assistant.',
      max_tokens: 512,
      temperature: 0.2,
    });
    expect(drops).toEqual([]);
  });
});

// ───────────── drops and edge cases ─────────────

describe('dropped and edge cases', () => {
  it('reports unsupported OpenAI content and n>1', () => {
    const { drops, onDrop } = collectDrops();
    openAIRequestToCanonical(
      oaReq({
        n: 2,
        messages: [
          {
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }],
          },
        ],
      }),
      { onDrop },
    );
    expect(drops).toEqual(['messages[].content[].input_audio', 'n']);
  });

  it('reports Anthropic-only features sent to OpenAI', () => {
    const { drops, onDrop } = collectDrops();
    canonicalToOpenAIRequest(
      baseCanonical({
        topK: 5,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 't', signature: 's' },
              { type: 'text', text: 'a' },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: 'x',
                content: [{ type: 'image', source: { kind: 'url', url: 'u' } }],
              },
            ],
          },
        ],
      }),
      { upstreamModel: 'u', onDrop },
    );
    expect(drops).toEqual(['assistant.reasoning', 'tool_result.content.image', 'top_k']);
  });

  it('reports OpenAI-only features sent to Anthropic', () => {
    const { drops, onDrop } = collectDrops();
    canonicalToAnthropicRequest(
      baseCanonical({
        seed: 1,
        responseFormat: { type: 'json_object' },
        messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'unsigned' }] }],
      }),
      { upstreamModel: 'u', onDrop },
    );
    expect(drops).toEqual(['assistant.reasoning', 'seed', 'response_format']);
  });

  it('drops document and file-image blocks from Anthropic input', () => {
    const { drops, onDrop } = collectDrops();
    anthropicRequestToCanonical(
      anReq({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'text', data: 'x' } },
              { type: 'image', source: { type: 'file', file_id: 'f' } },
              { type: 'text', text: 'ok' },
            ],
          },
        ],
      }),
      { onDrop },
    );
    expect(drops).toEqual(['messages[].content[].document', 'image.source.file']);
  });

  it('keeps redacted thinking as redacted_thinking', () => {
    const canonical = anthropicRequestToCanonical(
      anReq({
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'ENC' }] },
        ],
      }),
    );
    const out = canonicalToAnthropicRequest(canonical, { upstreamModel: 'c' });
    expect((out.messages as { content: unknown[] }[])[1]?.content).toEqual([
      { type: 'redacted_thinking', data: 'ENC' },
    ]);
    const res = canonicalToAnthropicResponse(
      baseResponse({ content: [{ type: 'reasoning', text: '', redacted: 'ENC' }] }),
      { model: 'm' },
    );
    expect(res.content).toEqual([{ type: 'redacted_thinking', data: 'ENC' }]);
  });

  it('keeps tool result errors and images to Anthropic', () => {
    const out = canonicalToAnthropicRequest(
      baseCanonical({
        messages: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: 't',
                isError: true,
                content: [
                  { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'Q' } },
                ],
              },
            ],
          },
        ],
      }),
      { upstreamModel: 'c' },
    );
    expect(out.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't',
            is_error: true,
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Q' } },
            ],
          },
        ],
      },
    ]);
  });

  it('maps json_schema response_format between OpenAI clients and providers', () => {
    const canonical = openAIRequestToCanonical(
      oaReq({
        messages: [{ role: 'user', content: 'x' }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 's', schema: { type: 'object' }, strict: true },
        },
      }),
    );
    expect(canonical.responseFormat).toEqual({
      type: 'json_schema',
      name: 's',
      schema: { type: 'object' },
      strict: true,
    });
    expect(canonicalToOpenAIRequest(canonical, { upstreamModel: 'u' }).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 's', schema: { type: 'object' }, strict: true },
    });
  });

  it('maps adaptive thinking to a medium effort', () => {
    const canonical = anthropicRequestToCanonical(
      anReq({ messages: [{ role: 'user', content: 'x' }], thinking: { type: 'adaptive' } }),
    );
    expect(canonical.reasoning).toEqual({ effort: 'medium' });
  });

  it('assistant refusal from OpenAI history becomes text', () => {
    const canonical = openAIRequestToCanonical(
      oaReq({
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: null, refusal: 'no' },
        ],
      }),
    );
    expect(canonical.messages[1]?.content).toEqual([{ type: 'text', text: 'no' }]);
  });

  it('invalid tool arguments become {} and are reported', () => {
    const { drops, onDrop } = collectDrops();
    expect(parseToolArguments('{broken', onDrop)).toEqual({});
    expect(parseToolArguments('', onDrop)).toEqual({});
    expect(drops).toEqual(['tool_call.arguments']);
  });

  it('unknown finish reasons map to other', () => {
    expect(openAIFinishToCanonical('weird')).toBe('other');
    expect(openAIFinishToCanonical(null)).toBe('other');
    expect(anthropicStopToCanonical('pause_turn')).toBe('other');
    expect(anthropicStopToCanonical(undefined)).toBe('other');
  });

  it('parses data URLs', () => {
    expect(imageFromUrl('data:image/webp;base64,Zm9v')).toEqual({
      kind: 'base64',
      mediaType: 'image/webp',
      data: 'Zm9v',
    });
    expect(imageFromUrl('https://a/b')).toEqual({ kind: 'url', url: 'https://a/b' });
  });

  it('assistant with only tool calls has null content for OpenAI', () => {
    const out = canonicalToOpenAIResponse(
      baseResponse({
        content: [{ type: 'tool_call', id: 'c', name: 'f', arguments: '{}' }],
        finishReason: 'tool_calls',
      }),
      { model: 'm' },
    );
    expect(out.choices[0]?.message.content).toBeNull();
    expect(out.id).toBe('chatcmpl-abc');
  });
});
