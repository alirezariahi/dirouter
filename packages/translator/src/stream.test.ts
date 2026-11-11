import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import {
  AnthropicStreamEvent,
  type CanonicalStreamEvent,
  OpenAIChatCompletionChunk,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  AnthropicStreamDecoder,
  AnthropicStreamEncoder,
  OpenAIStreamDecoder,
  OpenAIStreamEncoder,
  SSE_HEARTBEAT,
  SseParser,
  encodeSse,
} from './index.js';

const fixtures = join(import.meta.dirname, '..', '..', 'contracts', 'src', '__fixtures__');
const jsonl = (p: string): unknown[] =>
  readFileSync(join(fixtures, p), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);

const parseAll = (text: string) => {
  const parser = new SseParser();
  return [...parser.feed(text), ...parser.flush()];
};

describe('SseParser', () => {
  it('parses events split at every byte, including Persian multi-byte characters', () => {
    const wire =
      encodeSse({ event: 'x', data: '{"t":"سلام دنیا 🌍"}' }) + encodeSse({ data: 'دوم' });
    const bytes = new TextEncoder().encode(wire);
    const parser = new SseParser();
    const events = [];
    for (const byte of bytes) events.push(...parser.feed(new Uint8Array([byte])));
    events.push(...parser.flush());
    expect(events).toEqual([{ event: 'x', data: '{"t":"سلام دنیا 🌍"}' }, { data: 'دوم' }]);
  });

  it('handles CRLF, CR, multi-line data, comments and ids (last id persists, per spec)', () => {
    const events = parseAll(
      ': heartbeat\r\nid: 7\r\nevent: e\r\ndata: a\r\ndata: b\r\n\r\ndata: c\r\rdata:no-space\n\n',
    );
    expect(events).toEqual([
      { id: '7', event: 'e', data: 'a\nb' },
      { id: '7', data: 'c' },
      { id: '7', data: 'no-space' },
    ]);
  });

  it('handles a CRLF split across chunks as one line ending', () => {
    const parser = new SseParser();
    expect(parser.feed('data: a\r')).toEqual([]);
    expect(parser.feed('\n\r\n')).toEqual([{ data: 'a' }]);
  });

  it('flushes a final event without trailing blank line', () => {
    expect(parseAll('data: tail')).toEqual([{ data: 'tail' }]);
  });

  it('ignores the heartbeat comment', () => {
    expect(parseAll(SSE_HEARTBEAT)).toEqual([]);
  });
});

function reconstructAnthropic(sse: string) {
  const events = parseAll(sse).map((e) => AnthropicStreamEvent.parse(JSON.parse(e.data)));
  let text = '';
  const tools: { id: string; name: string; json: string }[] = [];
  let stop: string | null | undefined;
  let usage: unknown;
  const open = new Set<number>();
  for (const e of events) {
    if (e.type === 'content_block_start') {
      expect(open.size).toBe(0); // only one open block at a time
      open.add(e.index);
      const b = e.content_block as { type: string; id?: string; name?: string };
      if (b.type === 'tool_use') tools.push({ id: b.id ?? '', name: b.name ?? '', json: '' });
    }
    if (e.type === 'content_block_stop') open.delete(e.index);
    if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') text += e.delta.text;
    if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta')
      tools.at(-1)!.json += e.delta.partial_json;
    if (e.type === 'message_delta') {
      stop = e.delta.stop_reason;
      usage = e.usage;
    }
  }
  return { events, text, tools, stop, usage };
}

function reconstructOpenAI(sse: string) {
  const raw = parseAll(sse);
  expect(raw.at(-1)?.data).toBe('[DONE]');
  const chunks = raw.slice(0, -1).map((e) => OpenAIChatCompletionChunk.parse(JSON.parse(e.data)));
  let text = '';
  const tools: { id?: string; name?: string; args: string }[] = [];
  let finish: string | null = null;
  for (const c of chunks) {
    const choice = c.choices[0];
    if (!choice) continue;
    text += choice.delta.content ?? '';
    for (const t of choice.delta.tool_calls ?? []) {
      tools[t.index] ??= { args: '' };
      const entry = tools[t.index]!;
      if (t.id) entry.id = t.id;
      if (t.function?.name) entry.name = t.function.name;
      entry.args += t.function?.arguments ?? '';
    }
    finish = choice.finish_reason ?? finish;
  }
  return { chunks, text, tools, finish, usage: chunks.at(-1)?.usage };
}

