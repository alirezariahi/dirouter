/**
 * Files API and Batch API (card 30.1): the official OpenAI SDK runs a batch through DiRouter on
 * OpenAI's and Anthropic's native batch APIs (the mock), the cost lands in usage at the catalog's
 * batch discount, and another organization's key sees none of it.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { computeCostUsd } from '@dirouter/model-catalog';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { encodeMultipart } from '@dirouter/providers';
import {
  createLogger,
  encrypt,
  formatUsd,
  generateKey,
  hashApiKey,
  parseKeyring,
  parseUsd,
} from '@dirouter/shared';
import { Redis } from 'ioredis';
import OpenAI, { toFile } from 'openai';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';

import {
  batchAmounts,
  type BatchRecord,
  lineTokens,
  parseBatchInput,
  refreshBatch,
} from './batches.js';
import { expireFile, type FileRecord } from './files.js';
import { LocalBlobStorage, S3BlobStorage } from './jobs/blobs.js';
import type { JobStore } from './jobs/store.js';
import { buildGateway } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-batch-key-00001';
const OTHER = 'dr-batch-other-0001';
const ZDR = 'dr-batch-zdr-000001';
const GUARDED = 'dr-batch-guard-0001';

const chatLine = (id: string, model: string, text: string) =>
  JSON.stringify({
    custom_id: id,
    method: 'POST',
    url: '/v1/chat/completions',
    body: { model, messages: [{ role: 'user', content: text }], max_tokens: 50 },
  });

describe('files and batches', () => {
  const mock = buildMock();
  const usage: UsageEvent[] = [];
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  let mockRoot = '';
  let client: OpenAI;
  let other: OpenAI;

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const keyring = parseKeyring(generateKey());
    const provider = (id: 'openai' | 'anthropic' | 'deepgram', baseUrl: string) => ({
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
      upstreamModel: string,
      batchDiscount?: string,
    ) => ({
      id: `m-${slug}`,
      organizationId: 'org',
      slug,
      providerId,
      upstreamModel,
      enabled: true,
      pricing: {
        inputPerMTok: '2',
        outputPerMTok: '8',
        ...(batchDiscount ? { batchDiscount } : {}),
      },
      capabilities: {
        streaming: true,
        tools: false,
        vision: false,
        reasoning: false,
        jsonMode: false,
        embeddings: true,
      },
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
        provider('anthropic', mockRoot),
        provider('deepgram', `${mockRoot}/v1`),
      ],
      models: [
        model('gpt-batch', 'openai', 'gpt-4o-mini', '0.5'),
        model('claude-batch', 'anthropic', 'claude-sonnet-4', '0.5'),
        model('nova-batch', 'deepgram', 'nova-3'),
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        key('vk', KEY, 'org'),
        key('vk-other', OTHER, 'org-b'),
        key('vk-zdr', ZDR, 'org'),
        key('vk-guard', GUARDED, 'org'),
      ],
      // Card 32.5: this key's data may only go to zero-retention providers (none here).
      routingPolicies: [
        {
          organizationId: 'org',
          scope: 'key',
          scopeId: 'vk-zdr',
          dataPolicy: { requireZdr: true },
        },
      ],
      // Card 33.2: a blocked end user.
      limits: [
        {
          organizationId: 'org',
          scope: 'end_user',
          scopeId: 'mallory',
          budgets: [],
          blocked: true,
        },
      ],
      // Card 15.1: the guarded key blocks one word and redacts the mock's failure marker.
      guardrails: [
        {
          id: 'g-block',
          organizationId: 'org',
          virtualKeyId: 'vk-guard',
          name: 'no forbidden',
          enabled: true,
          stage: 'request',
          type: 'regex',
          config: { pattern: 'forbidden' },
          action: 'block',
        },
        {
          id: 'g-redact',
          organizationId: 'org',
          virtualKeyId: 'vk-guard',
          name: 'no failure marker',
          enabled: true,
          stage: 'request',
          type: 'regex',
          config: { pattern: 'mock:fail' },
          action: 'redact',
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-batch-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: (e) => usage.push(e),
      jobs: { pollIntervalMs: 0, pollerTickMs: 60_000 },
      // With INTEGRATION_VALKEY_URL the same flows run on the Valkey job store.
      ...(process.env.INTEGRATION_VALKEY_URL
        ? { stateRedis: new Redis(process.env.INTEGRATION_VALKEY_URL) }
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
  });

  const waitFor = async (id: string, status: string[]) => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const b = await client.batches.retrieve(id);
      if (status.includes(b.status)) return b;
    }
    throw new Error(`batch ${id} never reached ${status.join('/')}`);
  };
  const uploadBatch = async (lines: string[], sdk = client) =>
    sdk.files.create({
      file: await toFile(Buffer.from(`${lines.join('\n')}\n`), 'input.jsonl'),
      purpose: 'batch',
    });

  it('the OpenAI SDK runs a batch end to end on OpenAI, billed at the batch discount', async () => {
    const file = await uploadBatch([
      chatLine('a', 'gpt-batch', 'Hello there'),
      chatLine('b', 'gpt-batch', 'mock:fail please'),
      chatLine('c', 'gpt-batch', 'A longer question about the weather in Tehran'),
    ]);
    expect(file).toMatchObject({ object: 'file', purpose: 'batch', filename: 'input.jsonl' });
    expect((await client.files.retrieve(file.id)).bytes).toBe(file.bytes);

    const created = await client.batches.create({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      metadata: { job: 'nightly' },
    });
    expect(created).toMatchObject({
      object: 'batch',
      input_file_id: file.id,
      metadata: { job: 'nightly' },
    });
    expect(created.id).toMatch(/^batch_/);

    const done = await waitFor(created.id, ['completed']);
    expect(done.request_counts).toEqual({ total: 3, completed: 2, failed: 1 });
    expect(done.output_file_id).toBeTruthy();
    expect(done.error_file_id).toBeTruthy();

    const output = (await (await client.files.content(done.output_file_id ?? '')).text())
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            custom_id: string;
            response: { body: { model: string; usage: { prompt_tokens: number } } };
          },
      );
    expect(output.map((l) => l.custom_id).sort()).toEqual(['a', 'c']);
    // The client sees its own model name; the provider got the upstream one.
    expect(output[0]?.response.body.model).toBe('gpt-batch');
    const seen = (await (await fetch(`${mockRoot}/__mock/batches`)).json()) as { models: string[] };
    expect(seen.models).toContain('gpt-4o-mini');
    expect(seen.models).not.toContain('gpt-batch');
    const errors = await (await client.files.content(done.error_file_id ?? '')).text();
    expect(errors).toContain('"custom_id":"b"');

    const event = usage.find((e) => e.requestId === created.id);
    expect(event).toMatchObject({
      inboundApi: 'openai.batches',
      status: 'success',
      requestedModel: 'gpt-batch',
      resolvedModelId: 'm-gpt-batch',
      organizationId: 'org',
    });
    const inputTokens = output.reduce((s, l) => s + l.response.body.usage.prompt_tokens, 0);
    expect(event?.usage).toMatchObject({ inputTokens, outputTokens: 20 });
    // Half of the normal price (batchDiscount 0.5).
    const full = computeCostUsd(event?.usage ?? ({} as never), {
      inputPerMTok: '2',
      outputPerMTok: '8',
    });
    expect(event?.costUsd).toBe(formatUsd((parseUsd(full) + 1n) / 2n));
    expect(event?.chargeUsd).toBe(event?.costUsd);
    expect(done.usage).toMatchObject({ input_tokens: inputTokens, output_tokens: 20 });
    // Retrieving again does not bill twice.
    await client.batches.retrieve(created.id);
    expect(usage.filter((e) => e.requestId === created.id)).toHaveLength(1);
  });

  it("another organization's key cannot see or touch files and batches", async () => {
    const file = await uploadBatch([chatLine('x', 'gpt-batch', 'private')]);
    const batch = await client.batches.create({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
    await expect(other.files.retrieve(file.id)).rejects.toMatchObject({ status: 404 });
    await expect(other.files.content(file.id)).rejects.toMatchObject({ status: 404 });
    await expect(other.files.delete(file.id)).rejects.toMatchObject({ status: 404 });
    await expect(other.batches.retrieve(batch.id)).rejects.toMatchObject({ status: 404 });
    await expect(other.batches.cancel(batch.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      other.batches.create({
        input_file_id: file.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await other.files.list()).data).toEqual([]);
    expect((await other.batches.list()).data).toEqual([]);
    // The owner still has both.
    expect((await client.files.list()).data.map((f) => f.id)).toContain(file.id);
    expect((await client.batches.list()).data.map((b) => b.id)).toContain(batch.id);
    // Without a key nothing is listed.
    expect((await fetch(`${base}/v1/files`)).status).toBe(401);
  });

  it('runs chat batches on Anthropic Message Batches, answered as chat completions', async () => {
    const file = await uploadBatch([
      chatLine('one', 'claude-batch', 'Hi Claude'),
      chatLine('two', 'claude-batch', 'mock:fail'),
    ]);
    const created = await client.batches.create({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
    const done = await waitFor(created.id, ['completed']);
    expect(done.request_counts).toEqual({ total: 2, completed: 1, failed: 1 });
    const line = JSON.parse(
      (await (await client.files.content(done.output_file_id ?? '')).text()).trim(),
    ) as { custom_id: string; response: { status_code: number; body: Record<string, unknown> } };
    expect(line).toMatchObject({
      custom_id: 'one',
      response: {
        status_code: 200,
        body: {
          object: 'chat.completion',
          model: 'claude-batch',
          choices: [{ message: { role: 'assistant', content: 'Batch reply to one' } }],
        },
      },
    });
    const errors = await (await client.files.content(done.error_file_id ?? '')).text();
    expect(errors).toContain('mock failure');
    const seen = (await (await fetch(`${mockRoot}/__mock/batches`)).json()) as { models: string[] };
    expect(seen.models).toContain('claude-sonnet-4');
    const event = usage.find((e) => e.requestId === created.id);
    expect(event).toMatchObject({ inboundApi: 'openai.batches', status: 'success' });
    expect(event?.usage.outputTokens).toBe(10);
  });

  it('cancels a batch upstream; a batch that ran nothing costs nothing', async () => {
    const file = await uploadBatch([chatLine('c1', 'gpt-batch', 'cancel me')]);
    const created = await client.batches.create({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
    const cancelling = await client.batches.cancel(created.id);
    expect(cancelling.status).toBe('cancelling');
    const done = await waitFor(created.id, ['cancelled']);
    expect(done.cancelled_at).toBeTruthy();
    const event = usage.find((e) => e.requestId === created.id);
    expect(event).toMatchObject({
      status: 'error',
      costUsd: '0.00000000',
      errorCode: 'batch_cancelled',
    });
  });

  it('the job poller follows a batch nobody polls', async () => {
    const file = await uploadBatch([chatLine('p', 'gpt-batch', 'poll me')]);
    const created = await client.batches.create({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
    for (let i = 0; i < 5 && !usage.some((e) => e.requestId === created.id); i++)
      await gw.poller.tick();
    expect(usage.find((e) => e.requestId === created.id)?.status).toBe('success');
  });

  it('applies the data policy: a ZDR-only key never reaches a provider that keeps data', async () => {
    const zdr = new OpenAI({ apiKey: ZDR, baseURL: `${base}/v1`, maxRetries: 0 });
    const file = await uploadBatch([chatLine('z', 'gpt-batch', 'keep nothing')], zdr);
    const before = (
      (await (await fetch(`${mockRoot}/__mock/batches`)).json()) as { openai: number }
    ).openai;
    await expect(
      zdr.batches.create({
        input_file_id: file.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'no_provider_matches_data_policy' });
    const after = ((await (await fetch(`${mockRoot}/__mock/batches`)).json()) as { openai: number })
      .openai;
    expect(after).toBe(before);
  });

  it('refuses a blocked end user like chat does', async () => {
    const file = await uploadBatch([chatLine('u', 'gpt-batch', 'hello')]);
    const res = await fetch(`${base}/v1/batches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'x-dirouter-end-user': 'mallory',
      },
      body: JSON.stringify({
        input_file_id: file.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('end_user_blocked');
  });

  it("runs the key's request guardrails on every line: block refuses, redact rewrites", async () => {
    const guarded = new OpenAI({ apiKey: GUARDED, baseURL: `${base}/v1`, maxRetries: 0 });
    const blocked = await uploadBatch(
      [chatLine('ok', 'gpt-batch', 'fine'), chatLine('bad', 'gpt-batch', 'a forbidden word')],
      guarded,
    );
    const refused = await guarded.batches
      .create({
        input_file_id: blocked.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      })
      .catch((error: unknown) => error as { status: number; message: string });
    expect(refused).toMatchObject({ status: 400 });
    expect((refused as { message: string }).message).toMatch(/'bad'.*no forbidden/);

    // The mock fails any line that still carries its marker: redacted, the line succeeds.
    const redacted = await uploadBatch(
      [chatLine('r1', 'gpt-batch', 'please mock:fail now'), chatLine('r2', 'gpt-batch', 'hi')],
      guarded,
    );
    const created = await guarded.batches.create({
      input_file_id: redacted.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
    let done = created;
    for (let i = 0; i < 20 && done.status !== 'completed'; i++)
      done = await guarded.batches.retrieve(created.id);
    expect(done.request_counts).toEqual({ total: 2, completed: 2, failed: 0 });
  });

  it('a worker whose lock ran out neither bills nor saves the batch', async () => {
    // The background poller (one tick a minute) would take the lock of this due batch first on a
    // slow runner; this test drives every step itself.
    await gw.poller.stop();
    onTestFinished(() => {
      gw.poller.start();
    });
    const file = await uploadBatch([chatLine('l', 'gpt-batch', 'lock me')]);
    const created = await client.batches.create({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
    // validating → in_progress
    expect((await refreshBatch(gw.jobs, created.id))?.status).toBe('in_progress');
    // The next check sees the end; the lock is lost while the results are collected.
    const store = gw.jobs.jobs;
    const losing = new Proxy(store, {
      get: (target, name: keyof JobStore) =>
        name === 'extend'
          ? () => Promise.resolve(false)
          : (target[name] as (...args: unknown[]) => unknown).bind(target),
    });
    await refreshBatch({ ...gw.jobs, jobs: losing }, created.id);
    expect(usage.filter((e) => e.requestId === created.id)).toHaveLength(0);
    const stored = await store.get<BatchRecord>('batch', created.id);
    expect(stored).toMatchObject({ status: 'in_progress', settled: false });
    // The replica that owns the batch settles it, once.
    expect((await refreshBatch(gw.jobs, created.id))?.settled).toBe(true);
    expect(usage.filter((e) => e.requestId === created.id)).toHaveLength(1);
  });

  it('rejects invalid batches before anything is sent upstream', async () => {
    const mixed = await uploadBatch([
      chatLine('1', 'gpt-batch', 'a'),
      chatLine('2', 'claude-batch', 'b'),
    ]);
    await expect(
      client.batches.create({
        input_file_id: mixed.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      }),
    ).rejects.toMatchObject({ status: 400 });
    const noBatchApi = await uploadBatch([chatLine('1', 'nova-batch', 'a')]);
    await expect(
      client.batches.create({
        input_file_id: noBatchApi.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      }),
    ).rejects.toMatchObject({ status: 400 });
    const notBatch = await client.files.create({
      file: await toFile(Buffer.from('{}'), 'notes.jsonl'),
      purpose: 'user_data',
    });
    await expect(
      client.batches.create({
        input_file_id: notBatch.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.files.create({ file: await toFile(Buffer.from('x'), 'input.txt'), purpose: 'batch' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(() =>
      parseBatchInput(
        `${chatLine('a', 'm', 'x')}\n${chatLine('a', 'm', 'y')}`,
        '/v1/chat/completions',
      ),
    ).toThrow(/twice/);
    expect(() => parseBatchInput(chatLine('a', 'm', 'x'), '/v1/embeddings')).toThrow(/endpoint/);
  });

  it('deletes files and honours expires_after', async () => {
    const form = encodeMultipart([
      ['purpose', 'user_data'],
      ['expires_after[anchor]', 'created_at'],
      ['expires_after[seconds]', '3600'],
      ['file', { data: Buffer.from('hello'), filename: 'note.txt', contentType: 'text/plain' }],
    ]);
    const res = await fetch(`${base}/v1/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': form.contentType },
      body: form.body,
    });
    const file = (await res.json()) as { id: string; created_at: number; expires_at: number };
    expect(file.expires_at - file.created_at).toBe(3600);
    expect(await (await client.files.content(file.id)).text()).toBe('hello');
    expect(await client.files.delete(file.id)).toEqual({
      id: file.id,
      object: 'file',
      deleted: true,
    });
    await expect(client.files.retrieve(file.id)).rejects.toMatchObject({ status: 404 });
  });

  it('the expiry sweep removes bytes and record once a file is due', async () => {
    const record = (await gw.jobs.jobs.get<FileRecord>(
      'file',
      (await uploadBatch([chatLine('e', 'gpt-batch', 'x')])).id,
    )) as FileRecord;
    await gw.jobs.jobs.put(
      'file',
      record.id,
      { ...record, expiresAt: Math.floor(Date.now() / 1000) - 1 },
      { ttlSeconds: 60 },
    );
    await expireFile(gw.jobs, record.id);
    expect(await gw.jobs.blobs.get(record.storageKey)).toBeUndefined();
    expect(await gw.jobs.jobs.get('file', record.id)).toBeUndefined();
  });
});

describe('batch worst case', () => {
  const line = (url: string, body: Record<string, unknown>) => ({
    custom_id: 'x',
    method: 'POST' as const,
    url,
    body: { model: 'm', ...body },
  });
  it('reserves every choice: n, and best_of for every prompt of a legacy completion', () => {
    const model = { maxOutputTokens: 1_000 };
    expect(lineTokens(line('/v1/chat/completions', { max_tokens: 50 }), model).output).toBe(50);
    expect(lineTokens(line('/v1/chat/completions', { max_tokens: 50, n: 3 }), model).output).toBe(
      150,
    );
    expect(
      lineTokens(line('/v1/completions', { prompt: 'a', max_tokens: 10, n: 2, best_of: 5 }), model)
        .output,
    ).toBe(50);
    expect(
      lineTokens(line('/v1/completions', { prompt: ['a', 'b'], max_tokens: 10, n: 3 }), model)
        .output,
    ).toBe(60);
    expect(lineTokens(line('/v1/embeddings', { input: 'a', n: 4 }), model).output).toBe(0);
  });
});

describe('batch pricing', () => {
  it('applies the discount to cost and to the sale price with the group multiplier', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const amounts = batchAmounts(
      usage,
      {
        pricing: { inputPerMTok: '2', outputPerMTok: '8', batchDiscount: '0.5' },
        sale: { multiplier: '1.5', cacheMultiplier: '0' },
      },
      '2',
    );
    expect(amounts.costUsd).toBe('5.00000000');
    expect(formatUsd(amounts.chargeUnits)).toBe('15.00000000');
  });
});

describe('file storage', () => {
  it('local storage keeps keys inside its folder', async () => {
    const storage = new LocalBlobStorage(await mkdtemp(join(tmpdir(), 'dirouter-blobs-')));
    await storage.put('org/file-1', Buffer.from('abc'));
    expect((await storage.get('org/file-1'))?.toString()).toBe('abc');
    await expect(storage.put('../escape', Buffer.from('x'))).rejects.toThrow(/invalid storage key/);
    await storage.delete('org/file-1');
    expect(await storage.get('org/file-1')).toBeUndefined();
  });

  it('S3 requests are signed with SigV4 (AWS documentation example)', () => {
    const s3 = new S3BlobStorage({
      endpoint: 'https://s3.amazonaws.com',
      bucket: 'examplebucket',
      region: 'us-east-1',
      // AWS's published example credentials, assembled so no key-shaped literal is committed.
      accessKeyId: ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join(''),
      secretAccessKey: ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/'),
      pathStyle: false,
      now: () => new Date('2013-05-24T00:00:00Z'),
    });
    const headers = s3.sign(
      'GET',
      new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      undefined,
      {
        range: 'bytes=0-9',
      },
    );
    expect(headers.authorization).toMatch(
      /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
    );
  });

  it('S3 storage puts, gets and deletes objects', async () => {
    const objects = new Map<string, Buffer>();
    const auth: string[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      auth.push(req.headers.authorization ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const path = req.url ?? '';
        if (req.method === 'PUT') objects.set(path, Buffer.concat(chunks));
        if (req.method === 'DELETE') objects.delete(path);
        const body = req.method === 'GET' ? objects.get(path) : undefined;
        res.statusCode = req.method === 'GET' && !body ? 404 : req.method === 'DELETE' ? 204 : 200;
        res.end(body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const s3 = new S3BlobStorage({
      endpoint: `http://127.0.0.1:${String(port)}`,
      bucket: 'files',
      region: 'us-east-1',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      prefix: 'dirouter',
    });
    await s3.put('org/file-1', Buffer.from('payload'));
    expect([...objects.keys()]).toEqual(['/files/dirouter/org/file-1']);
    expect((await s3.get('org/file-1'))?.toString()).toBe('payload');
    await s3.delete('org/file-1');
    expect(await s3.get('org/file-1')).toBeUndefined();
    expect(auth.every((a) => a.startsWith('AWS4-HMAC-SHA256 Credential=test-access/'))).toBe(true);
    server.close();
  });
});
