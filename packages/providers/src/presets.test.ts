/**
 * Card 31.6: a contract test per new preset against mock-provider: a chat answer, a streamed one
 * where the provider streams, and model discovery (the connection test uses the same request).
 */
import type {
  CanonicalRequest,
  CanonicalStreamEvent,
  ModelConfig,
  ProviderConfig,
} from '@dirouter/contracts';
import { buildServer } from '@dirouter/mock-provider/server';
import { SseParser, UnsupportedContentError } from '@dirouter/translator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adapterForProvider,
  oauthTokenPlan,
  parseTokenResponse,
  PRESETS,
  type UpstreamRequest,
} from './index.js';

const mock = buildServer();
let base = '';
beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const address = mock.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => mock.close());

const provider = (preset: string, baseUrl: string, options: Record<string, unknown> = {}) =>
  ({
    id: preset,
    organizationId: 'o',
    slug: preset,
    type: 'openai-compatible',
    name: preset,
    baseUrl,
    enabled: true,
    options: { preset, ...options },
    credentials: [],
  }) satisfies ProviderConfig;

const model = (upstreamModel: string): ModelConfig => ({
  id: 'm',
  organizationId: 'o',
  slug: 'm',
  providerId: 'p',
  upstreamModel,
  enabled: true,
  pricing: { inputPerMTok: '1', outputPerMTok: '1' },
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    reasoning: false,
    jsonMode: false,
    embeddings: false,
  },
});

