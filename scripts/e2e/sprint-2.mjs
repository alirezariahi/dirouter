/* eslint-disable no-console */
/**
 * Sprint 2 end-to-end checks against the development stack (make up && make seed).
 * Every scenario goes through Traefik exactly like a client would and names the board card it
 * verifies. Settings and entities created here are removed at the end.
 *
 *   node scripts/e2e/sprint-2.mjs            # everything
 *   node scripts/e2e/sprint-2.mjs 11.2 13.1  # only scenarios whose name contains one of these
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = { ...process.env, GRAFANA_ADMIN_PASSWORD: 'e2e-not-used' };
const compose = ['compose', '-f', 'compose.yaml', '-f', 'compose.dev.yaml'];
const gateway = process.env.E2E_GATEWAY_URL ?? 'http://api.localhost';
const admin = process.env.E2E_ADMIN_URL ?? 'http://admin.localhost';
const mock = process.env.E2E_MOCK_URL ?? 'http://mock.localhost';
const ORG = 'org_dev';
const only = process.argv.slice(2);
const results = [];
const cleanups = [];
let token;
let owner;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function sql(query) {
  const { stdout } = await exec(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'dirouter',
      '-d',
      'dirouter',
      '-Atc',
      query,
    ],
    { cwd: root, env, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}
async function request(url, options = {}, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), ...options });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (expected !== undefined && expected !== null)
    assert.equal(
      response.status,
      expected,
      `${options.method ?? 'GET'} ${url}: ${text.slice(0, 600)}`,
    );
  return { response, body, text };
}
async function waitFor(description, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}: ${String(last)}`);
}
async function api(method, path, body, expected, bearer = token) {
  if (expected === undefined) expected = 200;
  return request(
    `${admin}/api/v1/${path}`,
    {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    expected,
  );
}
const org = (method, path, body, expected, bearer) =>
  api(method, `orgs/${ORG}/${path}`, body, expected, bearer);

const configVersion = async () => (await request(`${gateway}/readyz`, {}, 200)).body.configVersion;
/** Runs a control-plane change and waits until the gateway has loaded the resulting snapshot. */
async function published(change) {
  const before = await configVersion();
  const result = await change();
  await waitFor('gateway to load the new snapshot', async () => (await configVersion()) > before);
  return result;
}
async function putSettings(patch) {
  const current = (await org('GET', 'config/settings')).body.stored ?? {};
  return published(() => org('PUT', 'config/settings', { ...current, ...patch }));
}
async function createKey(name, extra = {}) {
  const { body } = await published(() =>
    org(
      'POST',
      'keys',
      { name: `s2-e2e-${name}-${randomUUID().slice(0, 8)}`, projectId: 'prj_dev', ...extra },
      201,
    ),
  );
  assert.ok(body.key && body.id);
  // Another change may have bumped the version first: wait until this very key is accepted.
  await waitFor(`gateway to know key ${body.id}`, async () => {
    const probe = await fetch(`${gateway}/v1/models`, {
      headers: { authorization: `Bearer ${body.key}` },
    });
    return probe.status === 200;
  });
  cleanups.push(() => org('POST', `keys/${body.id}/revoke`, undefined, null));
  return body;
}
function chat(key, body, headers = {}) {
  return request(`${gateway}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });
}
const sseEvents = (text) =>
  text
    .split(/\n\n+/)
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) return undefined;
      try {
        return { event, data: JSON.parse(data) };
      } catch {
        return { event, data };
      }
    })
    .filter(Boolean);
const mockStats = async () => (await request(`${mock}/__mock/stats`, {}, 200)).body;
const mockReset = () => request(`${mock}/__mock/reset`, { method: 'POST' }, 200);
/** The request-log row of a request, once the worker has written it. */
const logRow = (requestId, columns = 'status') =>
  waitFor(`request_log row for ${requestId}`, async () => {
    const row = await sql(`SELECT ${columns} FROM request_log WHERE id = '${requestId}' LIMIT 1`);
    return row === '' ? undefined : row;
  });

async function scenario(name, run) {
  if (only.length > 0 && !only.some((part) => name.includes(part))) return;
  const started = Date.now();
  try {
    await run();
    results.push({ name, status: 'passed', durationMs: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', durationMs: Date.now() - started });
    console.log(
      `FAIL ${name}\n     ${String(error?.stack ?? error)
        .split('\n')
        .slice(0, 6)
        .join('\n     ')}`,
    );
  }
}

let failed = false;
try {
  assert.equal((await request(`${gateway}/readyz`, {}, 200)).body.controlApiSync, true);
  assert.equal(
    await sql("SELECT count(*) FROM providers WHERE id = 'prv_mock' AND deleted_at IS NULL"),
    '1',
    'Run the development seed before e2e (make seed)',
  );
  const readEnv = async (file) =>
    Object.fromEntries(
      (await readFile(resolve(root, file), 'utf8'))
        .trim()
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  const seedAdmin = await readEnv('.data/seed-admin.env');
  const login = await api('POST', 'auth/login', {
    email: seedAdmin.SEED_ADMIN_EMAIL,
    password: seedAdmin.SEED_ADMIN_PASSWORD,
  });
  token = login.body.accessToken;
  owner = (await api('GET', 'auth/me')).body;
  const originalSettings = (await org('GET', 'config/settings')).body.stored ?? {};
  cleanups.push(() => org('PUT', 'config/settings', originalSettings, null));
  const main = await createKey('main');
  const models = (await org('GET', 'models')).body;
  const modelId = (slug) => {
    const found = (models.items ?? models).find((m) => m.slug === slug);
    assert.ok(found, `seeded model ${slug}`);
    return found.id;
  };

  // ───────────── Epic 11: inbound APIs ─────────────

  await scenario(
    '11.1 Gemini generateContent, SSE stream with a complete tool call, countTokens',
    async () => {
      const body = { contents: [{ role: 'user', parts: [{ text: 'hello gemini client' }] }] };
      const plain = await request(
        `${gateway}/v1beta/models/${encodeURIComponent('mock/small')}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': main.key },
          body: JSON.stringify(body),
        },
        200,
      );
      assert.match(plain.body.candidates[0].content.parts[0].text, /Hello from/);
      assert.ok(plain.body.usageMetadata.totalTokenCount > 0);
      // Google SDKs may send the key as a query parameter instead of a header.
      await request(
        `${gateway}/v1beta/models/${encodeURIComponent('mock/small')}:generateContent?key=${main.key}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        200,
      );
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Weather for a city',
              parametersJsonSchema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          ],
        },
      ];
      const stream = await request(
        `${gateway}/v1beta/models/${encodeURIComponent('mock/tool')}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': main.key },
          body: JSON.stringify({ ...body, tools }),
        },
        200,
      );
      assert.match(stream.response.headers.get('content-type'), /text\/event-stream/);
      const calls = sseEvents(stream.text)
        .flatMap((frame) => frame.data.candidates?.[0]?.content?.parts ?? [])
        .filter((part) => part.functionCall);
      assert.equal(calls.length, 1, stream.text.slice(0, 800));
      assert.equal(calls[0].functionCall.name, 'get_weather');
      assert.ok(
        Object.keys(calls[0].functionCall.args).length > 0,
        'tool call arguments arrive complete',
      );
      // The mock saw the declaration with its JSON schema.
      const seen = (await mockStats()).last.at(-1);
      assert.equal(seen.tools[0].function.parameters.required[0], 'city');

      // A second turn with the function response (ids are generated, the result must reach upstream).
      const second = await request(
        `${gateway}/v1beta/models/${encodeURIComponent('mock/small')}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': main.key },
          body: JSON.stringify({
            tools,
            contents: [
              { role: 'user', parts: [{ text: 'weather in Tehran?' }] },
              { role: 'model', parts: [{ functionCall: calls[0].functionCall }] },
              {
                role: 'user',
                parts: [
                  { functionResponse: { name: 'get_weather', response: { temperature: 21 } } },
                ],
              },
            ],
          }),
        },
        200,
      );
      assert.ok(second.body.candidates.length > 0);
      const upstream = (await mockStats()).last.at(-1).messages;
      const toolMessage = upstream.find((m) => m.role === 'tool');
      assert.ok(toolMessage, 'function response becomes a tool message upstream');
      const assistant = upstream.find((m) => m.role === 'assistant');
      assert.equal(assistant.tool_calls[0].id, toolMessage.tool_call_id);

      const count = await request(
        `${gateway}/v1beta/models/${encodeURIComponent('mock/small')}:countTokens`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': main.key },
          body: JSON.stringify(body),
        },
        200,
      );
      assert.ok(count.body.totalTokens > 0);
      const list = await request(`${gateway}/v1beta/models?key=${main.key}`, {}, 200);
      assert.ok(list.body.models.some((m) => m.name === 'models/mock/small'));
      await request(
        `${gateway}/v1beta/models/${encodeURIComponent('mock/small')}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        401,
      );
    },
  );

  await scenario(
    '11.2 Responses API: Codex-shaped request, typed stream, tool call, previous_response_id',
    async () => {
      const responses = (body, key = main.key) =>
        request(`${gateway}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        });
      // The shape Codex CLI sends: instructions, message items, flat function tools, extra tool
      // types, reasoning options and store:false.
      const codexBody = (model, extra = {}) => ({
        model,
        instructions: 'You are a coding agent.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'list the files' }],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'shell',
            description: 'Run a shell command',
            strict: false,
            parameters: {
              type: 'object',
              properties: { command: { type: 'array', items: { type: 'string' } } },
              required: ['command'],
            },
          },
          { type: 'web_search' },
        ],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: { effort: 'medium', summary: 'auto' },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: randomUUID(),
        ...extra,
      });
      for (const model of ['mock/small', 'mock/claude']) {
        const res = await responses(codexBody(model));
        assert.equal(res.response.status, 200, res.text.slice(0, 500));
        const events = sseEvents(res.text);
        const types = events.map((e) => e.data.type);
        assert.equal(types[0], 'response.created');
        assert.equal(types.at(-1), 'response.completed', types.join(','));
        for (const needed of [
          'response.output_item.added',
          'response.content_part.added',
          'response.output_text.delta',
          'response.output_text.done',
          'response.output_item.done',
        ])
          assert.ok(types.includes(needed), `${model}: missing ${needed}`);
        const sequence = events.map((e) => e.data.sequence_number);
        assert.deepEqual(
          sequence,
          [...sequence].sort((a, b) => a - b),
        );
        const completed = events.at(-1).data.response;
        const text = events
          .filter((e) => e.data.type === 'response.output_text.delta')
          .map((e) => e.data.delta)
          .join('');
        const message = completed.output.find((item) => item.type === 'message');
        assert.equal(message.content[0].text, text);
        assert.ok(completed.usage.total_tokens > 0);
      }
      assert.equal(
        (await mockStats()).byKey['sk-ant-mock'] !== undefined ||
          Object.keys((await mockStats()).byKey).some((k) => !k.startsWith('Bearer')),
        true,
        'the Anthropic-format mock model was called through its native API',
      );

      // Tool call: function_call item with arguments, both in the stream and in the final output.
      const tool = await responses(codexBody('mock/tool'));
      const toolEvents = sseEvents(tool.text);
      const done = toolEvents.find(
        (e) => e.data.type === 'response.output_item.done' && e.data.item.type === 'function_call',
      );
      assert.ok(done, toolEvents.map((e) => e.data.type).join(','));
      assert.ok(done.data.item.call_id && done.data.item.name);
      JSON.parse(done.data.item.arguments);
      assert.ok(toolEvents.some((e) => e.data.type === 'response.function_call_arguments.done'));

      // Second turn the way Codex replays history: assistant output_text, the call and its output.
      const replay = await responses({
        model: 'mock/small',
        stream: false,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'list the files' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Running ls.' }],
          },
          {
            type: 'function_call',
            call_id: done.data.item.call_id,
            name: done.data.item.name,
            arguments: done.data.item.arguments,
          },
          { type: 'function_call_output', call_id: done.data.item.call_id, output: 'README.md' },
        ],
      });
      assert.equal(replay.response.status, 200, replay.text.slice(0, 500));
      const replayed = (await mockStats()).last.at(-1).messages;
      assert.equal(replayed.find((m) => m.role === 'tool').content, 'README.md');

      // previous_response_id: streamed and non-streamed turns can both be continued, and only
      // inside the project that produced them.
      const first = await responses({ model: 'mock/small', input: 'remember the word pineapple' });
      assert.equal(first.response.status, 200);
      assert.match(first.body.id, /^resp_/);
      await sleep(200);
      const next = await responses({
        model: 'mock/small',
        input: 'which word?',
        previous_response_id: first.body.id,
      });
      assert.equal(next.response.status, 200, next.text);
      const continued = (await mockStats()).last.at(-1).messages;
      assert.ok(
        JSON.stringify(continued).includes('pineapple') && continued.length >= 3,
        'previous turn is replayed upstream',
      );
      const streamed = await responses({
        model: 'mock/small',
        input: 'streamed turn',
        stream: true,
      });
      const streamedId = sseEvents(streamed.text).at(-1).data.response.id;
      await sleep(200);
      assert.equal(
        (await responses({ model: 'mock/small', input: 'again', previous_response_id: streamedId }))
          .response.status,
        200,
      );
      assert.equal(
        (await responses({ model: 'mock/small', input: 'x', previous_response_id: 'resp_missing' }))
          .response.status,
        400,
      );
      const project = (
        await org('POST', 'projects', { name: `s2-e2e-${randomUUID().slice(0, 8)}` }, 201)
      ).body;
      cleanups.push(() => org('DELETE', `projects/${project.id}`, undefined, null));
      const other = await createKey('other-project', { projectId: project.id });
      assert.equal(
        (
          await responses(
            { model: 'mock/small', input: 'x', previous_response_id: first.body.id },
            other.key,
          )
        ).response.status,
        400,
        'a response id is not valid in another project',
      );
    },
  );

  await scenario(
    '11.4 embeddings: float and base64, billed and metered, oversized batch rejected',
    async () => {
      const embed = (body, key = main.key, headers = {}) =>
        request(`${gateway}/v1/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`,
            ...headers,
          },
          body: JSON.stringify(body),
        });
      const id = `e2e_embed_${randomUUID()}`;
      const floats = await embed(
        { model: 'mock/embed', input: ['alpha', 'beta'], dimensions: 4 },
        main.key,
        { 'x-request-id': id },
      );
      assert.equal(floats.response.status, 200, floats.text);
      assert.equal(floats.body.data.length, 2);
      assert.equal(floats.body.data[0].embedding.length, 4);
      assert.ok(floats.body.usage.total_tokens > 0);
      const base64 = await embed({
        model: 'mock/embed',
        input: 'alpha',
        dimensions: 4,
        encoding_format: 'base64',
      });
      const bytes = Buffer.from(base64.body.data[0].embedding, 'base64');
      assert.equal(bytes.length, 16);
      assert.ok(Math.abs(bytes.readFloatLE(0) - floats.body.data[0].embedding[0]) < 1e-6);
      const row = await logRow(id, "inbound_api || '|' || status || '|' || input_tokens");
      assert.match(row, /^openai\.embeddings\|success\|[1-9]/);

      const gemini = await request(
        `${gateway}/v1beta/models/${encodeURIComponent('mock/embed')}:batchEmbedContents`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': main.key },
          body: JSON.stringify({
            requests: [
              { content: { parts: [{ text: 'one' }] } },
              { content: { parts: [{ text: 'two' }] } },
            ],
          }),
        },
        200,
      );
      assert.equal(gemini.body.embeddings.length, 2);

      // Metered like chat: a key limited to 2 requests per minute is throttled.
      const limited = await createKey('embed-rpm', { rpm: 2 });
      const statuses = [];
      for (let i = 0; i < 4; i++)
        statuses.push(
          (await embed({ model: 'mock/embed', input: 'alpha' }, limited.key)).response.status,
        );
      assert.deepEqual(statuses, [200, 200, 429, 429]);
      const tooMany = await embed({
        model: 'mock/embed',
        input: Array.from({ length: 2_049 }, () => 'x'),
      });
      assert.equal(tooMany.response.status, 400, tooMany.text.slice(0, 200));
    },
  );

  // ───────────── Epic 12: routing ─────────────

  await scenario(
    '12.4 session affinity: header and prompt-prefix sessions stay on one target',
    async () => {
      const combo = (
        await published(() =>
          org(
            'POST',
            'combos',
            {
              slug: `s2-sticky-${randomUUID().slice(0, 6)}`,
              strategy: 'round-robin',
              sticky: true,
              targets: [{ modelId: modelId('mock/small') }, { modelId: modelId('mock/long') }],
            },
            201,
          ),
        )
      ).body;
      cleanups.push(() => org('DELETE', `combos/${combo.id}`, undefined, null));
      await putSettings({ sessionAffinity: { enabled: true } });
      const target = async (headers, system) =>
        (
          await chat(
            main.key,
            {
              model: combo.slug,
              max_tokens: 8,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: 'first message of the conversation' },
                { role: 'user', content: `turn ${randomUUID()}` },
              ],
            },
            headers,
          )
        ).response.headers.get('x-dirouter-model');
      // Without a session the strategy alternates between the two targets.
      await putSettings({ sessionAffinity: { enabled: false } });
      const free = new Set();
      for (let i = 0; i < 6; i++) free.add(await target({}, 'no affinity'));
      assert.equal(free.size, 2, 'round-robin uses both targets');
      await putSettings({ sessionAffinity: { enabled: true } });
      for (const session of ['conversation-a', 'conversation-b', 'conversation-c']) {
        const seen = new Set();
        for (let i = 0; i < 6; i++)
          seen.add(await target({ 'x-dirouter-session': session }, 'header'));
        assert.equal(seen.size, 1, `session ${session} moved between targets`);
      }
      // No header: the stable prompt prefix (system prompt + first message) is the session.
      for (const system of ['agent prompt one', 'agent prompt two', 'agent prompt three']) {
        const seen = new Set();
        for (let i = 0; i < 6; i++) seen.add(await target({}, system));
        assert.equal(seen.size, 1, `prompt-prefix session "${system}" moved between targets`);
      }
    },
  );

  // ───────────── Epic 13: caching and compression ─────────────

  await scenario(
    '13.1 exact cache: hit skips the provider, stream replay, bypass, project isolation',
    async () => {
      await putSettings({ cache: { exact: { enabled: true, ttlSeconds: 120 } } });
      const body = {
        model: 'mock/small',
        temperature: 0,
        max_tokens: 64,
        messages: [{ role: 'user', content: `exact cache ${randomUUID()}` }],
      };
      await mockReset();
      const miss = await chat(main.key, body);
      assert.equal(miss.response.status, 200);
      assert.equal(miss.response.headers.get('x-dirouter-cache'), null);
      await sleep(300);
      const id = `e2e_cachehit_${randomUUID()}`;
      const hit = await chat(main.key, body, { 'x-request-id': id });
      assert.equal(hit.response.headers.get('x-dirouter-cache'), 'exact');
      assert.equal(hit.body.choices[0].message.content, miss.body.choices[0].message.content);
      assert.equal((await mockStats()).requests, 1, 'the provider is called once');
      // A streaming client gets a real SSE replay of the cached answer.
      const replay = await chat(main.key, { ...body, stream: true });
      assert.equal(replay.response.headers.get('x-dirouter-cache'), 'exact');
      assert.match(replay.response.headers.get('content-type'), /text\/event-stream/);
      assert.ok(replay.text.trimEnd().endsWith('data: [DONE]'));
      // Opt-out per request, and no sharing between projects.
      assert.equal(
        (await chat(main.key, body, { 'x-dirouter-cache': 'bypass' })).response.headers.get(
          'x-dirouter-cache',
        ),
        null,
      );
      const project = (
        await org('POST', 'projects', { name: `s2-cache-${randomUUID().slice(0, 8)}` }, 201)
      ).body;
      cleanups.push(() => org('DELETE', `projects/${project.id}`, undefined, null));
      const other = await createKey('cache-other', { projectId: project.id });
      assert.equal((await chat(other.key, body)).response.headers.get('x-dirouter-cache'), null);
      // A hit is recorded at zero cost.
      assert.match(await logRow(id, "cache_hit || '|' || cost_usd"), /^(t|true)\|0(\.0+)?$/);
      await putSettings({ cache: { exact: { enabled: false } } });
    },
  );

  await scenario(
    '13.2 semantic cache: a paraphrase is answered from pgvector, per project',
    async () => {
      const stats = (await org('GET', 'cache/semantic')).body;
      assert.equal(stats.available, true, 'pgvector table present (POSTGRES_IMAGE with pgvector)');
      assert.equal(stats.enabled, true, 'SEMANTIC_CACHE_EMBEDDING_URL configured');
      await org('DELETE', 'cache/semantic', undefined, null);
      await putSettings({
        cache: { semantic: { enabled: true, threshold: 0.999, ttlSeconds: 600, timeoutMs: 2_000 } },
      });
      const tag = randomUUID().slice(0, 8);
      // The mock embedding depends on the text length only: equal-length questions are "the same
      // meaning", a much longer one is not.
      const ask = (content, key = main.key) =>
        chat(key, {
          model: 'mock/small',
          temperature: 0,
          max_tokens: 64,
          messages: [{ role: 'user', content }],
        });
      await mockReset();
      const first = await ask(`How do I reset my password ${tag}?`);
      assert.equal(first.response.status, 200);
      await waitFor(
        'semantic entry stored',
        async () => (await org('GET', 'cache/semantic')).body.entries >= 1,
      );
      const paraphrase = await ask(`How can I reset a password ${tag}?`);
      assert.equal(paraphrase.response.headers.get('x-dirouter-cache'), 'semantic');
      assert.equal(
        paraphrase.body.choices[0].message.content,
        first.body.choices[0].message.content,
      );
      const different = await ask(
        `Explain in detail how billing periods and budgets work ${tag} please`,
      );
      assert.equal(different.response.headers.get('x-dirouter-cache'), null);
      const project = (
        await org('POST', 'projects', { name: `s2-sem-${randomUUID().slice(0, 8)}` }, 201)
      ).body;
      cleanups.push(() => org('DELETE', `projects/${project.id}`, undefined, null));
      const other = await createKey('semantic-other', { projectId: project.id });
      assert.equal(
        (await ask(`How can I reset a password ${tag}?`, other.key)).response.headers.get(
          'x-dirouter-cache',
        ),
        null,
        'another project never reads this entry',
      );
      await putSettings({ cache: { semantic: { enabled: false } } });
      await org('DELETE', 'cache/semantic', undefined, null);
    },
  );

  await scenario(
    '13.3 context compression: repeated tool output is sent upstream once and savings are recorded',
    async () => {
      await putSettings({
        compression: { enabled: true, maxToolResultChars: 400, keepRecentMessages: 2 },
      });
      const big = `file contents ${'lorem ipsum dolor sit amet '.repeat(200)}`;
      const toolTurn = (n) => [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_${n}`,
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: `call_${n}`, content: big },
      ];
      const body = {
        model: 'mock/small',
        max_tokens: 16,
        messages: [
          { role: 'user', content: 'read a.txt three times' },
          ...toolTurn(1),
          ...toolTurn(2),
          ...toolTurn(3),
          { role: 'user', content: 'summarise' },
        ],
      };
      const id = `e2e_compress_${randomUUID()}`;
      await mockReset();
      const res = await chat(main.key, body, { 'x-request-id': id });
      assert.equal(res.response.status, 200, res.text);
      const sent = JSON.stringify((await mockStats()).last.at(-1).messages).length;
      const original = JSON.stringify(body.messages).length;
      assert.ok(sent < original * 0.6, `upstream prompt ${sent} chars vs original ${original}`);
      const saved = Number(await logRow(id, 'saved_input_tokens'));
      assert.ok(saved > 0, 'saved input tokens are recorded');
      await putSettings({ compression: { enabled: false } });
      await mockReset();
      await chat(main.key, body);
      assert.ok(JSON.stringify((await mockStats()).last.at(-1).messages).length >= original * 0.95);
    },
  );

  // ───────────── Epic 15: guardrails ─────────────

  await scenario(
    '15.1 guardrails: block and redact on requests, responses, streams and cached answers',
    async () => {
      const policy = async (body) => {
        const created = (await published(() => org('POST', 'guardrails', body, 201))).body;
        cleanups.push(() => org('DELETE', `guardrails/${created.id}`, undefined, null));
        return created;
      };
      const key = await createKey('guardrail');
      const scoped = { virtualKeyId: key.id };
      const block = await policy({
        ...scoped,
        name: `s2-block-${randomUUID().slice(0, 6)}`,
        type: 'keyword',
        stage: 'request',
        action: 'block',
        config: { terms: ['forbidden-topic'] },
        message: 'This topic is not allowed here',
      });
      const blocked = await chat(key.key, {
        model: 'mock/small',
        messages: [{ role: 'user', content: 'tell me about the forbidden-topic' }],
      });
      assert.equal(blocked.response.status, 400, blocked.text);
      assert.match(blocked.body.error.message, /not allowed/);
      // Tool output is checked like user text.
      const viaTool = await chat(key.key, {
        model: 'mock/small',
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'notes on the forbidden-topic' },
        ],
      });
      assert.equal(viaTool.response.status, 400);
      // The policy is scoped to one key: another key is not affected.
      assert.equal(
        (
          await chat(main.key, {
            model: 'mock/small',
            messages: [{ role: 'user', content: 'forbidden-topic' }],
          })
        ).response.status,
        200,
      );
      await published(() => org('DELETE', `guardrails/${block.id}`, undefined, 204));

      // Request redaction: the provider never sees the e-mail address.
      await policy({
        ...scoped,
        name: `s2-pii-${randomUUID().slice(0, 6)}`,
        type: 'pii',
        stage: 'request',
        action: 'redact',
        config: { type: 'email' },
      });
      await mockReset();
      await chat(key.key, {
        model: 'mock/small',
        messages: [{ role: 'user', content: 'mail me at jane.doe@example.com today' }],
      });
      const upstream = JSON.stringify((await mockStats()).last.at(-1).messages);
      assert.ok(!upstream.includes('jane.doe@example.com'), upstream);

      // Response redaction, JSON and stream (the stream arrives in small chunks, so the secret is
      // split across SSE events).
      await policy({
        ...scoped,
        name: `s2-resp-${randomUUID().slice(0, 6)}`,
        type: 'regex',
        stage: 'response',
        action: 'redact',
        config: { pattern: 'SECRET-\\d{6}' },
      });
      // The mock answers every request with this sentence, in 12 small chunks.
      await request(
        `${mock}/__mock/config`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            directives:
              'text=The code is SECRET-123456 and that is all there is to say about it,chunks=12',
          }),
        },
        200,
      );
      cleanups.push(() => mockReset());
      const leaking = {};
      const json = await chat(
        key.key,
        { model: 'mock/small', messages: [{ role: 'user', content: 'code?' }] },
        leaking,
      );
      assert.ok(!json.text.includes('SECRET-123456'), json.text);
      assert.match(json.body.choices[0].message.content, /The code is .* and that is all/);
      for (const [path, extra] of [
        ['v1/chat/completions', {}],
        ['v1/messages', { 'anthropic-version': '2023-06-01' }],
      ]) {
        const stream = await request(`${gateway}/${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key.key}`,
            ...leaking,
            ...extra,
          },
          body: JSON.stringify({
            model: 'mock/small',
            max_tokens: 100,
            stream: true,
            messages: [{ role: 'user', content: 'code?' }],
          }),
        });
        assert.equal(stream.response.status, 200);
        assert.ok(
          !stream.text.includes('SECRET-123456') && !stream.text.includes('123456'),
          stream.text.slice(0, 600),
        );
        const events = sseEvents(stream.text);
        const text = events
          .map(
            (e) =>
              e.data.choices?.[0]?.delta?.content ??
              (e.data.type === 'content_block_delta' ? e.data.delta.text : '') ??
              '',
          )
          .join('');
        // Nothing is lost or reordered: the whole sentence arrives, minus the secret.
        assert.match(
          text,
          /^The code is .* and that is all there is to say about it$/,
          `${path}: ${text}`,
        );
      }

      await mockReset();

      // An unsafe pattern is refused when the policy is saved.
      const unsafe = await org(
        'POST',
        'guardrails',
        { name: 'unsafe', type: 'regex', config: { pattern: '(a+)+$' } },
        null,
      );
      assert.equal(unsafe.response.status, 400, unsafe.text);
    },
  );

  // ───────────── Epic 17: tracing ─────────────

  await scenario(
    '17.2 tracing: one trace from the client through the gateway to the provider',
    async () => {
      const file = '.verify/otlp-e2e.jsonl';
      await rm(resolve(root, file), { force: true });
      // A minimal OTLP/HTTP collector inside the compose network, writing what it receives.
      const collector = spawn(
        'docker',
        [
          ...compose,
          'exec',
          '-T',
          'dev-deps',
          'node',
          '-e',
          `require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{require('fs').appendFileSync('/repo/${file}',JSON.stringify({url:q.url,type:q.headers['content-type'],body:b})+'\\n');s.writeHead(200,{'content-type':'application/json'});s.end('{}')})}).listen(4318,'0.0.0.0')`,
        ],
        { cwd: root, env, stdio: 'ignore' },
      );
      cleanups.push(async () => {
        collector.kill('SIGTERM');
        await exec(
          'docker',
          [...compose, 'exec', '-T', 'dev-deps', 'sh', '-c', "pkill -f 'listen(4318' || true"],
          { cwd: root, env },
        ).catch(() => undefined);
      });
      await sleep(1_500);
      await putSettings({
        tracing: {
          enabled: true,
          endpoint: 'http://dev-deps:4318/v1/traces',
          sampleRatio: 1,
          serviceName: 'dirouter-gateway-e2e',
        },
      });
      // Earlier scenarios may have opened the breaker of the failing provider; start from a clean
      // health state so the `dev` combo really tries its first target.
      await org('POST', 'health/reset', { scope: 'provider', id: 'prv_mock-down' }, null);
      await org('POST', 'health/reset', { scope: 'model', id: 'mdl_dev_mock_down' }, null);
      await sleep(1_000);
      const traceId = randomUUID().replaceAll('-', '');
      const parent = `00-${traceId}-${'ab'.repeat(8)}-01`;
      await mockReset();
      const ok = await chat(
        main.key,
        { model: 'dev', messages: [{ role: 'user', content: 'trace me' }] },
        { traceparent: parent },
      );
      assert.equal(ok.response.status, 200);
      // A failing request is exported too.
      const failing = randomUUID().replaceAll('-', '');
      await chat(
        main.key,
        { model: 'no-such-model', messages: [{ role: 'user', content: 'x' }] },
        { traceparent: `00-${failing}-${'cd'.repeat(8)}-01` },
      );
      const upstream = (await mockStats()).traceparents;
      assert.ok(
        upstream.length >= 1 && upstream.every((value) => value.includes(traceId)),
        JSON.stringify(upstream),
      );
      const spans = await waitFor(
        'spans at the collector',
        async () => {
          const lines = (await readFile(resolve(root, file), 'utf8').catch(() => ''))
            .trim()
            .split('\n')
            .filter(Boolean);
          const all = lines.flatMap((line) =>
            JSON.parse(JSON.parse(line).body).resourceSpans.flatMap((r) =>
              r.scopeSpans.flatMap((s) => s.spans),
            ),
          );
          return all.some((s) => s.traceId === traceId) && all.some((s) => s.traceId === failing)
            ? all
            : undefined;
        },
        15_000,
      );
      const mine = spans.filter((s) => s.traceId === traceId);
      const server = mine.find((s) => s.name === 'gateway.request');
      assert.equal(server.parentSpanId, 'ab'.repeat(8), 'continues the caller trace');
      const attempts = mine.filter((s) => s.name === 'gateway.upstream');
      // `dev` falls back from a failing provider to a healthy one: one span per attempt.
      assert.ok(attempts.length >= 2 && attempts.every((s) => s.parentSpanId === server.spanId));
      assert.ok(upstream.some((value) => attempts.some((s) => value.includes(s.spanId))));
      assert.ok(!JSON.stringify(mine).includes('trace me'), 'no prompt text in spans');
      await putSettings({ tracing: { enabled: false } });
      await mockReset();
      await chat(main.key, {
        model: 'mock/small',
        messages: [{ role: 'user', content: 'no trace' }],
      });
      assert.equal(
        (await mockStats()).traceparents.length,
        0,
        'nothing injected when tracing is off',
      );
    },
  );

  globalThis.__s2 = {
    main,
    modelId,
    org,
    api,
    createKey,
    putSettings,
    published,
    chat,
    request,
    sql,
    logRow,
    waitFor,
    mockStats,
    mockReset,
    sseEvents,
    cleanups,
    owner,
    readEnv,
    createHmac,
  };
  const more = resolve(dirname(fileURLToPath(import.meta.url)), 'sprint-2-control.mjs');
  const { default: controlScenarios } = await import(more);
  await controlScenarios(scenario, globalThis.__s2);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      console.error('cleanup failed:', error instanceof Error ? error.message : error);
    }
  }
  const passed = results.filter((r) => r.status === 'passed').length;
  console.log(JSON.stringify({ passed, failed: results.length - passed, results }, null, 2));
  if (failed || passed !== results.length) process.exitCode = 1;
}
