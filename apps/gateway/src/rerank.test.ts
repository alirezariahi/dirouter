/**
 * Rerank (card 30.2): the official Cohere SDK (v1 and v2 clients) works with DiRouter by changing
 * the base URL; Cohere, Jina and Voyage targets (mocked) are priced per search unit or per token,
 * and the key's rate limit applies.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { CohereClient, CohereClientV2 } from 'cohere-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRerank } from './rerank.js';
import { buildGateway } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-rerank-key-00001';
const LIMITED = 'dr-rerank-limit-0001';

const documents = [
  'Paris is the capital of France',
  'Tehran is the capital of Iran',
  'Iran exports pistachios',
];

describe('rerank', () => {
  const mock = buildMock();
  const usage: UsageEvent[] = [];
  let gw: ReturnType<typeof buildGateway>;
  let base = '';

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const root = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const keyring = parseKeyring(generateKey());
    const provider = (id: 'cohere' | 'jina' | 'voyage', baseUrl: string) => ({
      id,
      organizationId: 'org',
      slug: id,
      type: id,
      name: id,
      baseUrl,
      enabled: true,
      options: {},
      credentials: [
        { id: `${id}-k`, name: 'k', secret: encrypt(keyring, 'secret', `${id}-k`), enabled: true },
      ],
    });
    const model = (
      slug: string,
      providerId: string,
      pricing: Record<string, string>,
      rerank = true,
    ) => ({
      id: `m-${slug}`,
      organizationId: 'org',
      slug,
      providerId,
      upstreamModel: `${slug}-upstream`,
      enabled: true,
      pricing: { inputPerMTok: '0', outputPerMTok: '0', ...pricing },
      capabilities: {
        streaming: false,
        tools: false,
        vision: false,
        reasoning: false,
        jsonMode: false,
        embeddings: !rerank,
        rerank,
      },
    });
    const key = (id: string, raw: string, extra = {}) => ({
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
        provider('cohere', root),
        provider('jina', `${root}/v1`),
        provider('voyage', `${root}/v1`),
      ],
      models: [
        model('rerank-v3.5', 'cohere', { perSearchUsd: '0.002' }),
        model('jina-reranker', 'jina', { inputPerMTok: '0.02' }),
        model('rerank-2', 'voyage', { inputPerMTok: '0.05' }),
        model('embed-only', 'jina', { inputPerMTok: '0.02' }, false),
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        key('vk', KEY),
        key('vk-limited', LIMITED, { rateLimit: { requestsPerMinute: 1 } }),
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-rerank-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({ logger, keyring, pepper, dataDir, emitUsage: (e) => usage.push(e) });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  });
  afterAll(async () => {
    await gw.app.close();
    await mock.close();
  });

  const post = (path: string, body: unknown, key = KEY) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('the Cohere v2 SDK reranks through DiRouter, billed per search unit', async () => {
    const cohere = new CohereClientV2({ token: KEY, environment: base });
    const res = await cohere.rerank({
      model: 'rerank-v3.5',
      query: 'capital of Iran',
      documents,
      topN: 2,
    });
    expect(res.results.map((r) => r.index)).toEqual([1, 0]);
    expect(res.results[0]?.relevanceScore).toBe(1);
    expect(res.meta?.billedUnits?.searchUnits).toBe(1);
    const event = usage.at(-1);
    expect(event).toMatchObject({
      inboundApi: 'rerank',
      requestedModel: 'rerank-v3.5',
      resolvedModelId: 'm-rerank-v3.5',
      status: 'success',
      media: { searches: 1 },
      costUsd: '0.00200000',
    });
  });

  it('the Cohere v1 SDK gets the documents back', async () => {
    const cohere = new CohereClient({ token: KEY, environment: base });
    const res = await cohere.rerank({
      model: 'rerank-v3.5',
      query: 'Iran',
      documents: documents.map((text) => ({ text })),
      returnDocuments: true,
    });
    expect(res.results).toHaveLength(3);
    expect(res.results[0]?.document?.text).toMatch(/Iran/);
  });

  it('Jina and Voyage targets answer the Jina shape, billed per token', async () => {
    const jina = await post('/v1/rerank', {
      model: 'jina-reranker',
      query: 'capital of Iran',
      documents,
      top_n: 1,
    });
    expect(jina.status).toBe(200);
    const body = (await jina.json()) as {
      model: string;
      results: { index: number; relevance_score: number; document?: { text: string } }[];
      usage: { total_tokens: number };
    };
    expect(body.model).toBe('jina-reranker');
    expect(body.results).toEqual([
      { index: 1, relevance_score: 1, document: { text: documents[1] } },
    ]);
    const tokens = body.usage.total_tokens;
    expect(tokens).toBeGreaterThan(0);
    const event = usage.at(-1);
    expect(event?.usage.inputTokens).toBe(tokens);
    expect(event?.costUsd).toBe(((tokens * 0.02) / 1e6).toFixed(8));

    const voyage = await post('/v1/rerank', {
      model: 'rerank-2',
      query: 'pistachios',
      documents,
      top_k: 1,
      return_documents: false,
    });
    const v = (await voyage.json()) as { results: { index: number; document?: unknown }[] };
    expect(v.results).toEqual([{ index: 2, relevance_score: 1 }]);
    expect(usage.at(-1)?.resolvedModelId).toBe('m-rerank-2');
  });

  it("applies the key's rate limit", async () => {
    const cohere = new CohereClientV2({ token: LIMITED, environment: base });
    await cohere.rerank({ model: 'rerank-v3.5', query: 'a', documents: ['a'] });
    await expect(
      cohere.rerank({ model: 'rerank-v3.5', query: 'a', documents: ['a'] }, { maxRetries: 0 }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it('refuses models without the rerank capability and bad input', async () => {
    expect(
      (await post('/v1/rerank', { model: 'embed-only', query: 'a', documents: ['a'] })).status,
    ).toBe(400);
    expect(
      (await post('/v1/rerank', { model: 'jina-reranker', query: 'a', documents: [] })).status,
    ).toBe(422);
    expect((await post('/v1/rerank', { model: 'nope', query: 'a', documents: ['a'] })).status).toBe(
      404,
    );
    expect(
      (
        await fetch(`${base}/v2/rerank`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'rerank-v3.5', query: 'a', documents: ['a'] }),
        })
      ).status,
    ).toBe(401);
  });
});

describe('rerank input', () => {
  it('reads Cohere and Jina forms', () => {
    expect(
      parseRerank(
        {
          model: 'm',
          query: 'q',
          documents: [{ title: 'T', body: 'B' }],
          rank_fields: ['title', 'body'],
        },
        'v1',
      ).documents,
    ).toEqual(['title: T\nbody: B']);
    expect(parseRerank({ model: 'm', query: 'q', documents: ['a', 'b'], top_n: 5 }, 'v2')).toEqual({
      model: 'm',
      query: 'q',
      documents: ['a', 'b'],
      topN: 2,
      returnDocuments: false,
    });
    expect(() => parseRerank({ model: 'm', query: 'q', documents: [{}] }, 'v1')).toThrow();
    expect(() =>
      parseRerank({ model: 'm', query: 'q', documents: ['a'], top_n: 0 }, 'v1'),
    ).toThrow();
  });
});
