/** Streamed playground calls: request shape, validation and the event stream (card 25.6). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env.js';
import type { PrismaService } from '../infra/prisma.service.js';
import { PlaygroundStreamBody, routingHeaders, streamRequest } from './playground.schema.js';
import { PlaygroundService } from './playground.service.js';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const base = { apiKey: 'dr-abcdefgh-secretsecret', model: 'mock/small', prompt: 'hi' };
const tool = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Weather of a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

describe('PlaygroundStreamBody and the gateway request', () => {
  it('sends tools, an image and every parameter the way a client does', () => {
    const input = PlaygroundStreamBody.parse({
      ...base,
      system: 'be brief',
      image: PNG,
      tools: [tool],
      toolChoice: 'required',
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.9,
      reasoningEffort: 'low',
      responseFormat: { type: 'json_object' },
    });
    expect(streamRequest(input)).toEqual({
      model: 'mock/small',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'be brief' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: PNG } },
          ],
        },
      ],
      max_tokens: 64,
      temperature: 0.2,
      top_p: 0.9,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      tools: [tool],
      tool_choice: 'required',
    });
    // Without tools there is no tool_choice; a plain prompt stays a string.
    const plain = streamRequest(PlaygroundStreamBody.parse({ ...base, toolChoice: 'auto' }));
    expect(plain).not.toHaveProperty('tool_choice');
    expect(plain.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(plain.max_tokens).toBe(512);
    // A replayed request (card 24.1) keeps its earlier turns before the prompt.
    const replayed = streamRequest(
      PlaygroundStreamBody.parse({
        ...base,
        system: 's',
        history: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer' },
        ],
      }),
    );
    expect(replayed.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('refuses what the gateway or the body limit would not take', () => {
    const bad = (extra: Record<string, unknown>) =>
      PlaygroundStreamBody.safeParse({ ...base, ...extra }).success;
    expect(bad({ image: 'https://example.com/cat.png' })).toBe(false);
    expect(bad({ image: `data:image/png;base64,${'A'.repeat(900_000)}` })).toBe(false);
    expect(bad({ topP: 1.5 })).toBe(false);
    expect(bad({ reasoningEffort: 'extreme' })).toBe(false);
    expect(bad({ tools: [{ type: 'function', function: { name: 'has space' } }] })).toBe(false);
    expect(
      bad({
        responseFormat: {
          type: 'json_schema',
          json_schema: { name: 'r', schema: { type: 'object' } },
        },
      }),
    ).toBe(true);
  });

  it('keeps only the routing headers of the gateway answer', () => {
    expect(
      routingHeaders(
        new Headers({
          'x-dirouter-model': 'mock/small',
          'x-dirouter-provider': 'mock',
          'x-request-id': 'req_1',
          'set-cookie': 'nope',
          'content-type': 'text/event-stream',
        }),
      ),
    ).toEqual({
      'x-dirouter-model': 'mock/small',
      'x-dirouter-provider': 'mock',
      'x-request-id': 'req_1',
    });
  });
});

describe('the event stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const service = () =>
    new PlaygroundService(
      {} as PrismaService,
      {
        GATEWAY_INTERNAL_URL: 'http://gateway:8080',
      } as unknown as Env,
    );
  const sse = (frames: unknown[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames)
          controller.enqueue(
            enc.encode(`data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`),
          );
        controller.close();
      },
    });
  const events = async (gen: AsyncGenerator<string>) => {
    const out: { event: string; data: Record<string, unknown> }[] = [];
    for await (const text of gen) {
      const [, event = ''] = /^event: (\S+)/.exec(text) ?? [];
      const [, data = '{}'] = /\ndata: (.*)\n\n$/s.exec(text) ?? [];
      out.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    }
    return out;
  };

  it('re-emits the chunks with routing headers, TTFT, tool calls, usage and cost', async () => {
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        new Response(
          sse([
            { choices: [{ delta: { role: 'assistant' } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '{"ci' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                { delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Tehran"}' } }] } },
              ],
            },
            { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 2000 } },
            '[DONE]',
          ]),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'x-dirouter-model': 'mock/small' },
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const input = PlaygroundStreamBody.parse({ ...base, tools: [tool] });
    const out = await events(
      service().stream(input, { inputPerMTok: 3, outputPerMTok: 15 }, new AbortController().signal),
    );
    expect(out.map((e) => e.event)).toEqual([
      'meta',
      'chunk',
      'ttft',
      'chunk',
      'chunk',
      'chunk',
      'end',
    ]);
    expect(out[0]?.data).toEqual({ status: 200, headers: { 'x-dirouter-model': 'mock/small' } });
    expect(typeof out[2]?.data.ms).toBe('number');
    expect(out.at(-1)?.data).toMatchObject({
      inputTokens: 1000,
      outputTokens: 2000,
      estimatedCostUsd: '0.03300000',
    });
    expect(typeof out.at(-1)?.data.ttftMs).toBe('number');
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://gateway:8080/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${base.apiKey}`);
    expect(JSON.parse(init?.body as string)).toMatchObject({ stream: true, tools: [tool] });
  });

  it('turns a gateway refusal and an unreachable gateway into error events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { error: { code: 'budget_exceeded', message: 'Monthly key budget exceeded' } },
            { status: 429, headers: { 'x-request-id': 'req_9' } },
          ),
        ),
      ),
    );
    const input = PlaygroundStreamBody.parse(base);
    const refused = await events(service().stream(input, undefined, new AbortController().signal));
    expect(refused.map((e) => e.event)).toEqual(['meta', 'error', 'end']);
    expect(refused[1]?.data).toEqual({
      status: 429,
      code: 'budget_exceeded',
      message: 'Monthly key budget exceeded',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const down = await events(service().stream(input, undefined, new AbortController().signal));
    expect(down.map((e) => e.event)).toEqual(['error', 'end']);
  });
});
