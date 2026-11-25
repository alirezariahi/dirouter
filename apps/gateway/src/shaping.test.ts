/**
 * Request and answer shaping through the whole gateway against the mock provider (sprint 5,
 * epic 31). The mock rejects broken tool histories with the providers' own 400s.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { SseParser } from '@dirouter/translator';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const KEY = 'dr-test-shaping-plain-0123456789';
const REPAIR_KEY = 'dr-test-shaping-repair-012345678';
const STRICT_KEY = 'dr-test-shaping-strict-012345678';
/** Gateway log lines, to check what is logged. */
const logLines: Record<string, unknown>[] = [];
const BROKEN_JSON = '```json\n{"city": "Tehran", "temp": 21,}\n```';
const b64 = (text: string) => Buffer.from(text).toString('base64url');
/** A V4A patch as Codex's apply_patch tool takes it (card 31.2). */
const PATCH = [
  '*** Begin Patch',
  '*** Update File: app.ts',
  '@@',
  "-const greeting = 'hi';",
  "+const greeting = 'hello';",
  '*** End Patch',
].join('\n');
const PATCH_DIRECTIVES = `mock:tool=apply_patch,tool_input_b64=${b64(JSON.stringify({ input: PATCH }))}`;

const mock = buildMock();
let mockUrl = '';
let gw: ReturnType<typeof buildGateway>;
let base = '';

type ProviderType = 'anthropic' | 'openai-compatible' | 'gemini';

const provider = (id: string, type: ProviderType, secret: string) => ({
  id,
  organizationId: 'org',
  slug: id,
  type,
  name: id,
  baseUrl: type === 'openai-compatible' ? `${mockUrl}/v1` : mockUrl,
  enabled: true,
  options: {},
  credentials: [
    { id: `${id}-k`, name: 'k', secret: encrypt(keyring, secret, `${id}-k`), enabled: true },
  ],
});

const model = (id: string, providerId: string, upstreamModel: string, extra = {}) => ({
  id,
  organizationId: 'org',
  slug: id,
  providerId,
  upstreamModel,
  enabled: true,
  contextWindow: 200_000,
  pricing: { inputPerMTok: '3.00', outputPerMTok: '15.00', cacheReadPerMTok: '0.30' },
  capabilities: { tools: true },
  ...extra,
});

const virtualKey = (id: string, key: string, extra = {}) => ({
  id,
  hash: hashApiKey(key, pepper),
  prefix: id,
  organizationId: 'org',
  teamId: null,
  projectId: 'prj',
  enabled: true,
  expiresAt: null,
  ...extra,
});

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const addr = mock.server.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const snapshot: ConfigSnapshotInput = {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      provider('an', 'anthropic', 'sk-ant-mock'),
      provider('oa', 'openai-compatible', 'sk-mock'),
      // The mock reads its directives from the key: this one answers with broken JSON.
      provider('ob', 'openai-compatible', `mock:text_b64=${b64(BROKEN_JSON)}`),
      // Models that answer with a call to apply_patch carrying PATCH (card 31.2).
      provider('ap', 'anthropic', PATCH_DIRECTIVES),
      provider('gp', 'gemini', PATCH_DIRECTIVES),
      // Models that cite a web source (card 31.7).
      provider('ac', 'anthropic', 'mock:citations'),
      provider('gc', 'gemini', 'mock:citations'),
      provider('oc', 'openai-compatible', 'mock:citations'),
    ],
    models: [
      model('claude', 'an', 'claude-sonnet-4-5'),
      model('gpt', 'oa', 'mock-small'),
      model('gpt-broken', 'ob', 'mock-small'),
      model('claude-codex', 'ap', 'claude-sonnet-4-5'),
      model('gemini-codex', 'gp', 'gemini-2.5-pro'),
      model('claude-cite', 'ac', 'claude-sonnet-4-5'),
      model('gemini-cite', 'gc', 'gemini-2.5-pro'),
      model('gpt-cite', 'oc', 'gpt-5-search-api'),
      model('claude-cached', 'an', 'claude-sonnet-4-5', { requestPolicy: { autoCache: true } }),
      model('gpt-policy', 'oa', 'mock-small', {
        requestPolicy: {
          overrides: { temperature: 0.2 },
          defaults: { max_tokens: 333 },
          unsupported: ['logit_bias'],
        },
      }),
    ],
    combos: [],
    aliases: [
      {
        organizationId: 'org',
        slug: 'claude-cached-alias',
        target: { kind: 'model', modelId: 'claude' },
        requestPolicy: { autoCache: true, autoCacheTtl: '1h' },
      },
    ],
    virtualKeys: [
      virtualKey('vk', KEY),
      virtualKey('vk-repair', REPAIR_KEY, { repair: ['json', 'tools'] }),
      // An organization with drop_params off (card 31.4).
      virtualKey('vk-strict', STRICT_KEY, { dropParams: false }),
    ],
    settings: { defaultRetry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 } },
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-shaping-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
  gw = buildGateway({
    logger: createLogger({
      service: 'test',
      level: 'info',
      destination: {
        write: (line: string) => {
          logLines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    }),
    keyring,
    pepper,
    dataDir,
    emitUsage: () => undefined,
    heartbeatMs: 50,
    internalToken: 'i'.repeat(32),
  });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const gaddr = gw.app.server.address();
  base = `http://127.0.0.1:${typeof gaddr === 'object' && gaddr ? gaddr.port : 0}`;
});

