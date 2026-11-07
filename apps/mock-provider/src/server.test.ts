import { SseParser } from '@dirouter/translator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';
import { parseScenario } from './scenario.js';

const app = buildServer();
let base = '';

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => app.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const oa = { model: 'mock-small', messages: [{ role: 'user', content: 'hi' }] };
const an = { model: 'mock-small', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

async function sse(res: Response) {
  const parser = new SseParser();
  const events = [...parser.feed(await res.text()), ...parser.flush()];
  return events;
}

describe('scenario parser', () => {
  it('parses directives', () => {
    expect(
      parseScenario('status=429,retry_after=3,latency=10-20,chunks=3,tool=f,drop_after=2'),
    ).toMatchObject({
      status: 429,
      retryAfter: 3,
      latency: [10, 20],
      chunks: 3,
      tool: 'f',
      dropAfter: 2,
    });
    expect(parseScenario('overloaded').status).toBe(529);
  });
});

describe('mock provider', () => {
  it('answers OpenAI non-stream with usage', async () => {
    const body = (await (await post('/v1/chat/completions', oa)).json()) as {
      choices: { message: { content: string } }[];
      usage: { total_tokens: number };
    };
    expect(body.choices[0]?.message.content).toContain('mock');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it('streams OpenAI with usage and [DONE]', async () => {
    const events = await sse(
      await post('/v1/chat/completions', {
        ...oa,
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
    expect(events.at(-1)?.data).toBe('[DONE]');
    expect(JSON.parse(events.at(-2)!.data)).toHaveProperty('usage');
  });

  it('streams Anthropic events', async () => {
    const events = await sse(await post('/v1/messages', { ...an, stream: true }));
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining([
        'message_start',
        'content_block_delta',
        'message_delta',
        'message_stop',
      ]),
    );
  });

  it('returns a tool call in both APIs', async () => {
    const o = (await (
      await post('/v1/chat/completions', oa, { 'x-mock': 'tool=get_weather' })
    ).json()) as { choices: { finish_reason: string }[] };
    expect(o.choices[0]?.finish_reason).toBe('tool_calls');
    const a = (await (await post('/v1/messages', an, { 'x-mock': 'tool=get_weather' })).json()) as {
      stop_reason: string;
    };
    expect(a.stop_reason).toBe('tool_use');
  });

  it.each([
    ['status=500', 500],
    ['status=503', 503],
    ['overloaded', 529],
    ['auth', 401],
    ['context_length', 400],
    ['error_rate=1', 503],
  ])('x-mock: %s → %i', async (directives, status) => {
    expect((await post('/v1/chat/completions', oa, { 'x-mock': directives })).status).toBe(status);
  });

  it('selects the scenario from the API key and sends Retry-After', async () => {
    const res = await post('/v1/messages', an, { 'x-api-key': 'mock:rate_limit,retry_after=7' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } });
  });

  it('drops the connection mid-stream', async () => {
    const res = await post(
      '/v1/chat/completions',
      { ...oa, stream: true },
      { 'x-mock': 'drop_after=2,chunks=6' },
    );
    await expect(res.text()).rejects.toThrow();
  });

  it('delays the first byte (TTFT)', async () => {
    const started = Date.now();
    await post('/v1/chat/completions', oa, { 'x-mock': 'ttft=150' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('serves Azure deployment paths and models', async () => {
    const res = (await (
      await post('/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21', oa)
    ).json()) as { model: string };
    expect(res.model).toBe('gpt4o');
    const models = (await (await fetch(`${base}/v1/models`)).json()) as { data: unknown[] };
    expect(models.data.length).toBe(3);
  });

  it('counts requests and can change defaults at runtime', async () => {
    await fetch(`${base}/__mock/reset`, { method: 'POST' });
    await fetch(`${base}/__mock/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directives: 'status=502' }),
    });
    expect((await post('/v1/chat/completions', oa)).status).toBe(502);
    const stats = (await (await fetch(`${base}/__mock/stats`)).json()) as {
      requests: number;
      byStatus: Record<string, number>;
    };
    expect(stats).toMatchObject({ requests: 1, byStatus: { '502': 1 } });
    await fetch(`${base}/__mock/reset`, { method: 'POST' });
  });
});