const request = (stream = false): CanonicalRequest => ({
  inboundApi: 'openai.chat',
  model: 'm',
  system: [{ type: 'text', text: 'Be brief.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  maxOutputTokens: 64,
  stream,
});

const send = (up: UpstreamRequest) =>
  fetch(up.url, { method: up.method, headers: up.headers, ...(up.body ? { body: up.body } : {}) });

async function chat(p: ProviderConfig, upstreamModel: string, apiKey: string) {
  const adapter = adapterForProvider(p);
  const res = await send(
    adapter.buildRequest({ provider: p, model: model(upstreamModel), apiKey, request: request() }),
  );
  expect(res.status).toBeLessThan(300);
  return adapter.parseResponse(await res.json(), upstreamModel);
}

async function stream(p: ProviderConfig, upstreamModel: string, apiKey: string) {
  const adapter = adapterForProvider(p);
  const res = await send(
    adapter.buildRequest({
      provider: p,
      model: model(upstreamModel),
      apiKey,
      request: request(true),
    }),
  );
  expect(res.status).toBe(200);
  const parser = new SseParser();
  const decoder = adapter.createStreamDecoder(upstreamModel);
  const events: CanonicalStreamEvent[] = [];
  for (const event of [...parser.feed(await res.text()), ...parser.flush()])
    events.push(...decoder.push(event));
  return events;
}

async function discover(p: ProviderConfig, apiKey: string) {
  const adapter = adapterForProvider(p);
  const res = await send(adapter.listModelsRequest(p, apiKey));
  expect(res.status).toBe(200);
  return adapter.parseModelList(await res.json(), p);
}

const MOCK_TEXT = 'Hello from the DiRouter mock provider.';
const textOf = (events: CanonicalStreamEvent[]) =>
  events.map((e) => (e.type === 'text_delta' ? e.text : '')).join('');

describe('OpenAI-compatible presets on their own paths', () => {
  const cases: [string, () => ProviderConfig, string, string[]][] = [
    [
      'perplexity',
      () => provider('perplexity', base),
      'sonar',
      ['mock-small', 'sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'],
    ],
    [
      'deepinfra',
      () => provider('deepinfra', `${base}/v1/openai`),
      'meta-llama/Llama-3.3-70B-Instruct',
      ['meta-llama/Llama-3.3-70B-Instruct'],
    ],
    [
      'nvidia',
      () => provider('nvidia', `${base}/v1`),
      'meta/llama-3.1-70b-instruct',
      ['mock-small'],
    ],
    [
      'huggingface',
      () => provider('huggingface', `${base}/v1`),
      'meta-llama/Llama-3.1-8B-Instruct:novita',
      ['mock-small'],
    ],
    [
      'databricks',
      () => provider('databricks', `${base}/serving-endpoints`),
      'databricks-meta-llama-3-3-70b-instruct',
      ['databricks-meta-llama-3-3-70b-instruct', 'my-finetuned-endpoint'],
    ],
  ];

  it.each(cases)('%s: chat, stream and discovery', async (name, make, upstream, models) => {
    expect(PRESETS[name]).toBeDefined();
    const p = make();
    const answer = await chat(p, upstream, 'sk-test');
    expect(answer.content).toEqual([{ type: 'text', text: MOCK_TEXT }]);
    expect(answer.usage?.inputTokens).toBeGreaterThan(0);
    expect(textOf(await stream(p, upstream, 'sk-test'))).toBe(MOCK_TEXT);
    const discovered = await discover(p, 'sk-test');
    for (const id of models) expect(discovered).toContain(id);
  });

  it('default base URLs point at the providers', () => {
    expect(PRESETS.perplexity?.baseUrl).toBe('https://api.perplexity.ai');
    expect(PRESETS.deepinfra?.baseUrl).toBe('https://api.deepinfra.com/v1/openai');
    expect(PRESETS.nvidia?.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(PRESETS.huggingface?.baseUrl).toBe('https://router.huggingface.co/v1');
    expect(
      PRESETS.databricks?.modelsUrl?.('https://w.cloud.databricks.com/serving-endpoints'),
    ).toBe('https://w.cloud.databricks.com/api/2.0/serving-endpoints');
    expect(PRESETS.perplexity?.modelsUrl?.('https://api.perplexity.ai')).toBe(
      'https://api.perplexity.ai/v1/models',
    );
  });
});

describe('replicate', () => {
  const p = () => provider('replicate', `${base}/v1`);

  it('a prediction with the conversation as a prompt, latest or pinned version', async () => {
    const adapter = adapterForProvider(p());
    const built = adapter.buildRequest({
      provider: p(),
      model: model('meta/meta-llama-3-70b-instruct'),
      apiKey: 'r8_test',
      request: {
        ...request(),
        temperature: 0.5,
        stop: ['END'],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
          { role: 'user', content: [{ type: 'text', text: 'Bye' }] },
        ],
      },
    });
    expect(built.url).toBe(`${base}/v1/models/meta/meta-llama-3-70b-instruct/predictions`);
    expect(built.headers.prefer).toBe('wait=60');
    expect(JSON.parse(built.body ?? '{}')).toEqual({
      input: {
        prompt: 'User: Hi\n\nAssistant: Hello\n\nUser: Bye\n\nAssistant:',
        system_prompt: 'Be brief.',
        max_tokens: 64,
        temperature: 0.5,
        stop_sequences: 'END',
      },
    });
    const answer = await chat(p(), 'meta/meta-llama-3-70b-instruct', 'r8_test');
    expect(answer.content).toEqual([{ type: 'text', text: MOCK_TEXT }]);
    expect(answer.usage?.outputTokens).toBeGreaterThan(0);
    const pinned = await chat(p(), 'meta/meta-llama-3-70b-instruct:5a6809ca', 'r8_test');
    expect(pinned.model).toBe('pinned-version');
    expect(await discover(p(), 'r8_test')).toEqual([
      'meta/meta-llama-3-70b-instruct',
      'ibm-granite/granite-3.3-8b-instruct',
    ]);
  });

  it('streams, tools and images are refused clearly; a failed prediction is an error', () => {
    const adapter = adapterForProvider(p());
    const build = (req: CanonicalRequest) =>
      adapter.buildRequest({ provider: p(), model: model('a/b'), apiKey: 'k', request: req });
    expect(() => build(request(true))).toThrow(UnsupportedContentError);
    expect(() =>
      build({ ...request(), tools: [{ name: 'f', parameters: { type: 'object' } }] }),
    ).toThrow('Replicate language models take no tools');
    expect(() =>
      build({
        ...request(),
        messages: [
          { role: 'user', content: [{ type: 'image', source: { kind: 'url', url: 'https://x' } }] },
        ],
      }),
    ).toThrow(UnsupportedContentError);
    expect(() => adapter.parseResponse({ status: 'failed', error: 'OOM' })).toThrow(
      'Replicate prediction failed: OOM',
    );
    expect(adapter.createStreamDecoder().push({ data: '{}' })[0]?.type).toBe('error');
  });
});

describe('watsonx', () => {
  const p = (options: Record<string, unknown> = { projectId: 'proj-1' }) =>
    provider('watsonx', base, { tokenUrl: `${base}/identity/token`, ...options });

  async function token(apiKey: string) {
    const plan = oauthTokenPlan(p(), 'cred', apiKey);
    expect(plan?.kind).toBe('ibm-iam');
    const res = await send(plan?.build(Date.now()) as UpstreamRequest);
    return parseTokenResponse(res.status, await res.json(), Date.now()).token;
  }

  it('an IAM token from the API key, then chat, stream and discovery', async () => {
    const bearer = await token('ibm-api-key');
    const answer = await chat(p(), 'ibm/granite-3-8b-instruct', bearer);
    expect(answer.content).toEqual([{ type: 'text', text: MOCK_TEXT }]);
    expect(answer.model).toBe('ibm/granite-3-8b-instruct');
    const events = await stream(p(), 'ibm/granite-3-8b-instruct', bearer);
    expect(textOf(events)).toBe(MOCK_TEXT);
    expect(events.some((e) => e.type === 'usage')).toBe(true);
    expect(await discover(p(), bearer)).toEqual([
      'ibm/granite-3-8b-instruct',
      'meta-llama/llama-3-3-70b-instruct',
    ]);
  });

  it('the body names model_id and the project; without a project it is not built', () => {
    const adapter = adapterForProvider(p({ spaceId: 'space-1' }));
    const built = adapter.buildRequest({
      provider: p({ spaceId: 'space-1' }),
      model: model('ibm/granite'),
      apiKey: 't',
      request: request(),
    });
    expect(built.url).toBe(`${base}/ml/v1/text/chat?version=2024-10-08`);
    expect(JSON.parse(built.body ?? '{}')).toMatchObject({
      model_id: 'ibm/granite',
      space_id: 'space-1',
      max_tokens: 64,
    });
    expect(() =>
      adapter.buildRequest({ provider: p({}), model: model('x'), apiKey: 't', request: request() }),
    ).toThrow('options.projectId');
  });
});

describe('sagemaker', () => {
  const p = () =>
    provider('sagemaker', base, {
      region: 'eu-west-1',
      controlUrl: `${base}/`,
      containerModel: 'tgi',
    });
  const key = 'AKIAEXAMPLEKEYID:example-secret-value';

  it('a SigV4-signed invocation of the endpoint, and ListEndpoints for discovery', async () => {
    const adapter = adapterForProvider(p());
    const built = adapter.buildRequest({
      provider: p(),
      model: model('llama-3-tgi'),
      apiKey: key,
      request: request(),
    });
    expect(built.url).toBe(`${base}/endpoints/llama-3-tgi/invocations`);
    expect(built.headers.authorization).toMatch(/\/eu-west-1\/sagemaker\/aws4_request/);
    expect(JSON.parse(built.body ?? '{}')).toMatchObject({ model: 'tgi', max_tokens: 64 });
    const answer = await chat(p(), 'llama-3-tgi', key);
    expect(answer.content).toEqual([{ type: 'text', text: MOCK_TEXT }]);
    expect(await discover(p(), key)).toEqual(['llama-3-tgi', 'mistral-lmi']);
  });

  it('streams are refused clearly', () => {
    expect(() =>
      adapterForProvider(p()).buildRequest({
        provider: p(),
        model: model('e'),
        apiKey: key,
        request: request(true),
      }),
    ).toThrow('SageMaker models answer without streaming');
  });
});