afterAll(async () => {
  await gw.app.close();
  await mock.close();
});

beforeEach(async () => {
  await fetch(`${mockUrl}/__mock/reset`, { method: 'POST' });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}, key = KEY) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });

const lastUpstream = async () =>
  (
    (await (await fetch(`${mockUrl}/__mock/stats`)).json()) as { last: Record<string, unknown>[] }
  ).last.at(-1) ?? {};

const metric = async (name: string, labels: string) => {
  const text = await (await fetch(`${base}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`${name}{${labels}}`));
  return line ? Number(line.split(' ').at(-1)) : 0;
};

describe('card 31.1: JSON and tool-call repair', () => {
  /** An OpenAI-format agent history: one call never answered, one result whose call is gone. */
  const brokenHistory = {
    messages: [
      { role: 'user', content: 'Fix the bug.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } },
          { id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"p":"b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'A' },
      { role: 'user', content: 'Continue.' },
      { role: 'tool', tool_call_id: 'call_trimmed', content: 'stale' },
    ],
  };

  it.each(['claude', 'gpt'])(
    'an unpaired tool history reaches %s without a 400 when repair is on',
    async (target) => {
      const plain = await post('/v1/chat/completions', { model: target, ...brokenHistory });
      expect(plain.status).toBe(400);

      const before = await metric('dirouter_gateway_repairs_total', 'action="tool_missing_result"');
      const viaKey = await post(
        '/v1/chat/completions',
        { model: target, ...brokenHistory },
        {},
        REPAIR_KEY,
      );
      expect(viaKey.status).toBe(200);
      const viaHeader = await post(
        '/v1/chat/completions',
        { model: target, ...brokenHistory },
        { 'x-dirouter-repair': 'tools' },
      );
      expect(viaHeader.status).toBe(200);
      expect(await metric('dirouter_gateway_repairs_total', 'action="tool_missing_result"')).toBe(
        before + 2,
      );
      // The header can also switch a key's repair off.
      const off = await post(
        '/v1/chat/completions',
        { model: target, ...brokenHistory },
        { 'x-dirouter-repair': 'off' },
        REPAIR_KEY,
      );
      expect(off.status).toBe(400);
    },
  );

  it('the repaired history sent to Claude pairs every tool_use with its tool_result', async () => {
    await post('/v1/chat/completions', { model: 'claude', ...brokenHistory }, {}, REPAIR_KEY);
    const sent = (await lastUpstream()) as { messages: { role: string; content: unknown[] }[] };
    expect(sent.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: [{ type: 'text', text: 'A' }] },
        {
          type: 'tool_result',
          tool_use_id: 'call_b',
          content: [{ type: 'text', text: expect.stringContaining('No result') as string }],
          is_error: true,
        },
        { type: 'text', text: 'Continue.' },
        { type: 'text', text: 'Result of tool call call_trimmed:\nstale' },
      ],
    });
  });

  const jsonRequest = {
    model: 'gpt-broken',
    messages: [{ role: 'user', content: 'weather as JSON' }],
    response_format: { type: 'json_object' },
  };
  const content = async (res: Response) =>
    ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message
      .content;

  it('repairs a broken JSON answer to a response_format request (non-stream only)', async () => {
    const before = await metric('dirouter_gateway_repairs_total', 'action="json"');
    const plain = await post('/v1/chat/completions', jsonRequest);
    expect(await content(plain)).toBe(BROKEN_JSON);

    const repaired = await post('/v1/chat/completions', jsonRequest, {}, REPAIR_KEY);
    expect(repaired.status).toBe(200);
    const text = await content(repaired);
    expect(JSON.parse(text ?? '')).toEqual({ city: 'Tehran', temp: 21 });
    expect(await metric('dirouter_gateway_repairs_total', 'action="json"')).toBe(before + 1);

    // Without response_format the text is the model's business and is left alone.
    const prose = await post(
      '/v1/chat/completions',
      { model: 'gpt-broken', messages: jsonRequest.messages },
      {},
      REPAIR_KEY,
    );
    expect(await content(prose)).toBe(BROKEN_JSON);

    // Streams are passed on as they come.
    const stream = await post(
      '/v1/chat/completions',
      { ...jsonRequest, stream: true },
      {},
      REPAIR_KEY,
    );
    expect(await stream.text()).toContain('```json');
  });
});

