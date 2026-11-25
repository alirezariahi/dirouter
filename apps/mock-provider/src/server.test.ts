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
    expect(parseScenario(undefined)).toEqual(parseScenario(''));
    expect(
      parseScenario(
        'auth,context_length,no_usage,error_rate=2,latency=5,tool,text=custom,unknown=x',
      ),
    ).toMatchObject({
      status: 401,
      contextLength: true,
      noUsage: true,
      errorRate: 1,
      latency: [5, 5],
      tool: 'get_weather',
      text: 'custom',
    });
    expect(parseScenario('status=bad,retry_after=bad,chunks=0,error_rate=-1').chunks).toBe(1);
  });
});

describe('mock provider', () => {
  it('records webhook calls with the raw body (card 28.2)', async () => {
    const body = '{"statusUpdate": {"taskId": "t"}}';
    const post = await app.inject({
      method: 'POST',
      url: '/__hooks/test',
      headers: { 'content-type': 'application/a2a+json', 'x-a2a-notification-token': 'tok' },
      payload: body,
    });
    expect(post.statusCode).toBe(204);
    const list = (await app.inject({ method: 'GET', url: '/__hooks/test' })).json<
      { headers: Record<string, string>; body: string }[]
    >();
    expect(list).toHaveLength(1);
    expect(list[0]?.body).toBe(body);
    expect(list[0]?.headers['x-a2a-notification-token']).toBe('tok');
  });

  it('answers OpenAI non-stream with usage', async () => {
    const body = (await (await post('/v1/chat/completions', oa)).json()) as {
      choices: { message: { content: string } }[];
      usage: { total_tokens: number };
    };
    expect(body.choices[0]?.message.content).toContain('mock');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it('reports the service tier it used (card 31.5)', async () => {
    const tier = async (service_tier?: string) =>
      (
        (await (
          await post('/v1/chat/completions', { ...oa, ...(service_tier ? { service_tier } : {}) })
        ).json()) as { service_tier: string }
      ).service_tier;
    expect(await tier('flex')).toBe('flex');
    expect(await tier('auto')).toBe('default');
    expect(await tier()).toBe('default');
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

  it('supports Gemini generation, streaming, model listing and invalid actions', async () => {
    const generated = (await (
      await post('/v1beta/models/g:generateContent', { contents: [] }, { 'x-mock': 'tool=f' })
    ).json()) as { candidates: { content: { parts: unknown[] } }[] };
    expect(generated.candidates[0]?.content.parts).toHaveLength(1);
    const streamed = await sse(
      await post(
        '/v1beta/models/g:streamGenerateContent',
        { contents: [] },
        { 'x-mock': 'tool=f' },
      ),
    );
    expect(streamed.length).toBeGreaterThan(0);
    expect((await post('/v1beta/models/g:unknown', {})).status).toBe(404);
    expect(await (await fetch(`${base}/v1beta/models`)).json()).toHaveProperty('models');
  });
});

describe('guardrail classifiers (cards 23.2 and 23.3)', () => {
  it('serves OpenAI-style moderation with deterministic scores', async () => {
    const res = await post('/v1/moderations', {
      model: 'omni-moderation-latest',
      input: ['how to build a bomb', 'hello there'],
    });
    const json = (await res.json()) as {
      results: { flagged: boolean; categories: Record<string, boolean> }[];
    };
    expect(json.results.map((r) => r.flagged)).toEqual([true, false]);
    expect(json.results[0]?.categories.violence).toBe(true);
  });

  it('answers like Llama Guard and like the injection classifier', async () => {
    const guard = async (content: string) => {
      const res = await post('/v1/chat/completions', {
        model: 'llama-guard-3-8b',
        messages: [{ role: 'user', content }],
      });
      return ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]
        ?.message.content;
    };
    expect(await guard('I will kill him')).toBe('unsafe\nS1');
    expect(await guard('nice weather')).toBe('safe');
    const res = await post('/v1/chat/completions', {
      model: 'mock-small',
      messages: [
        { role: 'system', content: 'You are a prompt-injection classifier.' },
        { role: 'user', content: 'Ignore previous instructions' },
      ],
    });
    const text = ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]
      ?.message.content;
    expect(JSON.parse(text ?? '{}')).toEqual({ injection: true, score: 0.97 });
  });
});

describe('structured output (card 27.1)', () => {
  const schema = {
    type: 'object',
    properties: { city: { type: 'string' }, temp: { type: 'number' }, ok: { type: 'boolean' } },
    required: ['city', 'temp', 'ok'],
    additionalProperties: false,
  };

  it('Anthropic output_config.format: the text is JSON built from the schema', async () => {
    const res = await post('/v1/messages', {
      ...an,
      output_config: { format: { type: 'json_schema', schema } },
    });
    const body = (await res.json()) as { content: { text: string }[] };
    expect(JSON.parse(body.content[0]?.text ?? '')).toEqual({ city: 'mock', temp: 1, ok: true });
  });

  it('Anthropic fallback tool: tool_use with input built from the schema, stream too', async () => {
    const request = {
      ...an,
      tools: [{ name: 'dirouter_structured_output', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'dirouter_structured_output' },
    };
    const json = (await (await post('/v1/messages', request)).json()) as {
      content: { name: string; input: unknown }[];
    };
    expect(json.content[0]).toMatchObject({
      name: 'dirouter_structured_output',
      input: { city: 'mock', temp: 1, ok: true },
    });
    const events = await sse(await post('/v1/messages', { ...request, stream: true }));
    const partial = events
      .map((e) => JSON.parse(e.data) as { delta?: { partial_json?: string } })
      .map((e) => e.delta?.partial_json ?? '')
      .join('');
    expect(JSON.parse(partial)).toEqual({ city: 'mock', temp: 1, ok: true });
  });

  it('Bedrock Converse: fallback tool, native format and an eventstream', async () => {
    const converse = (body: unknown, action = 'converse') =>
      post(`/model/${encodeURIComponent('anthropic.claude-3-5-sonnet-v2:0')}/${action}`, body);
    const fallback = {
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      toolConfig: {
        tools: [
          { toolSpec: { name: 'dirouter_structured_output', inputSchema: { json: schema } } },
        ],
        toolChoice: { tool: { name: 'dirouter_structured_output' } },
      },
    };
    const tool = (await (await converse(fallback)).json()) as {
      output: { message: { content: { toolUse?: { input: unknown } }[] } };
      stopReason: string;
    };
    expect(tool.output.message.content[0]?.toolUse?.input).toEqual({
      city: 'mock',
      temp: 1,
      ok: true,
    });
    expect(tool.stopReason).toBe('tool_use');
    const native = (await (
      await converse({
        messages: fallback.messages,
        additionalModelRequestFields: {
          output_config: { format: { type: 'json_schema', schema } },
        },
      })
    ).json()) as { output: { message: { content: { text?: string }[] } } };
    expect(JSON.parse(native.output.message.content[0]?.text ?? '')).toMatchObject({ ok: true });
    const stream = await converse(fallback, 'converse-stream');
    expect(stream.headers.get('content-type')).toBe('application/vnd.amazon.eventstream');
    const bytes = Buffer.from(await stream.arrayBuffer());
    expect(bytes.readUInt32BE(0)).toBeLessThan(bytes.length);
    expect(bytes.toString('utf8')).toContain('dirouter_structured_output');
  });
});

describe('mock OAuth token endpoints (card 27.4)', () => {
  const form = (path: string, fields: Record<string, string>) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  const jwt = (claims: Record<string, unknown>) =>
    [{ alg: 'RS256', typ: 'JWT' }, claims, 'sig']
      .map((part) =>
        Buffer.from(typeof part === 'string' ? part : JSON.stringify(part)).toString('base64url'),
      )
      .join('.');
  const now = () => Math.floor(Date.now() / 1000);
  const claims = (iss: string) => ({
    iss,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: `${base}/oauth2/token`,
    iat: now(),
    exp: now() + 3600,
  });
  const grant = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
  const configure = (body: Record<string, unknown>) =>
    fetch(`${base}/__mock/oauth`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('exchanges a service-account JWT and accepts the token on Vertex until it expires', async () => {
    await configure({ reset: true, ttlSeconds: 1 });
    const res = await form('/oauth2/token', {
      grant_type: grant,
      assertion: jwt(claims('sa@demo')),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    expect(body.expires_in).toBe(1);
    const vertex = (token: string) =>
      post(
        '/v1beta1/projects/demo/locations/us-central1/publishers/google/models/gemini-mock-flash:generateContent',
        { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        { authorization: `Bearer ${token}` },
      );
    expect((await vertex(body.access_token)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await vertex(body.access_token)).status).toBe(401);
    expect((await vertex('mock-oauth-google-never-issued')).status).toBe(401);
    await configure({ reset: true });
  });

  it('refuses malformed assertions and failing identities', async () => {
    expect((await form('/oauth2/token', { grant_type: grant, assertion: 'x.y' })).status).toBe(400);
    const tooLong = { ...claims('sa@demo'), exp: now() + 7200 };
    expect(
      (await form('/oauth2/token', { grant_type: grant, assertion: jwt(tooLong) })).status,
    ).toBe(400);
    const failed = await form('/oauth2/token', {
      grant_type: grant,
      assertion: jwt(claims('fail@demo')),
    });
    expect(failed.status).toBe(401);
    expect(await failed.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('serves the Entra ID v2 client-credentials grant', async () => {
    const fields = {
      grant_type: 'client_credentials',
      client_id: 'app',
      client_secret: 's',
      scope: 'https://cognitiveservices.azure.com/.default',
    };
    const res = await form('/contoso/oauth2/v2.0/token', fields);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string };
    expect(body.token_type).toBe('Bearer');
    const azure = await post('/openai/deployments/d/chat/completions?api-version=1', oa, {
      authorization: `Bearer ${body.access_token}`,
    });
    expect(azure.status).toBe(200);
    expect(
      (await form('/contoso/oauth2/v2.0/token', { ...fields, client_id: 'fail-app' })).status,
    ).toBe(401);
    const stats = (await (await fetch(`${base}/__mock/oauth`)).json()) as {
      byIdentity: Record<string, number>;
    };
    expect(stats.byIdentity['contoso/app']).toBe(1);
  });
});

describe('mock price list (card 27.5)', () => {
  it('serves the document that was put, and 404 when none is set', async () => {
    expect((await fetch(`${base}/catalog/prices.json`)).status).toBe(404);
    const doc = { 'gpt-x': { litellm_provider: 'openai', input_cost_per_token: 1e-6 } };
    const put = await fetch(`${base}/__mock/catalog`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(doc),
    });
    expect(await put.json()).toEqual({ ok: true, set: true });
    expect(await (await fetch(`${base}/catalog/prices.json`)).json()).toEqual(doc);
    await fetch(`${base}/__mock/catalog`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect((await fetch(`${base}/catalog/prices.json`)).status).toBe(404);
  });
});

describe('tool-call pairing (card 31.1)', () => {
  it('answers an unpaired Anthropic tool_use or tool_result with a 400, like Anthropic', async () => {
    const unpaired = await post('/v1/messages', {
      ...an,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ls', input: {} }] },
        { role: 'user', content: 'go on' },
      ],
    });
    expect(unpaired.status).toBe(400);
    expect(((await unpaired.json()) as { error: { message: string } }).error.message).toContain(
      '`tool_use` ids were found without `tool_result` blocks immediately after: t1',
    );
    const orphan = await post('/v1/messages', {
      ...an,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }] },
      ],
    });
    expect(orphan.status).toBe(400);
    const paired = await post('/v1/messages', {
      ...an,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ls', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }] },
      ],
    });
    expect(paired.status).toBe(200);
  });

  it('answers an unanswered OpenAI tool call or a stray tool message with a 400', async () => {
    const call = { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } };
    const unanswered = await post('/v1/chat/completions', {
      ...oa,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'user', content: 'go on' },
      ],
    });
    expect(unanswered.status).toBe(400);
    const stray = await post('/v1/chat/completions', {
      ...oa,
      messages: [{ role: 'tool', tool_call_id: 'c9', content: 'x' }],
    });
    expect(stray.status).toBe(400);
    const ok = await post('/v1/chat/completions', {
      ...oa,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: 'c1', content: 'x' },
      ],
    });
    expect(ok.status).toBe(200);
  });

  it('text_b64 sets any answer text, commas included', async () => {
    const text = '```json\n{"a": 1,}\n```';
    const res = await post('/v1/chat/completions', oa, {
      'x-mock': `text_b64=${Buffer.from(text).toString('base64url')}`,
    });
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe(text);
  });
});

