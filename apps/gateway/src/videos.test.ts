/**
 * Async video tasks with webhooks (card 30.6): the OpenAI SDK takes a video from creation to its
 * content through DiRouter on three providers (OpenAI-shaped, Google Veo and fal, all mocked),
 * only a completed task is billed, and webhooks arrive signed (verified with the OpenAI SDK) and
 * are retried.
 *
 * The SDK marks its Videos resource deprecated because OpenAI shut its own Sora API down; the
 * shape is what DiRouter serves, so the deprecation does not apply here.
 */
/* eslint-disable @typescript-eslint/no-deprecated */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { Redis } from 'ioredis';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signWebhook, webhookSecret } from './jobs/webhooks.js';
import { buildGateway } from './server.js';
import { taskAmounts } from './videos.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-video-key-00001';
const OTHER = 'dr-video-other-0001';
const ZDR_KEY = 'dr-video-zdr-key-001';
const MODEL_BUDGET_KEY = 'dr-video-mbudget-001';
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const MP4_HEAD = '0000001c66747970';

interface Delivery {
  headers: IncomingHttpHeaders;
  body: string;
}

describe('video tasks', () => {
  const mock = buildMock();
  const usage: UsageEvent[] = [];
  const deliveries: Delivery[] = [];
  /** Status codes the webhook receiver answers with, in order; then 200. */
  const answers: number[] = [];
  const receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      deliveries.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.statusCode = answers.shift() ?? 200;
      res.end();
    });
  });
  let hook = '';
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  let mockRoot = '';
  let client: OpenAI;
  let other: OpenAI;
  /** Budgets and rate limits on Valkey, with INTEGRATION_VALKEY_URL. */
  let limiterRedis: Redis | undefined;

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    const ra = receiver.address();
    hook = `http://127.0.0.1:${String(typeof ra === 'object' && ra ? ra.port : 0)}/hooks`;
    const keyring = parseKeyring(generateKey());
    const provider = (id: 'openai' | 'fal' | 'gemini', baseUrl: string, options = {}) => ({
      id,
      organizationId: 'org',
      slug: id,
      type: id,
      name: id,
      baseUrl,
      enabled: true,
      options,
      credentials: [
        { id: `${id}-k`, name: 'k', secret: encrypt(keyring, 'secret', `${id}-k`), enabled: true },
      ],
    });
    const caps = {
      streaming: false,
      tools: false,
      vision: false,
      reasoning: false,
      jsonMode: false,
      embeddings: false,
    };
    const model = (
      slug: string,
      providerId: string,
      upstreamModel: string,
      pricing: Record<string, string>,
      video = true,
    ) => ({
      id: `m-${slug}`,
      organizationId: 'org',
      slug,
      providerId,
      upstreamModel,
      enabled: true,
      pricing: { inputPerMTok: '0', outputPerMTok: '0', ...pricing },
      capabilities: { ...caps, video },
    });
    const key = (id: string, raw: string, organizationId: string) => ({
      id,
      hash: hashApiKey(raw, pepper),
      prefix: id,
      organizationId,
      teamId: null,
      projectId: `prj-${organizationId}`,
      enabled: true,
      expiresAt: null,
      allowedModels: [],
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        provider('openai', `${mockRoot}/v1`),
        provider('fal', mockRoot, { queueBaseUrl: `${mockRoot}/fal-queue` }),
        provider('gemini', mockRoot),
      ],
      models: [
        model('sora-2', 'openai', 'sora-2', { perSecondUsd: '0.1', perRequestUsd: '0.05' }),
        model('veo', 'fal', 'fal-ai/veo3', { perSecondUsd: '0.5' }),
        model('veo-google', 'gemini', 'veo-3.0-generate-001', { perSecondUsd: '0.4' }),
        model('chat', 'openai', 'gpt-4o-mini', { inputPerMTok: '1' }, false),
        model('sora-budget', 'openai', 'sora-2', { perSecondUsd: '0.1', perRequestUsd: '0.05' }),
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        key('vk', KEY, 'org'),
        key('vk-other', OTHER, 'org-b'),
        key('vk-zdr', ZDR_KEY, 'org'),
        key('vk-mbudget', MODEL_BUDGET_KEY, 'org'),
      ],
      // A "ZDR only" key (card 32.5); none of the video providers offers zero data retention.
      routingPolicies: [
        {
          organizationId: 'org',
          scope: 'key',
          scopeId: 'vk-zdr',
          dataPolicy: { requireZdr: true },
        },
      ],
      limits: [
        { organizationId: 'org', scope: 'end_user', scopeId: 'banned', blocked: true, budgets: [] },
        {
          organizationId: 'org',
          scope: 'model',
          scopeId: 'm-sora-budget',
          budgets: [{ id: `vb-${randomUUID()}`, period: 'daily', limitUsd: '0.5' }],
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-video-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: (e) => usage.push(e),
      jobs: { pollIntervalMs: 0, pollerTickMs: 60_000, webhookRetryDelaysMs: [0, 0] },
      // With INTEGRATION_VALKEY_URL the same flows run on the Valkey job store.
      ...(VALKEY_URL
        ? {
            stateRedis: new Redis(VALKEY_URL),
            limiterRedis: (limiterRedis = new Redis(VALKEY_URL)),
          }
        : {}),
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
    client = new OpenAI({ apiKey: KEY, baseURL: `${base}/v1`, maxRetries: 0 });
    other = new OpenAI({ apiKey: OTHER, baseURL: `${base}/v1`, maxRetries: 0 });
  });
  afterAll(async () => {
    await gw.app.close();
    await mock.close();
    await gw.jobs.stateRedis?.quit();
    await limiterRedis?.quit();
    receiver.close();
  });

  const until = async (id: string, status: string[]) => {
    for (let i = 0; i < 10; i++) {
      const v = await client.videos.retrieve(id);
      if (status.includes(v.status)) return v;
    }
    throw new Error(`video ${id} never reached ${status.join('/')}`);
  };
  const create = (body: Record<string, unknown>, key = KEY) =>
    fetch(`${base}/v1/videos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  /** Runs the poller until the webhook queue is empty. */
  const drainWebhooks = async () => {
    for (let i = 0; i < 10; i++) await gw.poller.tick();
  };

  it('the OpenAI SDK takes a video from creation to its content; it is billed per second and request', async () => {
    const created = await client.videos.create({
      model: 'sora-2',
      prompt: 'A red fox in the snow',
      seconds: '8',
      size: '1280x720',
    });
    expect(created).toMatchObject({
      object: 'video',
      model: 'sora-2',
      status: 'queued',
      seconds: '8',
    });
    expect(created.id).toMatch(/^video_/);
    const done = await until(created.id, ['completed']);
    expect(done.progress).toBe(100);
    const content = Buffer.from(
      await (await client.videos.downloadContent(created.id)).arrayBuffer(),
    );
    expect(content.toString('hex')).toMatch(new RegExp(`^${MP4_HEAD}`));
    const thumbnail = await client.videos.downloadContent(created.id, { variant: 'thumbnail' });
    expect(thumbnail.headers.get('content-type')).toBe('image/webp');
    expect((await client.videos.list()).data.map((v) => v.id)).toContain(created.id);

    const events = usage.filter((e) => e.requestId === created.id);
    expect(events).toHaveLength(1);
    // 8 s × 0.1 + 0.05 per request.
    expect(events[0]).toMatchObject({
      inboundApi: 'openai.videos',
      status: 'success',
      costUsd: '0.85000000',
      chargeUsd: '0.85000000',
      media: { seconds: 8, requests: 1 },
    });
    expect(await client.videos.delete(created.id)).toEqual({
      id: created.id,
      object: 'video.deleted',
      deleted: true,
    });
    await expect(client.videos.retrieve(created.id)).rejects.toMatchObject({ status: 404 });
  });

  it('runs on the fal queue too; the video is fetched from the CDN without the key', async () => {
    const res = await create({ model: 'veo', prompt: 'waves', seconds: 6 });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    await until(id, ['completed']);
    const content = await fetch(`${base}/v1/videos/${id}/content`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer()).toString('hex')).toMatch(
      new RegExp(`^${MP4_HEAD}`),
    );
    // fal has no thumbnail.
    const thumb = await fetch(`${base}/v1/videos/${id}/content?variant=thumbnail`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(thumb.status).toBe(400);
    expect(usage.find((e) => e.requestId === id)).toMatchObject({
      status: 'success',
      costUsd: '3.00000000',
    });
  });

  it('runs on Google Veo through a long-running operation', async () => {
    const res = await create({
      model: 'veo-google',
      prompt: 'a lighthouse',
      seconds: 8,
      size: '1280x720',
    });
    const { id } = (await res.json()) as { id: string };
    await until(id, ['completed']);
    const content = await fetch(`${base}/v1/videos/${id}/content`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer()).toString('hex')).toMatch(
      new RegExp(`^${MP4_HEAD}`),
    );
    expect(usage.find((e) => e.requestId === id)).toMatchObject({
      status: 'success',
      costUsd: '3.20000000',
    });
  });

  it('bills nothing for a failed or cancelled task', async () => {
    const failed = (await (await create({ model: 'sora-2', prompt: 'mock:fail' })).json()) as {
      id: string;
    };
    const v = await until(failed.id, ['failed']);
    expect(v.error).toMatchObject({ code: 'mock_failure' });
    expect(usage.find((e) => e.requestId === failed.id)).toMatchObject({
      status: 'error',
      costUsd: '0.00000000',
      chargeUsd: '0.00000000',
    });
    const content = await fetch(`${base}/v1/videos/${failed.id}/content`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(content.status).toBe(400);

    for (const model of ['sora-2', 'veo', 'veo-google']) {
      const running = (await (await create({ model, prompt: 'long one' })).json()) as {
        id: string;
      };
      const cancelled = await fetch(`${base}/v1/videos/${running.id}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(await cancelled.json()).toMatchObject({
        status: 'failed',
        error: { code: 'cancelled' },
      });
      expect(usage.find((e) => e.requestId === running.id)).toMatchObject({
        status: 'error',
        costUsd: '0.00000000',
        errorCode: 'cancelled',
      });
    }
    const stats = (await (await fetch(`${mockRoot}/__mock/videos`)).json()) as {
      cancelled: number;
    };
    expect(stats.cancelled).toBe(3);
  });

  it('sends a signed webhook when a task ends and retries it after a failure', async () => {
    deliveries.length = 0;
    answers.push(500);
    const res = await create({ model: 'sora-2', prompt: 'with a hook', webhook_url: hook });
    const { id } = (await res.json()) as { id: string };
    await until(id, ['completed']);
    await drainWebhooks();
    expect(deliveries).toHaveLength(2);
    const [first, second] = deliveries as [Delivery, Delivery];
    expect(first.body).toBe(second.body);
    expect(first.headers['webhook-id']).toBe(second.headers['webhook-id']);
    const event = JSON.parse(second.body) as { type: string; object: string; data: { id: string } };
    expect(event).toMatchObject({ object: 'event', type: 'video.completed', data: { id } });

    // The organization's secret verifies the delivery with the OpenAI SDK.
    const { secret } = (await (
      await fetch(`${base}/v1/webhooks/secret`, { headers: { authorization: `Bearer ${KEY}` } })
    ).json()) as { secret: string };
    expect(secret).toMatch(/^whsec_/);
    const headers = second.headers as Record<string, string>;
    const unwrapped = await client.webhooks.unwrap(second.body, headers, secret);
    expect(unwrapped).toMatchObject({ type: 'video.completed', data: { id } });
    // A wrong secret is refused.
    const otherSecret = (await (
      await fetch(`${base}/v1/webhooks/secret`, { headers: { authorization: `Bearer ${OTHER}` } })
    ).json()) as { secret: string };
    expect(otherSecret.secret).not.toBe(secret);
    await expect(
      client.webhooks.unwrap(second.body, headers, otherSecret.secret),
    ).rejects.toThrow();
  });

  it('gives up after the last retry', async () => {
    deliveries.length = 0;
    answers.push(503, 503, 503, 503);
    const { id } = (await (
      await create({ model: 'sora-2', prompt: 'never heard', webhook_url: hook })
    ).json()) as {
      id: string;
    };
    await until(id, ['completed']);
    await drainWebhooks();
    // One attempt and two retries (webhookRetryDelaysMs has two entries).
    expect(deliveries).toHaveLength(3);
    answers.length = 0;
  });

  it('batches announce their end with the same signed webhook', async () => {
    deliveries.length = 0;
    const { toFile } = await import('openai');
    const file = await client.files.create({
      file: await toFile(
        Buffer.from(
          `${JSON.stringify({ custom_id: 'a', method: 'POST', url: '/v1/chat/completions', body: { model: 'chat', messages: [{ role: 'user', content: 'hi' }] } })}\n`,
        ),
        'in.jsonl',
      ),
      purpose: 'batch',
    });
    const res = await fetch(`${base}/v1/batches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        input_file_id: file.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        webhook_url: hook,
      }),
    });
    const batch = (await res.json()) as { id: string };
    for (let i = 0; i < 5; i++) await client.batches.retrieve(batch.id);
    await drainWebhooks();
    expect(deliveries).toHaveLength(1);
    const { secret } = (await (
      await fetch(`${base}/v1/webhooks/secret`, { headers: { authorization: `Bearer ${KEY}` } })
    ).json()) as { secret: string };
    const event = await client.webhooks.unwrap(
      deliveries[0]?.body ?? '',
      deliveries[0]?.headers,
      secret,
    );
    expect(event).toMatchObject({ type: 'batch.completed', data: { id: batch.id } });
  });

  it('refuses webhook URLs that are not http(s) or carry credentials', async () => {
    expect(
      (await create({ model: 'sora-2', prompt: 'x', webhook_url: 'ftp://example.com' })).status,
    ).toBe(400);
    expect(
      (await create({ model: 'sora-2', prompt: 'x', webhook_url: 'https://u:p@example.com/' }))
        .status,
    ).toBe(400);
    expect((await create({ model: 'chat', prompt: 'x' })).status).toBe(400);
    expect((await create({ model: 'sora-2', prompt: 'x', seconds: 999 })).status).toBe(400);
  });

  it("another organization's key cannot see or touch a video", async () => {
    const { id } = (await (await create({ model: 'sora-2', prompt: 'mine' })).json()) as {
      id: string;
    };
    await expect(other.videos.retrieve(id)).rejects.toMatchObject({ status: 404 });
    await expect(other.videos.downloadContent(id)).rejects.toMatchObject({ status: 404 });
    await expect(other.videos.delete(id)).rejects.toMatchObject({ status: 404 });
    const cancel = await fetch(`${base}/v1/videos/${id}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OTHER}` },
    });
    expect(cancel.status).toBe(404);
    expect((await other.videos.list()).data).toEqual([]);
    expect((await client.videos.retrieve(id)).id).toBe(id);
  });

  it('keeps the data policy: a ZDR-only key never sends a video prompt to a provider without ZDR', async () => {
    const before = (
      (await (await fetch(`${mockRoot}/__mock/videos`)).json()) as { created?: number }
    ).created;
    const res = await create({ model: 'sora-2', prompt: 'private', seconds: 4 }, ZDR_KEY);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'no_provider_matches_data_policy',
    );
    const after = (
      (await (await fetch(`${mockRoot}/__mock/videos`)).json()) as { created?: number }
    ).created;
    expect(after).toBe(before);
  });

  it('refuses a blocked end user before anything starts', async () => {
    const res = await fetch(`${base}/v1/videos`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'x-dirouter-end-user': 'banned',
      },
      body: JSON.stringify({ model: 'sora-2', prompt: 'nope' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('end_user_blocked');
  });

  it.skipIf(!VALKEY_URL)(
    "counts a completed video in the model's budget, and refuses new ones once it is used up",
    async () => {
      const first = await create(
        { model: 'sora-budget', prompt: 'one', seconds: 8 },
        MODEL_BUDGET_KEY,
      );
      expect(first.status).toBe(200);
      const { id } = (await first.json()) as { id: string };
      for (let i = 0; i < 10 && !usage.some((e) => e.requestId === id); i++) await gw.poller.tick();
      // 8 s × 0.1 + 0.05 against a $0.50 daily model budget.
      expect(usage.find((e) => e.requestId === id)).toMatchObject({ costUsd: '0.85000000' });
      await new Promise((r) => setTimeout(r, 100));
      const second = await create({ model: 'sora-budget', prompt: 'two' }, MODEL_BUDGET_KEY);
      expect(second.status).toBe(429);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
        'budget_exceeded',
      );
    },
  );

  it('the job poller follows a task nobody polls', async () => {
    const { id } = (await (await create({ model: 'sora-2', prompt: 'background' })).json()) as {
      id: string;
    };
    for (let i = 0; i < 5 && !usage.some((e) => e.requestId === id); i++) await gw.poller.tick();
    expect(usage.find((e) => e.requestId === id)?.status).toBe('success');
  });
});

describe('webhook signatures', () => {
  it('follow the Standard Webhooks scheme with a per-organization secret', () => {
    const keyring = parseKeyring(generateKey());
    const secret = webhookSecret(keyring, 'org-1');
    expect(webhookSecret(keyring, 'org-1')).toBe(secret);
    expect(webhookSecret(keyring, 'org-2')).not.toBe(secret);
    const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
      .update('evt_1.1700000000.{"a":1}')
      .digest('base64');
    expect(signWebhook(secret, 'evt_1', 1_700_000_000, '{"a":1}')).toBe(`v1,${expected}`);
  });
});

describe('task pricing', () => {
  it('adds per-second and per-request prices and the sale multipliers', () => {
    const amounts = taskAmounts(
      {
        pricing: {
          inputPerMTok: '0',
          outputPerMTok: '0',
          perSecondUsd: '0.1',
          perRequestUsd: '0.2',
        },
        sale: { multiplier: '2', cacheMultiplier: '0' },
      },
      4,
      '1.5',
    );
    expect(amounts.costUsd).toBe('0.60000000');
    expect(amounts.chargeUsd).toBe('1.80000000');
  });
});
