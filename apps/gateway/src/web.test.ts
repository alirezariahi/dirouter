/** Web search and web fetch as a service, online mode and the web_search server tool (card 30.8). */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';
import { configureUpstreamGuard } from './upstream.js';
import { checkUrl, fetchPage, htmlToText } from './web/fetch.js';
import { anthropicEvents, lastUserText, openAiChunks } from './web/service.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-web-key-0000001';
const KEY_RPM = 'dr-web-rpm-0000001';

describe('web helpers', () => {
  it('turns HTML into readable text without scripts and styles', () => {
    const page = htmlToText(
      '<html><head><title>T &amp; U</title><script>evil()</script><style>x{}</style></head>' +
        '<body><h1>Head</h1><p>One &lt;two&gt; &#x41;&#66;</p><!-- hidden --><p>Three</p></body></html>',
    );
    expect(page.title).toBe('T & U');
    expect(page.text).toBe('Head\nOne <two> AB\nThree');
    expect(page.text).not.toContain('evil');
  });

  it('accepts only absolute http(s) URLs without credentials', () => {
    expect(checkUrl('https://example.com/a').hostname).toBe('example.com');
    for (const bad of [
      'file:///etc/passwd',
      'ftp://x/y',
      'gopher://x',
      '/relative',
      'http://u:p@x/',
    ])
      expect(() => checkUrl(bad)).toThrow();
  });

  it('reads the query from the last user message, in any content shape', () => {
    expect(
      lastUserText([
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: [{ type: 'text', text: 'new' }, { type: 'image_url' }] },
      ]),
    ).toBe('new');
    expect(lastUserText([{ role: 'system', content: 'x' }])).toBe('');
  });

  it('replays answers as OpenAI and Anthropic streams', () => {
    const chunks = openAiChunks(
      {
        id: 'c',
        created: 1,
        model: 'm',
        choices: [
          {
            index: 0,
            message: { content: 'hi', annotations: [{ type: 'url_citation' }] },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      true,
    ).join('');
    expect(chunks).toContain('"annotations"');
    expect(chunks).toContain('"usage"');
    expect(chunks.endsWith('data: [DONE]\n\n')).toBe(true);
    const events = anthropicEvents({
      id: 'msg',
      content: [
        { type: 'server_tool_use', id: 's', name: 'web_search', input: { query: 'q' } },
        { type: 'web_search_tool_result', tool_use_id: 's', content: [] },
        { type: 'text', text: 'answer' },
      ],
      usage: { input_tokens: 3, output_tokens: 2, server_tool_use: { web_search_requests: 1 } },
    }).join('');
    expect(events).toContain('event: message_start');
    expect(events).toContain('"partial_json":"{\\"query\\":\\"q\\"}"');
    expect(events).toContain('"web_search_requests":1');
    expect(events).toContain('event: message_stop');
  });
});

describe('web fetch SSRF guard', () => {
  afterAll(() => {
    configureUpstreamGuard({ enabled: false, platformOrganizationId: () => undefined });
  });

  it('refuses private, loopback and link-local addresses when the guard is on, for every organization', async () => {
    configureUpstreamGuard({ enabled: true, platformOrganizationId: () => 'platform' });
    for (const url of [
      'http://127.0.0.1:8080/',
      'http://localhost/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
    ])
      await expect(fetchPage(url, { maxBytes: 1_024, timeoutMs: 2_000 })).rejects.toMatchObject({
        status: 403,
      });
  });
});

describe('web search and fetch through the gateway', () => {
  const mock = buildMock();
  const usage: UsageEvent[] = [];
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  let root = '';

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    root = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const keyring = parseKeyring(generateKey());
    const caps = {
      streaming: true,
      tools: true,
      vision: false,
      reasoning: false,
      jsonMode: false,
      embeddings: false,
    };
    const key = (raw: string, id: string, extra = {}) => ({
      id,
      hash: hashApiKey(raw, pepper),
      prefix: id,
      organizationId: 'org',
      teamId: null,
      projectId: 'prj',
      enabled: true,
      expiresAt: null,
      allowedModels: [],
      ...extra,
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        {
          id: 'p-openai',
          organizationId: 'org',
          slug: 'openai',
          type: 'openai',
          name: 'OpenAI',
          baseUrl: `${root}/v1`,
          enabled: true,
          options: {},
          credentials: [
            {
              id: 'c-openai',
              name: 'k',
              secret: encrypt(keyring, 'sk-mock', 'c-openai'),
              enabled: true,
            },
          ],
        },
        {
          id: 'p-anthropic',
          organizationId: 'org',
          slug: 'anthropic',
          type: 'anthropic',
          name: 'Anthropic',
          baseUrl: root,
          enabled: true,
          options: {},
          credentials: [
            {
              id: 'c-anth',
              name: 'k',
              secret: encrypt(keyring, 'sk-ant', 'c-anth'),
              enabled: true,
            },
          ],
        },
      ],
      models: [
        {
          id: 'm-chat',
          organizationId: 'org',
          slug: 'chat',
          providerId: 'p-openai',
          upstreamModel: 'mock-small',
          enabled: true,
          pricing: { inputPerMTok: '1', outputPerMTok: '1' },
          capabilities: caps,
        },
        {
          id: 'm-claude',
          organizationId: 'org',
          slug: 'claude',
          providerId: 'p-anthropic',
          upstreamModel: 'mock-claude',
          enabled: true,
          pricing: { inputPerMTok: '1', outputPerMTok: '1' },
          capabilities: caps,
        },
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        key(KEY, 'vk'),
        key(KEY_RPM, 'vk-rpm', { rateLimit: { requestsPerMinute: 1 } }),
      ],
      settings: { webSearch: { order: ['searxng', 'brave', 'tavily'], fetchTimeoutMs: 1_000 } },
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-web-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: (e) => usage.push(e),
      webSearch: {
        searxngUrl: `${root}/web/searxng`,
        braveApiKey: 'brave-test-token',
        braveUrl: `${root}/web/brave`,
        tavilyApiKey: 'tavily-test-token',
        tavilyUrl: `${root}/web/tavily`,
      },
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  });
  afterAll(async () => {
    await gw.app.close();
    await mock.close();
  });
  beforeEach(async () => {
    usage.length = 0;
    await fetch(`${root}/__mock/web`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fail: [] }),
    });
    await fetch(`${root}/__mock/reset`, { method: 'POST' });
  });

  const post = (path: string, body: unknown, key = KEY) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const failBackends = (fail: string[]) =>
    fetch(`${root}/__mock/web`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fail }),
    });
  const waitEvents = async (n: number) => {
    for (let i = 0; i < 100 && usage.length < n; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return usage;
  };

  it('/v1/search answers from the first backend, prices it and caches it', async () => {
    expect((await fetch(`${base}/v1/search`, { method: 'POST' })).status).toBe(401);
    const res = await post('/v1/search', { query: 'dirouter gateway', max_results: 2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backend: string;
      cached: boolean;
      results: { url: string; title: string }[];
      usage: { searches: number; cost_usd: string };
    };
    expect(body).toMatchObject({ backend: 'searxng', cached: false, usage: { searches: 1 } });
    expect(body.results).toHaveLength(2);
    expect(body.results[0]?.url).toContain('/web/page/1');
    const [event] = await waitEvents(1);
    expect(event).toMatchObject({
      inboundApi: 'web.search',
      requestedModel: 'web_search:searxng',
      status: 'success',
      costUsd: '0.00500000',
      chargeUsd: '0.00500000',
      virtualKeyId: 'vk',
    });
    const again = (await (
      await post('/v1/search', { query: 'dirouter  gateway', max_results: 2 })
    ).json()) as {
      cached: boolean;
      usage: { cost_usd: string };
    };
    expect(again).toMatchObject({ cached: true, usage: { cost_usd: '0.00000000' } });
    expect((await post('/v1/search', { query: '' })).status).toBe(400);
  });

  it('falls back to the next backend, and answers 503 when every backend fails', async () => {
    await failBackends(['searxng']);
    const brave = (await (await post('/v1/search', { query: 'fallback one' })).json()) as {
      backend: string;
    };
    expect(brave.backend).toBe('brave');
    await failBackends(['searxng', 'brave']);
    const tavily = (await (await post('/v1/search', { query: 'fallback two' })).json()) as {
      backend: string;
    };
    expect(tavily.backend).toBe('tavily');
    await failBackends(['searxng', 'brave', 'tavily']);
    const none = await post('/v1/search', { query: 'fallback three' });
    expect(none.status).toBe(503);
    const events = await waitEvents(3);
    expect(events.at(-1)).toMatchObject({ status: 'error', costUsd: '0.00000000' });
  });

  it('keeps the key rate limit for searches', async () => {
    expect((await post('/v1/search', { query: 'limited a' }, KEY_RPM)).status).toBe(200);
    expect((await post('/v1/search', { query: 'limited b' }, KEY_RPM)).status).toBe(429);
  });

  it('/v1/fetch returns readable text, follows redirects and is size and type bounded', async () => {
    const res = await post('/v1/fetch', { url: `${root}/web/redirect?to=/web/page/2` });
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      url: string;
      title: string;
      content: string;
      truncated: boolean;
      usage: { cost_usd: string };
    };
    expect(page.url).toBe(`${root}/web/page/2`);
    expect(page.title).toBe('Mock page 2');
    expect(page.content).toContain('Facts & figures');
    expect(page.content).not.toContain('never shown');
    expect(page.truncated).toBe(false);
    expect(page.usage.cost_usd).toBe('0.00100000');
    const big = (await (
      await post('/v1/fetch', { url: `${root}/web/big`, max_bytes: 2_048 })
    ).json()) as {
      bytes: number;
      truncated: boolean;
    };
    expect(big).toMatchObject({ bytes: 2_048, truncated: true });
    expect((await post('/v1/fetch', { url: `${root}/web/binary` })).status).toBe(415);
    expect((await post('/v1/fetch', { url: 'file:///etc/passwd' })).status).toBe(400);
    const slow = await post('/v1/fetch', { url: `${root}/web/slow` });
    expect(slow.status).toBe(504);
    const events = await waitEvents(5);
    expect(events[0]).toMatchObject({ inboundApi: 'web.fetch', costUsd: '0.00100000' });
  });

  it('online mode: a model without native search answers with sources, search billed separately', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'chat',
      messages: [{ role: 'user', content: 'What is new in DiRouter?' }],
      plugins: [{ id: 'web', max_results: 2 }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-web-search')).toBe('searxng');
    const body = (await res.json()) as {
      choices: { message: { content: string; annotations: { url_citation: { url: string } }[] } }[];
    };
    const annotations = body.choices[0]?.message.annotations ?? [];
    expect(annotations).toHaveLength(2);
    expect(annotations[0]?.url_citation.url).toContain('/web/page/1');
    // The model saw the results.
    const stats = (await (await fetch(`${root}/__mock/stats`)).json()) as {
      last: { messages: { role: string; content: string }[]; plugins?: unknown }[];
    };
    const sent = stats.last.at(-1);
    expect(sent?.messages[0]?.content).toContain(
      'Web search results for "What is new in DiRouter?"',
    );
    expect(sent?.plugins).toBeUndefined();
    const events = await waitEvents(2);
    const search = events.find((e) => e.inboundApi === 'web.search');
    const chat = events.find((e) => e.inboundApi === 'openai.chat');
    expect(search).toMatchObject({ costUsd: '0.00500000', virtualKeyId: 'vk' });
    expect(search?.requestId).toMatch(/:web_search:1$/);
    expect(chat?.resolvedModelId).toBe('m-chat');
    expect(chat?.requestId).toBe(res.headers.get('x-request-id'));
  });

  it('the :online model suffix (card 31.5) searches with the built-in web search', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'chat:online',
      messages: [{ role: 'user', content: 'Latest gateway news?' }],
    });
    expect(res.status).toBe(200);
    const stats = (await (await fetch(`${root}/__mock/stats`)).json()) as {
      last: { messages: { role: string; content: string }[] }[];
    };
    expect(stats.last.at(-1)?.messages[0]?.content).toContain(
      'Web search results for "Latest gateway news?"',
    );
    const events = await waitEvents(2);
    const search = events.find((e) => e.inboundApi === 'web.search');
    expect(search).toMatchObject({ costUsd: '0.00500000', virtualKeyId: 'vk' });
    expect(search?.requestId).toMatch(/:web_search:1$/);
  });

  it('online mode streams the answer with its annotations (web_search_options)', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'chat',
      stream: true,
      stream_options: { include_usage: true },
      web_search_options: { search_context_size: 'low' },
      messages: [{ role: 'user', content: 'stream me sources' }],
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('url_citation');
    expect(text).toContain('"usage"');
    expect(text).toContain('data: [DONE]');
  });

  it('runs the Anthropic web_search server tool for a non-Anthropic model (Claude Code)', async () => {
    const request = {
      model: 'chat',
      max_tokens: 512,
      system: 'You are an assistant for performing a web search tool use',
      messages: [{ role: 'user', content: 'Perform a web search for the query: dirouter release' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    };
    const res = await post('/v1/messages', request);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: {
        type: string;
        input?: { query: string };
        content?: { type: string; url: string }[];
        text?: string;
      }[];
      usage: { server_tool_use?: { web_search_requests: number } };
    };
    expect(body.content.map((b) => b.type)).toEqual([
      'server_tool_use',
      'web_search_tool_result',
      'text',
    ]);
    expect(body.content[0]?.input?.query).toBe(
      'Perform a web search for the query: dirouter release',
    );
    expect(body.content[1]?.content?.[0]).toMatchObject({ type: 'web_search_result' });
    // The model received the results and cites one of them.
    expect(body.content[2]?.text).toContain('/web/page/1');
    expect(body.usage.server_tool_use?.web_search_requests).toBe(1);
    const events = await waitEvents(3);
    expect(events.filter((e) => e.inboundApi === 'web.search')).toHaveLength(1);
    expect(
      new Set(events.filter((e) => e.inboundApi === 'anthropic.messages').map((e) => e.requestId))
        .size,
    ).toBe(2);

    const streamed = await post('/v1/messages', { ...request, stream: true });
    const sse = await streamed.text();
    expect(sse).toContain('"type":"web_search_tool_result"');
    expect(sse).toContain('event: message_stop');
  });

  it('keeps the native server tool when the model is served by Anthropic', async () => {
    const res = await post('/v1/messages', {
      model: 'claude',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    });
    expect(res.status).toBe(200);
    const stats = (await (await fetch(`${root}/__mock/stats`)).json()) as {
      last: { tools?: { type?: string }[] }[];
    };
    expect(stats.last.at(-1)?.tools?.[0]?.type).toBe('web_search_20250305');
    expect((await waitEvents(1)).some((e) => e.inboundApi === 'web.search')).toBe(false);
  });
});