describe('card 31.3: automatic prompt-cache breakpoints', () => {
  const system = 'You are a meticulous assistant. '.repeat(40);
  const turn1 = [
    { role: 'system', content: system },
    { role: 'user', content: 'What is 2+2?' },
  ];
  const turn2 = [
    ...turn1,
    { role: 'assistant', content: '4' },
    { role: 'user', content: 'And 3+3?' },
  ];
  const cached = async (model: string, messages: unknown[]) => {
    const res = await post('/v1/chat/completions', { model, messages });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usage: { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number } };
    };
    return body.usage.prompt_tokens_details.cached_tokens;
  };

  it.each(['claude-cached', 'claude-cached-alias'])(
    'an OpenAI-format request to Claude (%s) reports a non-zero cache read on the second turn',
    async (model) => {
      expect(await cached(model, turn1)).toBe(0);
      const sent = (await lastUpstream()) as { system: unknown[] };
      expect(sent.system).toEqual([
        {
          type: 'text',
          text: system,
          cache_control:
            model === 'claude-cached' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl: '1h' },
        },
      ]);
      expect(await cached(model, turn2)).toBeGreaterThan(0);
    },
  );

  it('without the policy nothing is marked and nothing is read from the cache', async () => {
    expect(await cached('claude', turn1)).toBe(0);
    expect(await cached('claude', turn2)).toBe(0);
    expect((await lastUpstream()).system).toBe(system);
  });

  it('a request with its own cache_control reaches the provider unchanged', async () => {
    const body = {
      model: 'claude-cached',
      max_tokens: 100,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] }],
    };
    const res = await post('/v1/messages', body);
    expect(res.status).toBe(200);
    const sent = await lastUpstream();
    expect(sent.system).toEqual(body.system);
    expect(sent.messages).toEqual(body.messages);
    expect(sent.tools).toBeUndefined();
  });

  it('an OpenAI provider gets no markers, whatever the policy', async () => {
    const { shapeForCandidate } = await import('./shaping.js');
    const request = {
      inboundApi: 'openai.chat' as const,
      model: 'm',
      system: [{ type: 'text' as const, text: 's' }],
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      stream: false,
    };
    const shaped = shapeForCandidate(
      request,
      {
        model: { requestPolicy: { autoCache: true } } as never,
        provider: { type: 'openai' } as never,
      },
      undefined,
      { logger: createLogger({ service: 'test', level: 'silent' }) },
      'r',
    );
    expect(shaped.request).toBe(request);
  });
});

