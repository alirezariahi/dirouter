/**
 * Card 31.3: automatic prompt-cache breakpoints, through Traefik against the mock provider, which
 * caches like Anthropic: only what a breakpoint marks.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, request, urls, waitFor } from '../harness.mjs';

export async function register({ scenario, cleanups, org, createKey }) {
  let ready;
  const setup = async () => {
    if (ready) return ready;
    const tag = randomUUID().slice(0, 6);
    const provider = (
      await published(() =>
        org(
          'POST',
          'providers',
          {
            name: `s5-313-${tag}`,
            slug: `s5-313-${tag}`,
            type: 'anthropic',
            baseUrl: 'http://mock-provider:8090',
            credentials: [{ name: 'k', secret: 'sk-ant-mock' }],
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `providers/${provider.id}`, undefined, null));
    const create = async (slug, extra = {}) =>
      (
        await published(() =>
          org(
            'POST',
            'models',
            {
              providerId: provider.id,
              upstreamModel: 'claude-sonnet-4-5',
              slug,
              pricing: { inputPerMTok: '3', outputPerMTok: '15', cacheReadPerMTok: '0.3' },
              ...extra,
            },
            201,
          ),
        )
      ).body;
    const cachedModel = await create(`s5-313/cached-${tag}`, {
      requestPolicy: { autoCache: true },
    });
    const plainModel = await create(`s5-313/plain-${tag}`);
    const alias = (
      await published(() =>
        org(
          'POST',
          'aliases',
          {
            slug: `s5-313/alias-${tag}`,
            modelId: plainModel.id,
            requestPolicy: { autoCache: true, autoCacheTtl: '1h' },
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `aliases/${alias.id}`, undefined, null));
    const key = (await createKey('313')).key;
    await waitFor('gateway to know the 31.3 models', async () => {
      const res = await fetch(`${urls.gateway}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
      });
      const ids = ((await res.json()).data ?? []).map((m) => m.id);
      return [cachedModel.slug, plainModel.slug].every((slug) => ids.includes(slug));
    });
    ready = { key, cached: cachedModel.slug, plain: plainModel.slug, alias: alias.slug, tag };
    return ready;
  };

  const conversation = (tag) => {
    const system = `You are a meticulous assistant (${tag}). `.repeat(40);
    const turn1 = [
      { role: 'system', content: system },
      { role: 'user', content: 'What is 2+2?' },
    ];
    return {
      turn1,
      turn2: [...turn1, { role: 'assistant', content: '4' }, { role: 'user', content: 'And 3+3?' }],
    };
  };
  const cachedTokens = async (key, model, messages) => {
    const res = await chat(key, { model, messages });
    assert.equal(res.response.status, 200, res.text);
    return res.body.usage.prompt_tokens_details.cached_tokens;
  };

  await scenario(
    '31.3 an OpenAI-format request to Claude reports a non-zero cache read on the second turn (model and alias policy)',
    async () => {
      const { key, cached, plain, alias, tag } = await setup();
      for (const model of [cached, alias]) {
        const { turn1, turn2 } = conversation(`${tag}-${model}`);
        assert.equal(await cachedTokens(key, model, turn1), 0, `${model} first turn`);
        const second = await cachedTokens(key, model, turn2);
        assert.ok(second > 0, `${model} second turn read ${second} cached tokens`);
      }
      const { turn1, turn2 } = conversation(`${tag}-plain`);
      await cachedTokens(key, plain, turn1);
      assert.equal(await cachedTokens(key, plain, turn2), 0, 'no policy, no cache');
    },
  );

  await scenario('31.3 a request that carries its own cache_control is not changed', async () => {
    const { key, cached, tag } = await setup();
    const body = {
      model: cached,
      max_tokens: 64,
      system: [
        {
          type: 'text',
          text: `own markers ${tag}`,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    };
    const res = await request(
      `${urls.gateway}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      },
      200,
    );
    assert.equal(res.body.type, 'message');
    const stats = (await request(`${urls.mock}/__mock/stats`, {}, 200)).body;
    const sent = stats.last.findLast((b) =>
      JSON.stringify(b.system ?? '').includes(`own markers ${tag}`),
    );
    assert.ok(sent, 'the mock saw the request');
    assert.deepEqual(sent.system, body.system);
    assert.deepEqual(sent.messages, body.messages);
  });

  await scenario('31.3 the Cost page reports the provider prompt-cache savings', async () => {
    await setup();
    await waitFor(
      'prompt-cache reads in stats/cache',
      async () => {
        const { body } = await org('GET', 'stats/cache', undefined, 200);
        return body.promptCache?.readTokens > 0 && Number(body.promptCache.savedUsd) > 0;
      },
      60_000,
    );
  });
}
