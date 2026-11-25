/**
 * Card 31.7: citations across formats, through Traefik. The mock's `citations` directive makes
 * each provider cite https://example.org/mock-source in its own format.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, request, urls, waitFor } from '../harness.mjs';

const SOURCE = 'https://example.org/mock-source';

export async function register({ scenario, cleanups, org, createKey }) {
  const tag = randomUUID().slice(0, 6);
  const slugs = {};
  let key;
  const setup = async () => {
    if (key) return;
    for (const [type, upstream, base] of [
      ['anthropic', 'claude-sonnet-4-5', 'http://mock-provider:8090'],
      ['gemini', 'gemini-2.5-pro', 'http://mock-provider:8090'],
      ['openai-compatible', 'gpt-5-search-api', 'http://mock-provider:8090/v1'],
    ]) {
      const provider = (
        await published(() =>
          org(
            'POST',
            'providers',
            {
              name: `s5-317-${type}-${tag}`,
              slug: `s5-317-${type}-${tag}`,
              type,
              baseUrl: base,
              credentials: [{ name: 'k', secret: 'mock:citations' }],
            },
            201,
          ),
        )
      ).body;
      cleanups.push(() => org('DELETE', `providers/${provider.id}`, undefined, null));
      const model = (
        await published(() =>
          org(
            'POST',
            'models',
            {
              providerId: provider.id,
              upstreamModel: upstream,
              slug: `s5-317/${type}-${tag}`,
              pricing: { inputPerMTok: '1', outputPerMTok: '1' },
            },
            201,
          ),
        )
      ).body;
      slugs[type] = model.slug;
    }
    key = (await createKey('317')).key;
    await waitFor('gateway to know the 31.7 models', async () => {
      const res = await fetch(`${urls.gateway}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
      });
      const ids = ((await res.json()).data ?? []).map((m) => m.id);
      return Object.values(slugs).every((slug) => ids.includes(slug));
    });
  };
  const ask = [{ role: 'user', content: 'Weather?' }];

  await scenario('31.7 citations reach OpenAI, Anthropic and Responses clients', async () => {
    await setup();
    // OpenAI Chat client ← Claude and Gemini.
    for (const model of [slugs.anthropic, slugs.gemini]) {
      const { body } = await chat(key, { model, messages: ask });
      const annotation = body.choices[0].message.annotations?.[0];
      assert.equal(annotation?.url_citation?.url, SOURCE, `${model}: ${JSON.stringify(body)}`);
    }
    // Anthropic client ← OpenAI search model and Gemini.
    for (const model of [slugs['openai-compatible'], slugs.gemini]) {
      const { body } = await request(
        `${urls.gateway}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({ model, max_tokens: 50, messages: ask }),
        },
        200,
      );
      assert.equal(
        body.content[0].citations?.[0]?.url,
        SOURCE,
        `${model}: ${JSON.stringify(body)}`,
      );
    }
    // Responses client ← Claude.
    const { body } = await request(
      `${urls.gateway}/v1/responses`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: slugs.anthropic, input: 'Weather?' }),
      },
      200,
    );
    assert.equal(body.output[0].content[0].annotations[0].url, SOURCE);
  });
}