describe('card 31.4: parameter policy and drop_params', () => {
  const ask = { messages: [{ role: 'user', content: 'hi' }] };

  it("forces the model's value on the request, fills a default, and logs both", async () => {
    const res = await post('/v1/chat/completions', {
      model: 'gpt-policy',
      temperature: 0.9,
      ...ask,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-params')).toBe('temperature=override, max_tokens=default');
    const sent = await lastUpstream();
    expect(sent.temperature).toBe(0.2);
    expect(sent.max_tokens).toBe(333);
    const requestId = res.headers.get('x-request-id');
    const line = logLines.find(
      (l) => l.msg === 'request parameters set by the model policy' && l.requestId === requestId,
    );
    expect(line).toMatchObject({
      model: 'gpt-policy',
      params: { overrides: ['temperature'], defaults: ['max_tokens'], dropped: [] },
    });
    // A request that sets max_tokens itself keeps it; the override still wins.
    await post('/v1/chat/completions', { model: 'gpt-policy', max_tokens: 50, ...ask });
    expect(await lastUpstream()).toMatchObject({ temperature: 0.2, max_tokens: 50 });
  });

  it('an unsupported parameter is dropped by default and a clear 400 with drop_params off', async () => {
    const body = { model: 'gpt-policy', logit_bias: { 42: 5 }, ...ask };
    const lenient = await post('/v1/chat/completions', body);
    expect(lenient.status).toBe(200);
    expect(lenient.headers.get('x-dirouter-params')).toContain('logit_bias=dropped');
    expect((await lastUpstream()).logit_bias).toBeUndefined();

    const strict = await post('/v1/chat/completions', body, {}, STRICT_KEY);
    expect(strict.status).toBe(400);
    const error = ((await strict.json()) as { error: { message: string; type: string } }).error;
    expect(error.message).toBe(
      "Unsupported parameter for model 'gpt-policy': 'logit_bias'. Remove it, or set drop_params to true to have unsupported parameters dropped.",
    );
  });

  it('drop_params also covers what the target API cannot carry (seed to Claude)', async () => {
    const body = { model: 'claude', seed: 7, ...ask };
    expect((await post('/v1/chat/completions', body)).status).toBe(200);
    const strict = await post('/v1/chat/completions', body, {}, STRICT_KEY);
    expect(strict.status).toBe(400);
    expect(await strict.text()).toContain("Unsupported parameter for model 'claude': 'seed'");
    // The request can override the organization: header, or drop_params in the body.
    const header = await post(
      '/v1/chat/completions',
      body,
      { 'x-dirouter-drop-params': 'true' },
      STRICT_KEY,
    );
    expect(header.status).toBe(200);
    const inBody = await post(
      '/v1/chat/completions',
      { ...body, drop_params: true },
      {},
      STRICT_KEY,
    );
    expect(inBody.status).toBe(200);
    expect(await lastUpstream()).not.toHaveProperty('drop_params');
    const refused = await post('/v1/chat/completions', { ...body, drop_params: false });
    expect(refused.status).toBe(400);
    // An Anthropic client is answered in its own error format.
    const anthropic = await post(
      '/v1/messages',
      { model: 'gpt', max_tokens: 10, top_k: 3, messages: [{ role: 'user', content: 'hi' }] },
      {},
      STRICT_KEY,
    );
    expect(anthropic.status).toBe(400);
    expect(await anthropic.json()).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining("'top_k'") as string },
    });
  });
});

