/** `auto*` aliases end to end through the gateway (card 20.4). */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-auto-main-00001';
const AUTO_ONLY = 'dr-auto-only-00001';
const NO_AUTO = 'dr-auto-none-00001';
const OTHER_ORG = 'dr-auto-other-0001';

async function gatewayWith(settings: ConfigSnapshotInput['settings'], mockRoot: string) {
  const keyring = parseKeyring(generateKey());
  const provider = (id: string, secret: string) => ({
    id,
    organizationId: 'org',
    slug: id,
    type: 'openai-compatible' as const,
    name: id,
    baseUrl: `${mockRoot}/v1`,
    enabled: true,
    options: {},
    credentials: [
      { id: `${id}-k`, name: 'k', secret: encrypt(keyring, secret, `${id}-k`), enabled: true },
    ],
  });
  const model = (id: string, providerId: string, organizationId = 'org') => ({
    id: `${organizationId}-${id}`,
    organizationId,
    slug: id,
    providerId,
    upstreamModel: 'mock-small',
    enabled: true,
    pricing: { inputPerMTok: '1', outputPerMTok: '1' },
    capabilities: { tools: true },
  });
  const key = (raw: string, id: string, allowedModels: string[] = [], organizationId = 'org') => ({
    id,
    hash: hashApiKey(raw, pepper),
    prefix: id,
    organizationId,
    teamId: null,
    projectId: 'prj',
    enabled: true,
    expiresAt: null,
    allowedModels,
  });
  const snapshot: ConfigSnapshotInput = {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [provider('p', 'sk-mock'), provider('cls', 'mock:text=coding')],
    models: [
      model('coder', 'p'),
      model('mini', 'p'),
      model('classifier', 'cls'),
      model('coder', 'p', 'org-2'),
      model('mini', 'p', 'org-2'),
    ],
    combos: [],
    // org-2 defines its own `auto`: an organization's names always win.
    aliases: [
      { organizationId: 'org-2', slug: 'auto', target: { kind: 'model', modelId: 'org-2-mini' } },
    ],
    virtualKeys: [
      key(KEY, 'vk'),
      key(AUTO_ONLY, 'vk-auto', ['auto']),
      key(NO_AUTO, 'vk-none', ['mini']),
      key(OTHER_ORG, 'vk-2', [], 'org-2'),
    ],
    settings,
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-auto-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
  const usage: UsageEvent[] = [];
  const gw = buildGateway({ logger, keyring, pepper, dataDir, emitUsage: (e) => usage.push(e) });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const ga = gw.app.server.address();
  const base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  const ask = (key: string, model: string, text: string) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
    });
  return { gw, usage, ask };
}

describe('auto routing', () => {
  const mock = buildMock();
  let mockRoot = '';
  const settings = {
    autoRouting: {
      enabled: true,
      targets: { coding: 'coder', chat: 'mini', reasoning: 'coder', summarization: 'mini' },
      pool: ['mini', 'coder'],
    },
  };
  let env: Awaited<ReturnType<typeof gatewayWith>>;

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    env = await gatewayWith(settings, mockRoot);
  });
  afterAll(async () => {
    await env.gw.app.close();
    await mock.close();
  });

  it('routes auto by task type and records the decision with the request', async () => {
    const res = await env.ask(
      KEY,
      'auto',
      'Please refactor this TypeScript function and add unit tests',
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(res.headers.get('x-dirouter-auto')).toBe('coder; type=coding');
    const event = env.usage.at(-1);
    expect(event).toMatchObject({
      requestedModel: 'auto',
      resolvedModelId: 'org-coder',
      routing: { alias: 'auto', target: 'coder', taskType: 'coding', source: 'rules' },
    });
    expect(event?.routing?.reasons).toContain('task type coding → coder');
    // The overhead bound is measured in the routing package (auto.test.ts); one request through a
    // busy test run only shows that the timing is recorded.
    expect(event?.routing?.classifierMicros).toBeGreaterThanOrEqual(0);

    const chat = await env.ask(KEY, 'auto', 'hello, nice weather today');
    await chat.text();
    expect(chat.headers.get('x-dirouter-auto')).toBe('mini; type=chat');
  });

  it('auto/cheap and auto/coding resolve too', async () => {
    const cheap = await env.ask(KEY, 'auto/cheap', 'hi');
    await cheap.text();
    expect(cheap.headers.get('x-dirouter-auto')).toMatch(/^(mini|coder); type=chat$/);
    const coding = await env.ask(KEY, 'auto/coding', 'hi');
    await coding.text();
    expect(coding.headers.get('x-dirouter-auto')).toBe('coder; type=chat');
  });

  it("the key's allowlist applies to the alias, and an organization's own auto wins", async () => {
    const allowed = await env.ask(AUTO_ONLY, 'auto', 'refactor the java class');
    expect(allowed.status).toBe(200);
    await allowed.text();
    expect((await env.ask(NO_AUTO, 'auto', 'refactor the java class')).status).toBe(403);
    const own = await env.ask(OTHER_ORG, 'auto', 'refactor the java class');
    expect(own.status).toBe(200);
    await own.text();
    expect(own.headers.get('x-dirouter-auto')).toBeNull();
    expect(env.usage.at(-1)).toMatchObject({ resolvedModelId: 'org-2-mini' });
    expect(env.usage.at(-1)?.routing).toBeUndefined();
  });

  it('asks the small model when the rules are unsure, and is off when disabled', async () => {
    const withModel = await gatewayWith(
      {
        autoRouting: {
          ...settings.autoRouting,
          classifierModel: 'classifier',
          classifierThreshold: 1,
        },
      },
      mockRoot,
    );
    const res = await withModel.ask(KEY, 'auto', 'hello, nice weather today');
    await res.text();
    // The classifier model answers "coding" (mock), which overrides the rules' "chat".
    expect(res.headers.get('x-dirouter-auto')).toBe('coder; type=coding');
    expect(withModel.usage.at(-1)?.routing).toMatchObject({ source: 'model', taskType: 'coding' });
    await withModel.gw.app.close();

    const off = await gatewayWith({}, mockRoot);
    expect((await off.ask(KEY, 'auto', 'hi')).status).toBe(404);
    await off.gw.app.close();
  });
});
