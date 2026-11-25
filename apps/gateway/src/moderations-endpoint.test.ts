/**
 * `/v1/moderations` for clients (card 30.3): the official OpenAI SDK works unchanged — default
 * model, a string, an array of strings and multimodal parts — routed to the configured moderation
 * model, with the key's limits and a usage event, and the same verdicts the moderation guardrail
 * uses.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { moderationVerdict, readModerationInput } from './classifiers.js';
import { buildGateway } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-moderations-key-1';
const LIMITED = 'dr-moderations-key-2';

describe('/v1/moderations with the OpenAI SDK', () => {
  const mock = buildMock();
  const usage: UsageEvent[] = [];
  let gw: ReturnType<typeof buildGateway>;
  let client: OpenAI;
  let limited: OpenAI;

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const root = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const keyring = parseKeyring(generateKey());
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
        {
          id: 'openai',
          organizationId: 'org',
          slug: 'openai',
          type: 'openai',
          name: 'openai',
          baseUrl: `${root}/v1`,
          enabled: true,
          options: {},
          credentials: [
            { id: 'k', name: 'k', secret: encrypt(keyring, 'secret', 'k'), enabled: true },
          ],
        },
      ],
      models: [
        {
          id: 'm-omni',
          organizationId: 'org',
          // The SDK's default model name routes like any model.
          slug: 'omni-moderation-latest',
          providerId: 'openai',
          upstreamModel: 'omni-moderation-2024-09-26',
          enabled: true,
          pricing: { inputPerMTok: '1', outputPerMTok: '0' },
          capabilities: {},
        },
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        key('vk', KEY),
        key('vk-limited', LIMITED, { rateLimit: { requestsPerMinute: 1 } }),
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-moderations-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({ logger, keyring, pepper, dataDir, emitUsage: (e) => usage.push(e) });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    const base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}/v1`;
    client = new OpenAI({ apiKey: KEY, baseURL: base, maxRetries: 0 });
    limited = new OpenAI({ apiKey: LIMITED, baseURL: base, maxRetries: 0 });
  });
  afterAll(async () => {
    await gw.app.close();
    await mock.close();
  });

  it('answers a string with the default model', async () => {
    const res = await client.moderations.create({ input: 'how do I kill a process' });
    expect(res.id).toMatch(/^modr-/);
    expect(res.model).toBe('omni-moderation-latest');
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.flagged).toBe(true);
    expect(res.results[0]?.categories.violence).toBe(true);
    expect(res.results[0]?.category_scores.violence).toBeGreaterThan(0.5);
    expect(res.results[0]?.category_applied_input_types.violence).toEqual(['text']);
    // The same verdict the moderation guardrail takes from this answer.
    expect(
      moderationVerdict(
        {
          results: res.results.map((r) => ({
            flagged: r.flagged,
            categories: r.categories as unknown as Record<string, boolean>,
            scores: r.category_scores as unknown as Record<string, number>,
          })),
        },
        { thresholds: {} },
      ),
    ).toMatchObject({ flagged: true, categories: ['violence'] });
  });

  it('answers an array of strings, one result each', async () => {
    const res = await client.moderations.create({
      model: 'omni-moderation-latest',
      input: ['hello there', 'we kill'],
    });
    expect(res.results.map((r) => r.flagged)).toEqual([false, true]);
  });

  it('passes text and image parts to the provider as one input', async () => {
    const res = await client.moderations.create({
      model: 'omni-moderation-latest',
      input: [
        { type: 'text', text: 'a picture of a cat' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.flagged).toBe(false);
    expect(res.results[0]?.category_applied_input_types.violence).toEqual(['text', 'image']);
  });

  it('records usage under the key and applies its rate limit', async () => {
    const events = usage.filter((e) => e.inboundApi === 'openai.moderations');
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]).toMatchObject({
      virtualKeyId: 'vk',
      requestedModel: 'omni-moderation-latest',
      resolvedModelId: 'm-omni',
      status: 'success',
    });
    await limited.moderations.create({ input: 'one' });
    await expect(limited.moderations.create({ input: 'two' })).rejects.toMatchObject({
      status: 429,
    });
  });

  it('refuses input it cannot read and models it does not know', async () => {
    await expect(
      client.moderations.create({ input: [{ type: 'audio' } as never] }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      client.moderations.create({ model: 'text-moderation-stable', input: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('moderation input', () => {
  it('reads strings, arrays and parts', () => {
    expect(readModerationInput('a')).toEqual({ texts: ['a'] });
    expect(readModerationInput(['a', 'b'])).toEqual({ texts: ['a', 'b'] });
    expect(
      readModerationInput([
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ]),
    ).toEqual({
      texts: ['a'],
      parts: [
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(readModerationInput([])).toBeUndefined();
    expect(readModerationInput([{ type: 'image_url' }])).toBeUndefined();
    expect(readModerationInput(3)).toBeUndefined();
  });
});