describe('card 31.2: Codex apply_patch with non-GPT models', () => {
  /** The update hunks of a V4A patch applied to a file, as Codex does it. */
  async function applyPatch(dir: string, patch: string) {
    const file = /\*\*\* Update File: (.+)/.exec(patch)?.[1] ?? '';
    const removed = patch
      .split('\n')
      .filter((l) => l.startsWith('-'))
      .map((l) => l.slice(1));
    const added = patch
      .split('\n')
      .filter((l) => l.startsWith('+'))
      .map((l) => l.slice(1));
    const path = join(dir, file);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace(removed.join('\n'), added.join('\n')));
  }
  const codex = (model: string, input: unknown[], stream = false) => ({
    model,
    instructions: 'You are Codex.',
    input,
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Use the `apply_patch` tool to edit files.',
        format: {
          type: 'grammar',
          syntax: 'lark',
          definition: 'start: begin_patch hunk+ end_patch',
        },
      },
    ],
    stream,
  });
  const ask = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello' }] },
  ];

  it.each(['claude-codex', 'gemini-codex'])(
    '%s answers with a custom_tool_call whose patch edits the file, then gets the result',
    async (model) => {
      const res = await post('/v1/responses', codex(model, ask));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { output: Record<string, unknown>[] };
      const call = body.output.find((o) => o.type === 'custom_tool_call');
      expect(call).toMatchObject({ name: 'apply_patch', input: PATCH, status: 'completed' });

      const dir = await mkdtemp(join(tmpdir(), 'dirouter-codex-'));
      await writeFile(join(dir, 'app.ts'), "const greeting = 'hi';\n");
      await applyPatch(dir, String(call?.input));
      expect(await readFile(join(dir, 'app.ts'), 'utf8')).toBe("const greeting = 'hello';\n");

      // Next turn: Codex replays the call and its output; the provider gets a paired history.
      const next = await post(
        '/v1/responses',
        codex(model, [
          ...ask,
          call,
          { type: 'custom_tool_call_output', call_id: call?.call_id, output: 'Success. M app.ts' },
        ]),
      );
      expect(next.status).toBe(200);
      const sent = await lastUpstream();
      expect(JSON.stringify(sent)).toContain('Success. M app.ts');
    },
  );

  it('streams the call as custom_tool_call_input events and a finished item', async () => {
    const res = await post('/v1/responses', codex('claude-codex', ask, true));
    const parser = new SseParser();
    const events = [...parser.feed(await res.text()), ...parser.flush()].map(
      (e) => JSON.parse(e.data) as Record<string, unknown>,
    );
    expect(events.find((e) => e.type === 'response.custom_tool_call_input.done')).toMatchObject({
      input: PATCH,
    });
    const done = events.find(
      (e) =>
        e.type === 'response.output_item.done' &&
        (e.item as { type?: string }).type === 'custom_tool_call',
    );
    expect(done?.item).toMatchObject({ name: 'apply_patch', input: PATCH });
  });
});

describe('card 31.7: citations through the gateway', () => {
  const SOURCE = 'https://example.org/mock-source';
  const ask = [{ role: 'user', content: 'Weather?' }];

  it('an OpenAI client gets url_citation annotations from Claude and Gemini', async () => {
    for (const model of ['claude-cite', 'gemini-cite']) {
      const res = await post('/v1/chat/completions', { model, messages: ask });
      const body = (await res.json()) as {
        choices: {
          message: { content: string; annotations?: { url_citation: Record<string, unknown> }[] };
        }[];
      };
      const message = body.choices[0]?.message;
      expect(message?.annotations?.[0]?.url_citation).toMatchObject({
        url: SOURCE,
        start_index: 0,
        end_index: message?.content.length,
      });
    }
  });

  it('an Anthropic client gets citations from an OpenAI search model and Gemini', async () => {
    for (const model of ['gpt-cite', 'gemini-cite']) {
      const res = await post('/v1/messages', { model, max_tokens: 50, messages: ask });
      const body = (await res.json()) as { content: { citations?: Record<string, unknown>[] }[] };
      expect(body.content[0]?.citations?.[0]).toMatchObject({
        type: 'web_search_result_location',
        url: SOURCE,
      });
    }
  });

  it('a Responses client gets annotations, streamed too', async () => {
    const json = (await (
      await post('/v1/responses', { model: 'claude-cite', input: 'Weather?' })
    ).json()) as { output: { content: { annotations: Record<string, unknown>[] }[] }[] };
    expect(json.output[0]?.content[0]?.annotations[0]).toMatchObject({
      type: 'url_citation',
      url: SOURCE,
    });
    const stream = await post('/v1/responses', {
      model: 'claude-cite',
      input: 'Weather?',
      stream: true,
    });
    expect(await stream.text()).toContain('response.output_text.annotation.added');
  });
});
