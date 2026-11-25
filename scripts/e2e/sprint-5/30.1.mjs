/**
 * Card 30.1: Files API and Batch API through Traefik. The official OpenAI SDK (the gateway's
 * dev dependency) uploads a batch file, runs a batch on the mock's OpenAI batch API and reads the
 * results; the ledger holds the batch at the discounted price; another organization's key sees
 * nothing.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { published, request, root, sql, urls, waitFor } from '../harness.mjs';

const OTHER_ORG = 'org_s5_batch_other';

export async function register({ scenario, cleanups, api, org, createKey }) {
  const require = createRequire(join(root, 'apps/gateway/package.json'));
  const { default: OpenAI, toFile } = require('openai');
  const tag = randomUUID().slice(0, 6);
  let made = 0;

  /** A provider backed by the mock and a model on it with a 50% batch discount. */
  async function batchModel(type, baseUrl, upstreamModel) {
    // Unique per call: several scenarios use the same provider type.
    const id = `${type}-${tag}-${String(++made)}`;
    const provider = (
      await published(() =>
        org(
          'POST',
          'providers',
          {
            name: `s5-batch-${id}`,
            slug: `s5-batch-${id}`,
            type,
            baseUrl,
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
            slug: `s5-batch-${id}`,
            pricing: { inputPerMTok: '2', outputPerMTok: '8', batchDiscount: '0.5' },
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `models/${model.id}`, undefined, null));
    return model;
  }

  const line = (id, model, text) =>
    JSON.stringify({
      custom_id: id,
      method: 'POST',
      url: '/v1/chat/completions',
      body: { model, messages: [{ role: 'user', content: text }], max_tokens: 30 },
    });

  async function runBatch(client, lines) {
    const file = await client.files.create({
      file: await toFile(Buffer.from(`${lines.join('\n')}\n`), 'input.jsonl'),
      purpose: 'batch',
    });
    const batch = await client.batches.create({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
    let done = batch;
    await waitFor(`batch ${batch.id} to complete`, async () => {
      done = await client.batches.retrieve(batch.id);
      return ['completed', 'failed', 'cancelled', 'expired'].includes(done.status);
    });
    return { file, batch: done };
  }

  await scenario(
    '30.1 the OpenAI SDK runs a batch through DiRouter; the ledger holds it at the batch discount',
    async () => {
      const model = await batchModel('openai', 'http://mock-provider:8090/v1', 'gpt-4o-mini');
      const key = await createKey('batch');
      const client = new OpenAI({ apiKey: key.key, baseURL: `${urls.gateway}/v1`, maxRetries: 0 });
      const { batch } = await runBatch(client, [
        line('first', model.slug, 'Hello'),
        line('second', model.slug, 'mock:fail'),
      ]);
      assert.equal(batch.status, 'completed');
      assert.deepEqual(batch.request_counts, { total: 2, completed: 1, failed: 1 });
      const output = (await (await client.files.content(batch.output_file_id)).text()).trim();
      const result = JSON.parse(output);
      assert.equal(result.custom_id, 'first');
      assert.equal(result.response.body.model, model.slug);
      assert.match(await (await client.files.content(batch.error_file_id)).text(), /second/);

      // usage at 2/8 USD per million tokens, halved.
      const usage = result.response.body.usage;
      const expected = ((usage.prompt_tokens * 2 + usage.completion_tokens * 8) / 1e6) * 0.5;
      await waitFor(
        'the batch in the ledger',
        async () =>
          Number(
            await sql(`SELECT count(*) FROM usage_ledger WHERE request_id = '${batch.id}'`),
          ) === 1,
      );
      const cost = Number(
        await sql(`SELECT cost_usd FROM usage_ledger WHERE request_id = '${batch.id}'`),
      );
      assert.ok(Math.abs(cost - expected) < 1e-8, `ledger ${cost}, expected ${expected}`);
      const api = await sql(`SELECT inbound_api FROM request_log WHERE id = '${batch.id}' LIMIT 1`);
      assert.equal(api, 'openai.batches');
    },
  );

  await scenario('30.1 Anthropic message batches answer as chat completions', async () => {
    const model = await batchModel('anthropic', 'http://mock-provider:8090', 'claude-sonnet-4');
    const key = await createKey('batch-anthropic');
    const client = new OpenAI({ apiKey: key.key, baseURL: `${urls.gateway}/v1`, maxRetries: 0 });
    const { batch } = await runBatch(client, [line('only', model.slug, 'Hi')]);
    assert.equal(batch.status, 'completed');
    const result = JSON.parse(
      (await (await client.files.content(batch.output_file_id)).text()).trim(),
    );
    assert.equal(result.response.body.object, 'chat.completion');
    assert.equal(result.response.body.choices[0].message.content, 'Batch reply to only');
  });

  await scenario("30.1 another organization's key gets 404 for files and batches", async () => {
    const model = await batchModel('openai', 'http://mock-provider:8090/v1', 'gpt-4o-mini');
    const owner = await createKey('batch-owner');
    const client = new OpenAI({ apiKey: owner.key, baseURL: `${urls.gateway}/v1`, maxRetries: 0 });
    const { file, batch } = await runBatch(client, [line('x', model.slug, 'private')]);

    // A key of another organization (created here, kept between runs).
    const me = (await api('GET', 'auth/me')).body;
    await sql(`INSERT INTO organizations (id, name, slug, updated_at)
               VALUES ('${OTHER_ORG}', 'Sprint 5 batch other', 's5-batch-other', now()) ON CONFLICT DO NOTHING;
               INSERT INTO memberships (id, user_id, organization_id, role)
               VALUES ('mem_s5_batch_other', '${me.id}', '${OTHER_ORG}', 'OWNER') ON CONFLICT DO NOTHING`);
    const other = (method, path, body, expected) =>
      api(method, `orgs/${OTHER_ORG}/${path}`, body, expected);
    const project = (
      await other('POST', 'projects', { name: `S5 batch ${tag}`, slug: `s5-batch-${tag}` }, 201)
    ).body;
    cleanups.push(() => other('DELETE', `projects/${project.id}`, undefined, null));
    const foreign = (
      await published(() =>
        other('POST', 'keys', { name: `s5-batch-other-${tag}`, projectId: project.id }, 201),
      )
    ).body;
    cleanups.push(() => other('POST', `keys/${foreign.id}/revoke`, undefined, null));
    const headers = { authorization: `Bearer ${foreign.key}` };
    for (const path of [
      `files/${file.id}`,
      `files/${file.id}/content`,
      `files/${batch.output_file_id}/content`,
      `batches/${batch.id}`,
    ])
      await request(`${urls.gateway}/v1/${path}`, { headers }, 404);
    await request(
      `${urls.gateway}/v1/batches/${batch.id}/cancel`,
      { method: 'POST', headers },
      404,
    );
    await request(`${urls.gateway}/v1/files/${file.id}`, { method: 'DELETE', headers }, 404);
    const listed = (await request(`${urls.gateway}/v1/files`, { headers }, 200)).body;
    assert.ok(!listed.data.some((f) => f.id === file.id));
    const batches = (await request(`${urls.gateway}/v1/batches`, { headers }, 200)).body;
    assert.ok(!batches.data.some((b) => b.id === batch.id));
    // The owner's file is untouched.
    assert.equal((await client.files.retrieve(file.id)).id, file.id);
  });
}
