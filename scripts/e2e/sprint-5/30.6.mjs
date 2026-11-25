/**
 * Card 30.6: video generation as an async task through Traefik. The official OpenAI SDK takes a
 * video from creation to its content on the mock's OpenAI Videos and fal queue; only a completed
 * task reaches the ledger; a signed webhook reaches the mock's receiver after a failed attempt and
 * verifies with the SDK.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { published, request, root, sql, urls, waitFor } from '../harness.mjs';

const MP4_HEAD = '0000001c66747970';

export async function register({ scenario, cleanups, org, createKey }) {
  const require = createRequire(join(root, 'apps/gateway/package.json'));
  const { default: OpenAI } = require('openai');
  const tag = randomUUID().slice(0, 6);
  let made = 0;
  const mock = (method, path, body) =>
    request(
      `${urls.mock}${path}`,
      {
        method,
        ...(body
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      },
      200,
    );

  async function videoModel(type, baseUrl, upstreamModel, pricing, options = {}) {
    // Unique per call: several scenarios use the same provider type.
    const id = `${type}-${tag}-${String(++made)}`;
    const provider = (
      await published(() =>
        org(
          'POST',
          'providers',
          {
            name: `s5-video-${id}`,
            slug: `s5-video-${id}`,
            type,
            baseUrl,
            options,
            credentials: [{ name: 'k', secret: 'sk-mock' }],
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
            upstreamModel,
            slug: `s5-video-${id}`,
            pricing: { inputPerMTok: '0', outputPerMTok: '0', ...pricing },
            capabilities: { video: true },
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `models/${model.id}`, undefined, null));
    return model;
  }

  const until = async (client, id, statuses) => {
    let video;
    await waitFor(`video ${id} to end`, async () => {
      video = await client.videos.retrieve(id);
      return statuses.includes(video.status);
    });
    return video;
  };

  await scenario(
    '30.6 a video goes from creation to content through DiRouter; only completed tasks are billed',
    async () => {
      const model = await videoModel('openai', 'http://mock-provider:8090/v1', 'sora-2', {
        perSecondUsd: '0.1',
        perRequestUsd: '0.05',
      });
      const key = await createKey('video');
      const client = new OpenAI({ apiKey: key.key, baseURL: `${urls.gateway}/v1`, maxRetries: 0 });
      const created = await client.videos.create({
        model: model.slug,
        prompt: 'a fox',
        seconds: '8',
      });
      assert.equal(created.status, 'queued');
      const done = await until(client, created.id, ['completed', 'failed']);
      assert.equal(done.status, 'completed');
      const bytes = Buffer.from(
        await (await client.videos.downloadContent(created.id)).arrayBuffer(),
      );
      assert.ok(bytes.toString('hex').startsWith(MP4_HEAD));

      const failed = await client.videos.create({ model: model.slug, prompt: 'mock:fail' });
      assert.equal((await until(client, failed.id, ['completed', 'failed'])).status, 'failed');

      await waitFor(
        'both tasks in the request log',
        async () =>
          Number(
            await sql(
              `SELECT count(*) FROM request_log WHERE id IN ('${created.id}', '${failed.id}')`,
            ),
          ) === 2,
      );
      const rows = await sql(
        `SELECT id, status, cost_usd, inbound_api FROM request_log WHERE id IN ('${created.id}', '${failed.id}') ORDER BY status DESC`,
      );
      assert.match(rows, new RegExp(`${created.id}\\|success\\|0\\.85000000\\|openai\\.videos`));
      assert.match(rows, new RegExp(`${failed.id}\\|error\\|0\\.00000000\\|openai\\.videos`));
      assert.equal(
        Number(await sql(`SELECT cost_usd FROM usage_ledger WHERE request_id = '${created.id}'`)),
        0.85,
      );
    },
  );

  await scenario(
    '30.6 the fal queue runs a video; content comes from its CDN without the key',
    async () => {
      const model = await videoModel(
        'fal',
        'http://mock-provider:8090',
        'fal-ai/veo3',
        { perSecondUsd: '0.5' },
        { queueBaseUrl: 'http://mock-provider:8090/fal-queue' },
      );
      const key = await createKey('video-fal');
      const client = new OpenAI({ apiKey: key.key, baseURL: `${urls.gateway}/v1`, maxRetries: 0 });
      const created = await client.videos.create({ model: model.slug, prompt: 'waves' });
      assert.equal((await until(client, created.id, ['completed', 'failed'])).status, 'completed');
      const bytes = Buffer.from(
        await (await client.videos.downloadContent(created.id)).arrayBuffer(),
      );
      assert.ok(bytes.toString('hex').startsWith(MP4_HEAD));
    },
  );

  await scenario(
    '30.6 a signed webhook arrives after a failed attempt and verifies with the OpenAI SDK',
    async () => {
      const model = await videoModel('openai', 'http://mock-provider:8090/v1', 'sora-2', {
        perSecondUsd: '0.1',
      });
      const key = await createKey('video-hook');
      const client = new OpenAI({ apiKey: key.key, baseURL: `${urls.gateway}/v1`, maxRetries: 0 });
      const name = `s5-${tag}`;
      // The mock's webhook sink answers the first delivery with 500.
      await mock('PUT', `/__hooks/${name}/fail`, { count: 1 });
      const created = await client.videos.create({
        model: model.slug,
        prompt: 'hooked',
        webhook_url: `http://mock-provider:8090/__hooks/${name}`,
      });
      await until(client, created.id, ['completed', 'failed']);
      let hooks = [];
      // The first retry comes 5 seconds after the failed attempt.
      await waitFor(
        'the webhook to be delivered after one failure',
        async () => {
          hooks = (await mock('GET', `/__hooks/${name}`)).body;
          return hooks.some((h) => h.status === 204);
        },
        60_000,
      );
      assert.deepEqual(
        hooks.map((h) => h.status),
        [500, 204],
      );
      const { secret } = (
        await request(
          `${urls.gateway}/v1/webhooks/secret`,
          { headers: { authorization: `Bearer ${key.key}` } },
          200,
        )
      ).body;
      const event = await client.webhooks.unwrap(hooks[1].body, hooks[1].headers, secret);
      assert.equal(event.type, 'video.completed');
      assert.equal(event.data.id, created.id);
    },
  );
}