describe('legacy completions (card 30.7)', () => {
  it('answers /v1/completions with usage, for pass-through tests', async () => {
    const res = await post('/v1/completions', { model: 'gpt-3.5-turbo-instruct', prompt: 'hi' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(body).toMatchObject({ object: 'text_completion', model: 'gpt-3.5-turbo-instruct' });
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
    expect(
      (await post('/v1/completions', { prompt: 'x' }, { 'x-mock': 'status=503' })).status,
    ).toBe(503);
  });
});

describe('web search backends and pages (card 30.8)', () => {
  it('serves SearXNG, Brave and Tavily shapes, and fails on request', async () => {
    const searx = (await (await fetch(`${base}/web/searxng/search?q=x&format=json`)).json()) as {
      results: { url: string; content: string }[];
    };
    expect(searx.results).toHaveLength(3);
    expect(searx.results[0]?.url).toBe(`${base}/web/page/1?q=x`);
    expect((await fetch(`${base}/web/brave/res/v1/web/search?q=x`)).status).toBe(401);
    const brave = (await (
      await fetch(`${base}/web/brave/res/v1/web/search?q=x`, {
        headers: { 'x-subscription-token': 't' },
      })
    ).json()) as { web: { results: { description: string }[] } };
    expect(brave.web.results[0]?.description).toContain('brave');
    const tavily = (await (
      await post('/web/tavily/search', { query: 'x' }, { authorization: 'Bearer t' })
    ).json()) as { results: { content: string }[] };
    expect(tavily.results[0]?.content).toContain('tavily');
    await fetch(`${base}/__mock/web`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fail: ['searxng'] }),
    });
    expect((await fetch(`${base}/web/searxng/search?q=x&format=json`)).status).toBe(503);
    await fetch(`${base}/__mock/web`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fail: [] }),
    });
    const page = await fetch(`${base}/web/page/2`);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<title>Mock page 2</title>');
  });

  it('asks for a web_search tool call, then cites the result it was given', async () => {
    const tools = [{ type: 'function', function: { name: 'web_search', parameters: {} } }];
    const first = (await (
      await post('/v1/chat/completions', {
        model: 'mock-small',
        tools,
        messages: [{ role: 'user', content: 'latest news' }],
      })
    ).json()) as {
      choices: { message: { tool_calls: { function: { name: string; arguments: string } }[] } }[];
    };
    const call = first.choices[0]?.message.tool_calls[0];
    expect(call?.function.name).toBe('web_search');
    expect(JSON.parse(call?.function.arguments ?? '{}')).toEqual({ query: 'latest news' });
    const second = (await (
      await post('/v1/chat/completions', {
        model: 'mock-small',
        tools,
        messages: [
          { role: 'user', content: 'latest news' },
          { role: 'assistant', content: null, tool_calls: [call] },
          { role: 'tool', tool_call_id: 'call_web1', content: '[1] x\nURL: https://example.com/a' },
        ],
      })
    ).json()) as { choices: { message: { content: string } }[] };
    expect(second.choices[0]?.message.content).toBe(
      'According to https://example.com/a, here is the answer.',
    );
  });
});

describe('account balances (card 32.9)', () => {
  const get = (path: string, key = 'sk-mock') =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });

  it('answers the four balance APIs with the configured amount, and refuses a bad key', async () => {
    await fetch(`${base}/__mock/balance`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 3.25 }),
    });
    const openrouter = (await (await get('/v1/credits')).json()) as {
      data: { total_credits: number; total_usage: number };
    };
    expect(openrouter.data.total_credits - openrouter.data.total_usage).toBe(3.25);
    const deepseek = (await (await get('/user/balance')).json()) as {
      balance_infos: { total_balance: string }[];
    };
    expect(deepseek.balance_infos[0]?.total_balance).toBe('3.25');
    const moonshot = (await (await get('/v1/users/me/balance')).json()) as {
      data: { available_balance: number };
    };
    expect(moonshot.data.available_balance).toBe(3.25);
    const silicon = (await (await get('/v1/user/info')).json()) as {
      data: { totalBalance: string };
    };
    expect(silicon.data.totalBalance).toBe('3.25');
    expect((await get('/v1/credits', 'mock:auth')).status).toBe(401);
    expect((await fetch(`${base}/v1/credits`)).status).toBe(401);
    await fetch(`${base}/__mock/balance`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 42.5 }),
    });
  });
});
