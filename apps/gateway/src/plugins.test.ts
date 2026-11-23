/** Provider plugins through the gateway (card 21.2): the reference plugin and broken plugins. */
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-plugin-key-0001';

describe('provider plugins in the gateway', () => {
  const mock = buildMock();
  const usage: UsageEvent[] = [];
  let gw: ReturnType<typeof buildGateway>;
  let base = '';

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const root = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;

    // The reference plugin, plus plugins that break at load and at request time.
    const dir = await mkdtemp(join(tmpdir(), 'dirouter-gw-plugins-'));
    const plugin = async (name: string, code: string, extra = {}) => {
      await mkdir(join(dir, name));
      await writeFile(
        join(dir, name, 'plugin.json'),
        JSON.stringify({ name, version: '1', displayName: name, ...extra }),
      );
      await writeFile(join(dir, name, 'index.js'), code);
    };
    const reference = resolve(import.meta.dirname, '../../../plugins/workers-ai');
    await mkdir(join(dir, 'workers-ai'));
    for (const file of ['plugin.json', 'index.js'])
      await copyFile(join(reference, file), join(dir, 'workers-ai', file));
    await plugin('crashes', 'module.exports = { buildRequest: () => { throw new Error("bug") } }');
    await plugin('hangs', 'module.exports = { buildRequest: () => { for (;;) {} } }');
    await plugin('syntax', 'module.exports = {');
    await plugin('risky', 'module.exports = { buildRequest: (i) => ({ url: i.baseUrl + "/x" }) }', {
      termsWarning: { text: 'May break the provider terms.' },
    });

    const keyring = parseKeyring(generateKey());
    const provider = (id: string, pluginName: string, options = {}) => ({
      id,
      organizationId: 'org',
      slug: id,
      type: 'plugin' as const,
      name: id,
      baseUrl: `${root}/workers-ai`,
      enabled: true,
      options: { plugin: pluginName, accountId: 'acc', ...options },
      credentials: [
        {
          id: `${id}-k`,
          name: 'k',
          secret: encrypt(keyring, 'cf-token', `${id}-k`),
          enabled: true,
        },
      ],
    });
    const model = (id: string, providerId: string) => ({
      id,
      organizationId: 'org',
      slug: id,
      providerId,
      upstreamModel: '@cf/meta/llama-3.1-8b-instruct',
      enabled: true,
      pricing: { inputPerMTok: '1', outputPerMTok: '2' },
      capabilities: {
        streaming: true,
        tools: false,
        vision: false,
        reasoning: false,
        jsonMode: false,
        embeddings: false,
      },
    });
    const combo = (slug: string, first: string) => ({
      id: slug,
      organizationId: 'org',
      slug,
      strategy: 'priority' as const,
      targets: [
        { modelId: first, order: 0, weight: 1 },
        { modelId: 'workers', order: 1, weight: 1 },
      ],
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        provider('p-workers', 'workers-ai'),
        provider('p-crashes', 'crashes'),
        provider('p-hangs', 'hangs'),
        provider('p-syntax', 'syntax'),
        provider('p-risky', 'risky'),
      ],
      models: [
        model('workers', 'p-workers'),
        model('crashes', 'p-crashes'),
        model('hangs', 'p-hangs'),
        model('syntax', 'p-syntax'),
        model('risky', 'p-risky'),
      ],
      combos: [
        combo('via-crash', 'crashes'),
        combo('via-hang', 'hangs'),
        combo('via-syntax', 'syntax'),
        combo('via-risky', 'risky'),
      ],
      aliases: [],
      virtualKeys: [
        {
          id: 'vk',
          hash: hashApiKey(KEY, pepper),
          prefix: 'vk',
          organizationId: 'org',
          teamId: null,
          projectId: 'prj',
          enabled: true,
          expiresAt: null,
          allowedModels: [],
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-plugins-gw-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      emitUsage: (e) => usage.push(e),
      plugins: { dir, enabled: 'workers-ai crashes hangs syntax risky not-installed' },
    });
    // Broken and missing plugins must not stop the gateway from starting.
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  });
  afterAll(async () => {
    await gw.app.close();
    await mock.close();
  });

  const chat = (model: string, stream = false) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hi' }] }),
    });

  it('serves chat through the reference plugin, streaming included', async () => {
    const res = await chat('workers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe('Hello from the Workers AI mock.');
    expect(usage.at(-1)).toMatchObject({
      providerId: 'p-workers',
      usage: { inputTokens: 7, outputTokens: 6 },
      costUsd: '0.00001900',
    });

    const stream = await chat('workers', true);
    const text = await stream.text();
    const content = text
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as { choices: { delta?: { content?: string } }[] })
      .map((chunk) => chunk.choices[0]?.delta?.content ?? '')
      .join('');
    expect(content).toBe('Hello from the Workers AI mock.');
  });

  it.each([
    ['via-crash', 'p-crashes'],
    ['via-hang', 'p-hangs'],
    ['via-syntax', 'p-syntax'],
    ['via-risky', 'p-risky'],
  ])('%s: the broken or unaccepted plugin fails over to the next target', async (combo, broken) => {
    const res = await chat(combo);
    expect(res.status).toBe(200);
    await res.text();
    const event = usage.at(-1);
    expect(event?.providerId).toBe('p-workers');
    expect(event?.attempts[0]).toMatchObject({
      providerId: broken,
      outcome: 'error',
      errorCode: 'server',
    });
  });

  it('a broken plugin alone gives the client a clean error and the gateway keeps serving', async () => {
    const res = await chat('crashes');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBeTruthy();
    expect((await chat('workers')).status).toBe(200);
  });
});
