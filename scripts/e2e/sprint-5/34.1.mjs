/**
 * Card 34.1: the sprint 5 endpoints through the official SDKs, unchanged, against the mock
 * provider and through Traefik. The OpenAI SDK (and the Anthropic SDK where an Anthropic-shaped
 * endpoint applies) covers image edits and variations, audio translations, legacy completions,
 * the Realtime WebSocket with a client secret, model suffixes, service_tier, provider
 * preferences and the `models` fallback, the routing explanation header, `:online` web search,
 * web fetch and native pass-through. Files/Batch (30.1), moderations (30.3) and videos (30.6)
 * already run through the OpenAI SDK, and rerank (30.2) through the Cohere SDK, in their own
 * modules.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { published, request, root, sql, urls, waitFor } from '../harness.mjs';

const MOCK = 'http://mock-provider:8090';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
/** One second of PCM16 at 24 kHz; the mock counts it as 10 audio tokens. */
const SECOND_OF_AUDIO = Buffer.alloc(48_000).toString('base64');

/** A silent 16 kHz mono WAV. */
function wav(seconds) {
  const samples = Math.round(seconds * 16_000);
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24);
  b.writeUInt32LE(32_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

const resetMock = () => request(`${urls.mock}/__mock/reset`, { method: 'POST' }, 200);
const lastUpstream = async () =>
  (await request(`${urls.mock}/__mock/stats`, {}, 200)).body.last.at(-1);

/** The request_log row of a request id, once the usage sink has written it. */
const logged = (id) =>
  waitFor(`request ${String(id)} in request_log`, async () => {
    const row = await sql(
      `SELECT inbound_api, cost_usd, input_tokens, output_tokens, media::text, service_tier
         FROM request_log WHERE id = '${String(id)}'`,
    );
    if (!row) return undefined;
    const [api, cost, input, output, media, tier] = row.split('|');
    return {
      api,
      cost,
      input: Number(input),
      output: Number(output),
      media: JSON.parse(media || 'null'),
      tier,
    };
  });

export async function register({ scenario, cleanups, org, createKey }) {
  const require = createRequire(join(root, 'apps/gateway/package.json'));
  const { default: OpenAI, toFile } = require('openai');
  const { OpenAIRealtimeWS } = require('openai/realtime/ws');
  const { default: Anthropic } = require('@anthropic-ai/sdk');
  const tag = randomUUID().slice(0, 6);

  const openai = (apiKey, baseURL = `${urls.gateway}/v1`) =>
    new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 30_000 });
  const anthropic = (apiKey, baseURL = urls.gateway) =>
    new Anthropic({ apiKey, baseURL, maxRetries: 0, timeout: 30_000 });

  /** A mock-backed provider, removed at the end. */
  async function provider(name, body) {
    const created = (
      await published(() =>
        org(
          'POST',
          'providers',
          {
            name: `s5-sdk-${name}-${tag}`,
            slug: `s5-sdk-${name}-${tag}`,
            credentials: [{ name: 'k', secret: `mock-sdk-${tag}` }],
            ...body,
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `providers/${created.id}`, undefined, null));
    return created;
  }

  /** A model on a provider, removed at the end; returns its slug. */
  async function model(providerId, slug, upstreamModel, pricing, capabilities) {
    const created = (
      await published(() =>
        org(
          'POST',
          'models',
          {
            providerId,
            upstreamModel,
            slug: `s5-sdk-${tag}/${slug}`,
            pricing: { inputPerMTok: '0', outputPerMTok: '0', ...pricing },
            ...(capabilities ? { capabilities } : {}),
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `models/${created.id}`, undefined, null));
    return created.slug;
  }

  let setup;
  /** One OpenAI-type mock provider with the media, legacy, realtime and tiered models. */
  async function models() {
    if (setup) return setup;
    const { id } = await provider('openai', { type: 'openai', baseUrl: `${MOCK}/v1` });
    setup = {
      image: await model(
        id,
        'image',
        'gpt-image-1',
        { inputPerMTok: '5', outputPerMTok: '40', perImageUsd: '0.01' },
        { images: true },
      ),
      dalle: await model(id, 'dalle', 'dall-e-2', { perImageUsd: '0.02' }, { images: true }),
      whisper: await model(
        id,
        'whisper',
        'whisper-1',
        { perSecondUsd: '0.0001' },
        { transcription: true },
      ),
      instruct: await model(
        id,
        'instruct',
        'gpt-3.5-turbo-instruct',
        { inputPerMTok: '1.5', outputPerMTok: '2' },
        { completions: true },
      ),
      realtime: await model(
        id,
        'realtime',
        'gpt-realtime',
        {
          inputPerMTok: '4',
          outputPerMTok: '16',
          audioInputPerMTok: '32',
          audioOutputPerMTok: '64',
        },
        { realtime: true },
      ),
      tiered: await model(id, 'tiered', 'mock-small', {
        inputPerMTok: '2',
        outputPerMTok: '8',
        serviceTiers: {
          flex: { inputPerMTok: '1', outputPerMTok: '4' },
          priority: { inputPerMTok: '3.5', outputPerMTok: '14' },
        },
      }),
      key: await createKey('sdk'),
    };
    return setup;
  }

  const png = (name = 'image.png') => toFile(PNG, name, { type: 'image/png' });

  await scenario('34.1 OpenAI SDK: image edits and variations', async () => {
    const { image, dalle, key } = await models();
    const client = openai(key.key);

    const { data, response } = await client.images
      .edit({ model: image, image: await png(), prompt: 'add a hat', n: 2 })
      .withResponse();
    assert.equal(data.data.length, 2);
    assert.match(data.data[0].b64_json, /^iVBOR/);
    const edit = await logged(response.headers.get('x-request-id'));
    assert.equal(edit.api, 'openai.images');
    assert.deepEqual(edit.media, { images: 2 });

    // Several input images: the SDK sends them as `image[]`.
    const merged = await client.images.edit({
      model: image,
      image: [await png('a.png'), await png('b.png')],
      prompt: 'merge',
    });
    assert.equal(merged.data.length, 1);

    const masked = await client.images.edit({
      model: dalle,
      image: await png(),
      mask: await png('mask.png'),
      prompt: 'a red door',
    });
    assert.equal(masked.data[0].url, 'https://mock.invalid/edits.png');

    const varied = await client.images
      .createVariation({ model: dalle, image: await png(), n: 3, response_format: 'b64_json' })
      .withResponse();
    assert.equal(varied.data.data.length, 3);
    const row = await logged(varied.response.headers.get('x-request-id'));
    assert.equal(row.cost, '0.06000000');
  });

  await scenario('34.1 OpenAI SDK: audio translations', async () => {
    const { whisper, key } = await models();
    const { data, response } = await openai(key.key)
      .audio.translations.create({
        model: whisper,
        file: await toFile(wav(4), 'speech.wav', { type: 'audio/wav' }),
        response_format: 'verbose_json',
      })
      .withResponse();
    assert.equal(data.text, 'Hello from the DiRouter mock translator.');
    assert.equal(data.task, 'translate');
    const row = await logged(response.headers.get('x-request-id'));
    assert.equal(row.api, 'openai.translations');
    assert.deepEqual(row.media, { seconds: 4 });
  });

  await scenario('34.1 OpenAI SDK: legacy completions, native, mapped and streamed', async () => {
    const { instruct, key } = await models();
    const client = openai(key.key);
    const native = await client.completions.create({
      model: instruct,
      prompt: 'Say hi',
      max_tokens: 5,
      n: 2,
    });
    assert.equal(native.object, 'text_completion');
    assert.equal(native.choices.length, 2);
    assert.equal(native.choices[0].text, 'Hello from the DiRouter mock');

    const mapped = await client.completions.create({ model: 'mock/small', prompt: 'Say hi' });
    assert.equal(mapped.choices[0].text, 'Hello from the DiRouter mock provider.');
    assert.equal(mapped.choices[0].finish_reason, 'stop');

    const stream = await client.completions.create({
      model: 'mock/small',
      prompt: 'Say hi',
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let usage;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.text ?? '';
      usage = chunk.usage ?? usage;
    }
    assert.equal(text, 'Hello from the DiRouter mock provider.');
    assert.ok(usage?.prompt_tokens > 0, JSON.stringify(usage));

    await assert.rejects(
      client.completions.create({ model: 'mock/small', prompt: 'x', echo: true }),
      (error) => error.status === 400 && /echo/.test(error.message),
    );
  });

  await scenario(
    '34.1 OpenAI SDK: a realtime client secret and a WebSocket session (OpenAIRealtimeWS)',
    async () => {
      const { realtime, key } = await models();
      const secret = await openai(key.key).realtime.clientSecrets.create({
        session: { type: 'realtime', model: realtime, instructions: 'Be brief.' },
      });
      assert.match(secret.value, /^ek_/);

      // The SDK always dials wss://; Traefik serves the dev host on TLS with its own certificate.
      const browserLike = openai(secret.value, `${urls.gateway.replace(/^http:/, 'https:')}/v1`);
      const rt = new OpenAIRealtimeWS(
        { model: realtime, options: { rejectUnauthorized: false } },
        browserLike,
      );
      const events = [];
      const waiting = [];
      const errors = [];
      rt.on('error', (error) => errors.push(error));
      rt.on('event', (event) => {
        const at = waiting.findIndex((w) => w.type === event.type);
        if (at === -1) events.push(event);
        else waiting.splice(at, 1)[0].resolve(event);
      });
      const next = (type) =>
        new Promise((resolve, reject) => {
          const at = events.findIndex((e) => e.type === type);
          if (at !== -1) return resolve(events.splice(at, 1)[0]);
          const timer = setTimeout(() => {
            reject(new Error(`no ${type} event (errors: ${errors.map(String).join('; ')})`));
          }, 15_000);
          waiting.push({
            type,
            resolve: (event) => {
              clearTimeout(timer);
              resolve(event);
            },
          });
        });
      const opened = new Promise((resolve, reject) => {
        rt.socket.once('open', resolve);
        rt.socket.once('error', reject);
      });
      await opened;
      const created = await next('session.created');
      assert.equal(created.session.model, realtime);
      rt.send({ type: 'input_audio_buffer.append', audio: SECOND_OF_AUDIO });
      rt.send({ type: 'input_audio_buffer.commit' });
      await next('input_audio_buffer.committed');
      rt.send({ type: 'response.create' });
      await next('response.output_audio.delta');
      const done = await next('response.done');
      assert.equal(done.response.status, 'completed');
      const closed = new Promise((resolve) => rt.socket.once('close', resolve));
      rt.close();
      await closed;
      assert.deepEqual(errors, []);

      const row = await waitFor('the realtime row in request_log', async () =>
        sql(
          `SELECT media->>'audioInputTokens' FROM request_log
            WHERE api_key_id = '${key.id}' AND inbound_api = 'openai.realtime' LIMIT 1`,
        ),
      );
      assert.equal(row, '10');
    },
  );

  await scenario(
    '34.1 OpenAI SDK: suffixes, provider preferences and the models fallback in chat',
    async () => {
      const key = await createKey('sdk-routing');
      const client = openai(key.key);

      await resetMock();
      const high = await client.chat.completions.create({
        model: 'mock/small:high',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.ok(high.choices[0].message.content);
      assert.equal((await lastUpstream()).reasoning_effort, 'high');

      const floor = await client.chat.completions.create({
        model: 'dev:floor',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.ok(floor.choices[0].message.content);

      // OpenRouter-style fields the SDK passes through untyped.
      await resetMock();
      const ignored = await client.chat.completions
        .create({
          model: 'dev',
          messages: [{ role: 'user', content: 'hi' }],
          provider: { ignore: ['mock-down'], sort: 'price', data_collection: 'allow' },
        })
        .withResponse();
      assert.equal(ignored.response.headers.get('x-dirouter-attempts'), '1');
      assert.equal(ignored.response.headers.get('x-dirouter-provider'), 'mock');
      const upstream = await lastUpstream();
      for (const field of ['provider', 'models', 'route'])
        assert.ok(!(field in upstream), `the provider received ${field}`);

      const fallback = await client.chat.completions
        .create({
          model: 'mock/down',
          models: ['mock/small'],
          messages: [{ role: 'user', content: 'hi' }],
        })
        .withResponse();
      assert.equal(fallback.response.headers.get('x-dirouter-model'), 'mock/small');

      await assert.rejects(
        client.chat.completions.create({
          model: 'dev',
          messages: [{ role: 'user', content: 'hi' }],
          provider: { only: ['no-such-provider'] },
        }),
        (error) => error.status === 400 && error.code === 'no_provider_matches_preferences',
      );
    },
  );

  await scenario(
    '34.1 OpenAI SDK: service_tier on chat and Responses is sent upstream and priced',
    async () => {
      const { tiered, key } = await models();
      const client = openai(key.key);
      await resetMock();
      const { response } = await client.chat.completions
        .create({
          model: tiered,
          service_tier: 'flex',
          messages: [{ role: 'user', content: 'hi' }],
        })
        .withResponse();
      assert.equal((await lastUpstream()).service_tier, 'flex');
      const row = await logged(response.headers.get('x-request-id'));
      assert.equal(row.tier, 'flex');
      const expected = (row.input * 1 + row.output * 4) / 1e6;
      assert.ok(Math.abs(Number(row.cost) - expected) < 1e-8, `${row.cost} vs ${expected}`);

      await resetMock();
      const responses = await client.responses
        .create({ model: tiered, service_tier: 'priority', input: 'hi' })
        .withResponse();
      assert.ok(responses.data.output_text);
      assert.equal((await lastUpstream()).service_tier, 'priority');
      const responsesRow = await logged(responses.response.headers.get('x-request-id'));
      assert.equal(responsesRow.tier, 'priority');
    },
  );

  await scenario('34.1 OpenAI SDK: the routing explanation header', async () => {
    const key = await createKey('sdk-explain');
    cleanups.push(() =>
      org('PUT', 'routing-policies', { scope: 'key', scopeId: key.id, policy: null }, null),
    );
    await published(() =>
      org('PUT', 'routing-policies', { scope: 'key', scopeId: key.id, policy: { explain: true } }),
    );
    const client = openai(key.key);
    const ask = (headers) =>
      client.chat.completions
        .create({ model: 'mock/small', messages: [{ role: 'user', content: 'hi' }] }, { headers })
        .withResponse();
    const explained = await ask({ 'x-dirouter-explain': '1' });
    const header = explained.response.headers.get('x-dirouter-routing');
    assert.ok(header, 'x-dirouter-routing is present');
    const plan = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    assert.deepEqual(
      plan.attempts.map((a) => a.outcome),
      ['success'],
    );
    assert.ok(plan.candidates.length > 0);
    const plain = await ask({});
    assert.equal(plain.response.headers.get('x-dirouter-routing'), null);
  });

  await scenario('34.1 OpenAI and Anthropic SDKs: :online web search and web fetch', async () => {
    const key = await createKey('sdk-online');
    const hint = 'is the dev gateway running with the WEB_SEARCH_* variables of compose.dev.yaml?';
    const client = openai(key.key);
    const systemOfLastUpstream = async () =>
      (await lastUpstream())?.messages?.find((m) => m.role === 'system')?.content ?? '';

    // `:online`: the results go in front of the prompt, the sources come back as url_citation
    // annotations and the search is billed as its own row.
    await resetMock();
    const online = await client.chat.completions
      .create({
        model: 'mock/small:online',
        messages: [{ role: 'user', content: `What changed in DiRouter ${randomUUID()}?` }],
      })
      .withResponse();
    assert.ok(online.data.choices[0].message.content);
    assert.match(String(await systemOfLastUpstream()), /Web search results for/, hint);
    const onlineSources = online.data.choices[0].message.annotations ?? [];
    assert.ok(onlineSources.length > 0, hint);
    assert.equal(onlineSources[0].type, 'url_citation');
    const onlineId = online.response.headers.get('x-request-id');
    await waitFor('the :online search row', async () =>
      sql(
        `SELECT 1 FROM request_log WHERE id LIKE '${onlineId}:web_search:%' AND inbound_api = 'web.search'`,
      ),
    );

    // The OpenRouter `plugins: [{ id: "web" }]` form returns the sources as url_citation.
    const plugin = await client.chat.completions
      .create({
        model: 'mock/small',
        messages: [{ role: 'user', content: `What is DiRouter ${randomUUID()}?` }],
        plugins: [{ id: 'web', max_results: 2 }],
      })
      .withResponse();
    assert.notEqual(plugin.response.headers.get('x-dirouter-web-search'), 'unavailable', hint);
    const annotations = plugin.data.choices[0].message.annotations ?? [];
    assert.equal(annotations.length, 2, hint);
    assert.equal(annotations[0].type, 'url_citation');
    assert.match(annotations[0].url_citation.url, /\/web\/page\//);

    // The same suffix on /v1/messages through the Anthropic SDK.
    const claude = anthropic(key.key);
    await resetMock();
    const message = await claude.messages.create({
      model: 'mock/small:online',
      max_tokens: 256,
      messages: [{ role: 'user', content: `What is new in DiRouter ${randomUUID()}?` }],
    });
    assert.equal(message.type, 'message');
    assert.ok(message.content.some((block) => block.type === 'text'));
    assert.ok(
      message.content.some((block) => block.type === 'web_search_tool_result'),
      hint,
    );
    assert.match(String(await systemOfLastUpstream()), /Web search results for/, hint);

    // Claude Code's server web_search tool on a non-Anthropic model.
    const searched = await claude.messages.create({
      model: 'mock/small',
      max_tokens: 512,
      messages: [{ role: 'user', content: `Perform a web search for: dirouter ${randomUUID()}` }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    });
    assert.deepEqual(
      searched.content.map((block) => block.type),
      ['server_tool_use', 'web_search_tool_result', 'text'],
      hint,
    );
    assert.equal(searched.usage.server_tool_use.web_search_requests, 1);

    // Web fetch is DiRouter's own endpoint; the SDK's generic post reaches it with the same key.
    const page = await client.post('/fetch', { body: { url: `${MOCK}/web/page/1` } });
    assert.equal(page.title, 'Mock page 1');
  });

  await scenario(
    '34.1 Anthropic SDK: suffixes and provider preferences on /v1/messages',
    async () => {
      const key = await createKey('sdk-anthropic');
      const claude = anthropic(key.key);
      await resetMock();
      const { data, response } = await claude.messages
        .create({
          model: 'mock/small:high',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }],
        })
        .withResponse();
      assert.equal(data.type, 'message');
      assert.equal((await lastUpstream()).reasoning_effort, 'high');
      assert.ok(response.headers.get('x-request-id'));

      const routed = await claude.messages
        .create({
          model: 'dev',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }],
          provider: { ignore: ['mock-down'] },
        })
        .withResponse();
      assert.equal(routed.response.headers.get('x-dirouter-attempts'), '1');
      assert.equal(routed.response.headers.get('x-dirouter-provider'), 'mock');

      const stream = claude.messages.stream({
        model: 'mock/small:floor',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const final = await stream.finalMessage();
      assert.ok(final.content.some((block) => block.type === 'text' && block.text.length > 0));
    },
  );

  await scenario('34.1 OpenAI and Anthropic SDKs pointed at /passthrough/{provider}', async () => {
    const compatible = await provider('pass-oai', {
      type: 'openai-compatible',
      baseUrl: `${MOCK}/v1`,
      options: { passthroughPaths: ['POST /completions'] },
    });
    await model(compatible.id, 'pass-instruct', 'gpt-3.5-turbo-instruct', {
      inputPerMTok: '1',
      outputPerMTok: '2',
    });
    const claudeProvider = await provider('pass-ant', {
      type: 'anthropic',
      baseUrl: MOCK,
      options: { passthroughPaths: ['POST /v1/messages'] },
    });
    await model(claudeProvider.id, 'pass-claude', 'claude-sonnet-4', {
      inputPerMTok: '3',
      outputPerMTok: '15',
    });
    const key = await createKey('sdk-passthrough', {
      passthroughProviders: [compatible.slug, claudeProvider.slug],
    });

    const viaOpenAI = await openai(key.key, `${urls.gateway}/passthrough/${compatible.slug}`)
      .completions.create({ model: 'gpt-3.5-turbo-instruct', prompt: 'Say hello' })
      .withResponse();
    assert.equal(viaOpenAI.data.object, 'text_completion');
    assert.equal(viaOpenAI.response.headers.get('x-dirouter-provider'), compatible.slug);
    assert.equal((await logged(viaOpenAI.response.headers.get('x-request-id'))).api, 'passthrough');

    const viaAnthropic = await anthropic(
      key.key,
      `${urls.gateway}/passthrough/${claudeProvider.slug}`,
    )
      .messages.create({
        model: 'claude-sonnet-4',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .withResponse();
    assert.equal(viaAnthropic.data.type, 'message');
    // A native answer: the upstream model name, not a DiRouter slug.
    assert.equal(viaAnthropic.data.model, 'claude-sonnet-4');
    const row = await logged(viaAnthropic.response.headers.get('x-request-id'));
    assert.equal(row.api, 'passthrough');
    assert.ok(Number(row.cost) > 0, `cost ${row.cost}`);

    // A path outside the allow-list is refused through the SDK too.
    await assert.rejects(
      openai(key.key, `${urls.gateway}/passthrough/${compatible.slug}`).embeddings.create({
        model: 'x',
        input: 'x',
      }),
      (error) => error.status === 403 || error.status === 404,
    );
  });
}
