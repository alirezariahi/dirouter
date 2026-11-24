/**
 * Translation through the whole gateway against the mock provider (sprint 4, epic 27): structured
 * output to Claude and Bedrock (27.1).
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ConfigSnapshotInput, validateJsonSchema } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { SseParser } from '@dirouter/translator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const KEY = 'dr-test-translation-0123456789';

const mock = buildMock();
let mockUrl = '';
let gw: ReturnType<typeof buildGateway>;
let base = '';

type ProviderType = 'anthropic' | 'bedrock' | 'gemini' | 'openai-compatible';

const provider = (id: string, type: ProviderType, secret: string) => ({
  id,
  organizationId: 'org',
  slug: id,
  type,
  name: id,
  baseUrl: type === 'openai-compatible' ? `${mockUrl}/v1` : mockUrl,
  enabled: true,
  options: type === 'bedrock' ? { region: 'us-east-1' } : {},
  credentials: [
    { id: `${id}-k`, name: 'k', secret: encrypt(keyring, secret, `${id}-k`), enabled: true },
  ],
});

const model = (id: string, providerId: string, upstreamModel: string) => ({
  id,
  organizationId: 'org',
  slug: id,
  providerId,
  upstreamModel,
  enabled: true,
  contextWindow: 200_000,
  pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
  capabilities: {},
});

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const addr = mock.server.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const snapshot: ConfigSnapshotInput = {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      provider('an', 'anthropic', 'sk-ant-mock'),
      provider('br', 'bedrock', 'AKIAMOCK:secret'),
      provider('gm', 'gemini', 'AIza-mock'),
      provider('oa', 'openai-compatible', 'sk-mock'),
    ],
    models: [
      model('claude-old', 'an', 'claude-sonnet-4-5'),
      model('claude-new', 'an', 'claude-sonnet-5-5'),
      model('bedrock-old', 'br', 'anthropic.claude-sonnet-4-5-20250929-v1:0'),
      model('bedrock-new', 'br', 'us.anthropic.claude-opus-5-5-v1:0'),
      model('gemini', 'gm', 'gemini-2.5-flash'),
      model('openai', 'oa', 'mock-small'),
    ],
    combos: [],
    aliases: [],
    virtualKeys: [
      {
        id: 'vk',
        hash: hashApiKey(KEY, pepper),
        prefix: 'dr-test',
        organizationId: 'org',
        teamId: null,
        projectId: 'prj',
        enabled: true,
        expiresAt: null,
      },
    ],
    settings: { defaultRetry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 } },
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-tr-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
  gw = buildGateway({
    logger: createLogger({ service: 'test', level: 'silent' }),
    keyring,
    pepper,
    dataDir,
    emitUsage: () => undefined,
    heartbeatMs: 50,
    internalToken: 'i'.repeat(32),
  });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const gaddr = gw.app.server.address();
  base = `http://127.0.0.1:${typeof gaddr === 'object' && gaddr ? gaddr.port : 0}`;
});

afterAll(async () => {
  await gw.app.close();
  await mock.close();
});

beforeEach(async () => {
  await fetch(`${mockUrl}/__mock/reset`, { method: 'POST' });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, ...headers },
    body: JSON.stringify(body),
  });

/** Request bodies the mock received, oldest first. */
const upstreamBodies = async () =>
  ((await (await fetch(`${mockUrl}/__mock/stats`)).json()) as { last: Record<string, unknown>[] })
    .last;

/** Text and finish reason an OpenAI client receives from a stream. */
async function openAIStream(res: Response) {
  const parser = new SseParser();
  const events = [...parser.feed(await res.text()), ...parser.flush()].filter(
    (e) => e.data !== '[DONE]',
  );
  let text = '';
  let finish: string | null = null;
  let toolCalls = 0;
  for (const e of events) {
    const chunk = JSON.parse(e.data) as {
      choices: { delta: { content?: string; tool_calls?: unknown[] }; finish_reason?: string }[];
    };
    text += chunk.choices[0]?.delta.content ?? '';
    toolCalls += chunk.choices[0]?.delta.tool_calls?.length ?? 0;
    finish = chunk.choices[0]?.finish_reason ?? finish;
  }
  return { text, finish, toolCalls };
}

const SCHEMA = {
  type: 'object',
  properties: {
    city: { type: 'string' },
    temp: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
  required: ['city', 'temp', 'tags'],
  additionalProperties: false,
};

describe('card 27.1: OpenAI json_schema to Claude and Bedrock', () => {
  const request = (model: string, stream: boolean) => ({
    model,
    stream,
    messages: [{ role: 'user', content: 'Weather in Tehran' }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'weather', schema: SCHEMA, strict: true },
    },
  });

  it.each([
    ['claude-old', 'tool'],
    ['claude-new', 'native'],
    ['bedrock-old', 'tool'],
    ['bedrock-new', 'native'],
  ])('%s (%s): non-stream answer is valid JSON for the schema', async (name, mode) => {
    const res = await post('/v1/chat/completions', request(name, false));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string; tool_calls?: unknown }; finish_reason: string }[];
    };
    const choice = body.choices[0];
    expect(choice?.finish_reason).toBe('stop');
    expect(choice?.message.tool_calls).toBeUndefined();
    expect(validateJsonSchema(JSON.parse(choice?.message.content ?? ''), SCHEMA)).toEqual([]);

    const [upstream] = await upstreamBodies();
    if (name.startsWith('claude'))
      expect(upstream?.output_config !== undefined).toBe(mode === 'native');
    else expect(upstream?.additionalModelRequestFields !== undefined).toBe(mode === 'native');
  });

  it.each(['claude-old', 'claude-new', 'bedrock-old', 'bedrock-new'])(
    '%s: stream answer is valid JSON for the schema',
    async (name) => {
      const res = await post('/v1/chat/completions', request(name, true));
      expect(res.status).toBe(200);
      const { text, finish, toolCalls } = await openAIStream(res);
      expect(toolCalls).toBe(0);
      expect(finish).toBe('stop');
      expect(validateJsonSchema(JSON.parse(text), SCHEMA)).toEqual([]);
    },
  );
});