describe('OpenAI stream → Anthropic client', () => {
  it('rebuilds text, tool call and usage from the real fixture', () => {
    const decoder = new OpenAIStreamDecoder();
    const encoder = new AnthropicStreamEncoder({ model: 'best' });
    let sse = '';
    for (const raw of jsonl('openai/chat-stream.jsonl')) {
      for (const ev of decoder.push(OpenAIChatCompletionChunk.parse(raw))) sse += encoder.push(ev);
    }
    sse += encoder.end();
    const result = reconstructAnthropic(sse);
    expect(result.text).toBe('سلام');
    expect(result.tools).toEqual([
      { id: 'call_DdmO9pD3xa9XTPNJ32zg2hcA', name: 'get_weather', json: '{"city":"Tehran"}' },
    ]);
    expect(result.stop).toBe('tool_use');
    expect(result.usage).toMatchObject({ input_tokens: 19, output_tokens: 10 });
    expect(result.events[0]?.type).toBe('message_start');
    expect(result.events.at(-1)?.type).toBe('message_stop');
  });
});

describe('Anthropic stream → OpenAI client', () => {
  it('rebuilds text, tool call, finish and usage from the real fixture', () => {
    const decoder = new AnthropicStreamDecoder();
    const encoder = new OpenAIStreamEncoder({ model: 'best', includeUsage: true });
    let sse = '';
    for (const raw of jsonl('anthropic/messages-stream.jsonl')) {
      for (const ev of decoder.push(AnthropicStreamEvent.parse(raw))) sse += encoder.push(ev);
    }
    sse += encoder.end();
    const result = reconstructOpenAI(sse);
    expect(result.text).toBe("Okay, let's check");
    expect(result.tools).toEqual([
      { id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6', name: 'get_weather', args: '{"city": "Tehran"}' },
    ]);
    expect(result.finish).toBe('tool_calls');
    expect(result.usage).toMatchObject({ prompt_tokens: 472, completion_tokens: 89 });
    expect(result.chunks[0]?.choices[0]?.delta.role).toBe('assistant');
  });

  it('omits the usage chunk when the client did not ask for it', () => {
    const encoder = new OpenAIStreamEncoder({ model: 'm', includeUsage: false });
    const sse =
      encoder.push({ type: 'start', id: 'x', model: 'u', created: 1 }) +
      encoder.push({
        type: 'usage',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      }) +
      encoder.end();
    const chunks = parseAll(sse)
      .slice(0, -1)
      .map((e) => JSON.parse(e.data) as { usage?: unknown; choices: unknown[] });
    expect(chunks.every((c) => c.usage === undefined && c.choices.length === 1)).toBe(true);
    expect(encoder.usage?.inputTokens).toBe(1);
  });
});

describe('round trips', () => {
  it('Anthropic → canonical → Anthropic keeps thinking with signature', () => {
    const decoder = new AnthropicStreamDecoder();
    const encoder = new AnthropicStreamEncoder({ model: 'c' });
    let sse = '';
    for (const raw of jsonl('anthropic/messages-stream.jsonl')) {
      for (const ev of decoder.push(AnthropicStreamEvent.parse(raw))) sse += encoder.push(ev);
    }
    sse += encoder.end();
    const { events, tools, stop } = reconstructAnthropic(sse);
    const signature = events.find(
      (e) => e.type === 'content_block_delta' && e.delta.type === 'signature_delta',
    );
    expect(signature).toBeDefined();
    expect(tools[0]?.json).toBe('{"city": "Tehran"}');
    expect(stop).toBe('tool_use');
  });

  it('OpenAI → canonical → OpenAI keeps the tool call', () => {
    const decoder = new OpenAIStreamDecoder();
    const encoder = new OpenAIStreamEncoder({ model: 'm', includeUsage: true });
    let sse = '';
    for (const raw of jsonl('openai/chat-stream.jsonl')) {
      for (const ev of decoder.push(OpenAIChatCompletionChunk.parse(raw))) sse += encoder.push(ev);
    }
    sse += encoder.end();
    const result = reconstructOpenAI(sse);
    expect(result.tools[0]).toEqual({
      id: 'call_DdmO9pD3xa9XTPNJ32zg2hcA',
      name: 'get_weather',
      args: '{"city":"Tehran"}',
    });
    expect(result.usage?.total_tokens).toBe(29);
  });

  it('parallel tool calls from OpenAI become sequential Anthropic blocks', () => {
    const decoder = new OpenAIStreamDecoder();
    const encoder = new AnthropicStreamEncoder({ model: 'c' });
    const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm' } as const;
    const chunks = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'a',
                  type: 'function',
                  function: { name: 'f', arguments: '{"x":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    let sse = '';
    for (const c of chunks)
      for (const ev of decoder.push(OpenAIChatCompletionChunk.parse(c))) sse += encoder.push(ev);
    sse += encoder.end();
    expect(reconstructAnthropic(sse).tools).toEqual([
      { id: 'a', name: 'f', json: '{"x":1}' },
      { id: 'b', name: 'g', json: '{}' },
    ]);
  });
});

describe('errors and edge cases', () => {
  it('encodes upstream errors in each client format', () => {
    const err: CanonicalStreamEvent = {
      type: 'error',
      code: 'overloaded_error',
      message: 'Overloaded',
    };
    expect(parseAll(new AnthropicStreamEncoder({ model: 'm' }).push(err))[0]).toMatchObject({
      event: 'error',
    });
    expect(
      JSON.parse(
        parseAll(new OpenAIStreamEncoder({ model: 'm', includeUsage: false }).push(err))[0]!.data,
      ),
    ).toMatchObject({ error: { code: 'overloaded_error' } });
    expect(
      new AnthropicStreamDecoder().push({
        type: 'error',
        error: { type: 'overloaded_error', message: 'x' },
      }),
    ).toEqual([{ type: 'error', code: 'overloaded_error', message: 'x' }]);
  });

  it('a stream that ends without finish still closes properly', () => {
    const enc = new AnthropicStreamEncoder({ model: 'm' });
    const sse = enc.push({ type: 'text_delta', index: 0, text: 'hi' }) + enc.end();
    expect(reconstructAnthropic(sse)).toMatchObject({ text: 'hi', stop: 'end_turn' });
    const oai = new OpenAIStreamEncoder({ model: 'm', includeUsage: false });
    expect(
      reconstructOpenAI(oai.push({ type: 'text_delta', index: 0, text: 'hi' }) + oai.end()),
    ).toMatchObject({ text: 'hi', finish: 'stop' });
  });

  it('emits Anthropic ping events', () => {
    expect(parseAll(new AnthropicStreamEncoder({ model: 'm' }).ping())[0]).toEqual({
      event: 'ping',
      data: '{"type":"ping"}',
    });
  });

  it('maps reasoning_content from compatible providers to thinking blocks', () => {
    const decoder = new OpenAIStreamDecoder();
    const encoder = new AnthropicStreamEncoder({ model: 'c' });
    const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'r1' } as const;
    let sse = '';
    for (const c of [
      {
        ...base,
        choices: [{ index: 0, delta: { reasoning_content: 'hmm' }, finish_reason: null }],
      },
      { ...base, choices: [{ index: 0, delta: { content: '42' }, finish_reason: 'stop' }] },
    ]) {
      for (const ev of decoder.push(OpenAIChatCompletionChunk.parse(c))) sse += encoder.push(ev);
    }
    sse += encoder.end();
    const types = reconstructAnthropic(sse).events.map((e) =>
      e.type === 'content_block_start' ? (e.content_block as { type: string }).type : e.type,
    );
    expect(types).toEqual([
      'message_start',
      'thinking',
      'content_block_delta',
      'content_block_stop',
      'text',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('handles 10 000 chunks without growing memory', () => {
    const decoder = new OpenAIStreamDecoder();
    const encoder = new AnthropicStreamEncoder({ model: 'm' });
    const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm' } as const;
    const run = (n: number) => {
      let bytes = 0;
      for (let i = 0; i < n; i++) {
        const chunk = OpenAIChatCompletionChunk.parse({
          ...base,
          choices: [{ index: 0, delta: { content: 'توکن ' }, finish_reason: null }],
        });
        for (const ev of decoder.push(chunk)) bytes += encoder.push(ev).length;
      }
      return bytes;
    };
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as () => void;
    run(1_000); // warm-up
    gc();
    const before = process.memoryUsage().heapUsed;
    const bytes = run(10_000);
    gc();
    const retained = process.memoryUsage().heapUsed - before;
    expect(bytes).toBeGreaterThan(10_000 * 50);
    // About 2MB of output was produced, but nothing is retained.
    expect(retained).toBeLessThan(256 * 1024);
  });
});

describe('anthropicErrorType', () => {
  it('keeps standard types and maps DiRouter classes to standard ones', async () => {
    const { anthropicErrorType } = await import('./index.js');
    expect(anthropicErrorType('overloaded_error')).toBe('overloaded_error');
    expect(anthropicErrorType('overloaded')).toBe('overloaded_error');
    expect(anthropicErrorType('rate_limit')).toBe('rate_limit_error');
    expect(anthropicErrorType('RESOURCE_EXHAUSTED')).toBe('rate_limit_error');
    expect(anthropicErrorType('timeout')).toBe('timeout_error');
    expect(anthropicErrorType('connection')).toBe('api_error');
    expect(anthropicErrorType('server')).toBe('api_error');
  });
});
