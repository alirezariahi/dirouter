/**
 * Card 31.6: every new provider preset, created like an operator would and pointed at the mock:
 * the connection test, model discovery and one chat through Traefik.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, urls, waitFor } from '../harness.mjs';

const MOCK = 'http://mock-provider:8090';
const PRESETS = [
  { preset: 'perplexity', baseUrl: MOCK, model: 'sonar', discovers: 'sonar-pro' },
  {
    preset: 'deepinfra',
    baseUrl: `${MOCK}/v1/openai`,
    model: 'meta-llama/Llama-3.3-70B-Instruct',
    discovers: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    preset: 'nvidia',
    baseUrl: `${MOCK}/v1`,
    model: 'meta/llama-3.1-70b-instruct',
    discovers: 'mock-small',
  },
  {
    preset: 'huggingface',
    baseUrl: `${MOCK}/v1`,
    model: 'meta-llama/Llama-3.1-8B-Instruct',
    discovers: 'mock-small',
  },
  {
    preset: 'databricks',
    baseUrl: `${MOCK}/serving-endpoints`,
    model: 'databricks-meta-llama-3-3-70b-instruct',
    discovers: 'my-finetuned-endpoint',
  },
  {
    preset: 'replicate',
    baseUrl: `${MOCK}/v1`,
    model: 'meta/meta-llama-3-70b-instruct',
    discovers: 'ibm-granite/granite-3.3-8b-instruct',
  },
  {
    preset: 'watsonx',
    baseUrl: MOCK,
    options: { projectId: 'e2e-project', tokenUrl: `${MOCK}/identity/token` },
    model: 'ibm/granite-3-8b-instruct',
    discovers: 'meta-llama/llama-3-3-70b-instruct',
  },
  {
    preset: 'sagemaker',
    baseUrl: MOCK,
    options: { region: 'eu-west-1', controlUrl: `${MOCK}/`, containerModel: 'tgi' },
    secret: 'AKIAMOCKE2E:secret',
    model: 'llama-3-tgi',
    discovers: 'mistral-lmi',
  },
];

export async function register({ scenario, cleanups, org, createKey }) {
  await scenario(
    '31.6 each new preset passes the connection test, discovers models and answers a chat',
    async () => {
      const tag = randomUUID().slice(0, 6);
      const slugs = [];
      for (const item of PRESETS) {
        const provider = (
          await published(() =>
            org(
              'POST',
              'providers',
              {
                name: `s5-316-${item.preset}-${tag}`,
                slug: `s5-316-${item.preset}-${tag}`,
                type: 'openai-compatible',
                baseUrl: item.baseUrl,
                options: { preset: item.preset, ...item.options },
                credentials: [{ name: 'k', secret: item.secret ?? 'sk-e2e-mock' }],
              },
              201,
            ),
          )
        ).body;
        cleanups.push(() => org('DELETE', `providers/${provider.id}`, undefined, null));
        const test = (await org('POST', `providers/${provider.id}/test`, {}, 200)).body;
        assert.equal(test.ok, true, `${item.preset} connection test: ${JSON.stringify(test)}`);
        const discovered = (await org('POST', `providers/${provider.id}/discover`, {}, 200)).body;
        const ids = (discovered.items ?? discovered.models ?? discovered).map(
          (m) => m.id ?? m.upstreamModel,
        );
        assert.ok(ids.includes(item.discovers), `${item.preset} discovered ${JSON.stringify(ids)}`);
        const model = (
          await published(() =>
            org(
              'POST',
              'models',
              {
                providerId: provider.id,
                upstreamModel: item.model,
                slug: `s5-316/${item.preset}-${tag}`,
                pricing: { inputPerMTok: '1', outputPerMTok: '1' },
              },
              201,
            ),
          )
        ).body;
        slugs.push(model.slug);
      }
      const key = (await createKey('316')).key;
      await waitFor('gateway to know the 31.6 models', async () => {
        const res = await fetch(`${urls.gateway}/v1/models`, {
          headers: { authorization: `Bearer ${key}` },
        });
        const ids = ((await res.json()).data ?? []).map((m) => m.id);
        return slugs.every((slug) => ids.includes(slug));
      });
      for (const slug of slugs) {
        const res = await chat(key, {
          model: slug,
          messages: [{ role: 'user', content: 'Hello' }],
        });
        assert.equal(res.response.status, 200, `${slug}: ${res.text}`);
        assert.equal(res.body.choices[0].message.content, 'Hello from the DiRouter mock provider.');
      }
    },
  );
}
