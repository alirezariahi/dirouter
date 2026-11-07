/**
 * SDKهای رسمی openai و @anthropic-ai/sdk بدون هیچ تغییری فقط با baseURL به DiRouter
 * کار می‌کنند (کارت ۴.۹): non-stream، stream، tool call و count_tokens.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import type { ConfigSnapshotInput } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const KEY = 'dr-sdk-test-key-0001';
const mock = buildMock();
let gw: ReturnType<typeof buildGateway>;
let base = '';

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const ma = mock.server.address();
  const mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
  const provider = (id: string, type: 'openai-compatible' | 'anthropic', secret: string) => ({
    id,
    organizationId: 'org',
    slug: id,
    type,
    name: id,
    baseUrl: type === 'anthropic' ? mockRoot : `${mockRoot}/v1`,
    enabled: true,
    options: {},
    credentials: [
      { id: `${id}-k`, name: id, secret: encrypt(keyring, secret, `${id}-k`), enabled: true },
    ],
  });
  const model = (id: string, providerId: string, upstream: string) => ({
    id,
    organizationId: 'org',
    slug: id,
    providerId,
    upstreamModel: upstream,
    enabled: true,
    contextWindow: 100_000,
    pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
    capabilities: { tools: true },
  });
  const snapshot: ConfigSnapshotInput = {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      provider('oa', 'openai-compatible', 'sk-x'),
      provider('oa-tool', 'openai-compatible', 'mock:tool'),
      provider('an', 'anthropic', 'sk-x'),
      provider('an-tool', 'anthropic', 'mock:tool'),
    ],
    models: [
      model('gpt-x', 'oa', 'mock-small'),
      model('gpt-tool', 'oa-tool', 'mock-small'),
      model('claude-x', 'an', 'claude-mock'),
      model('claude-tool', 'an-tool', 'claude-mock'),
    ],
    combos: [],
    aliases: [],
    virtualKeys: [
      {
        id: 'vk',
        hash: hashApiKey(KEY, pepper),
        prefix: 'dr-sdk',
        organizationId: 'org',
        teamId: null,
        projectId: 'prj',
        enabled: true,
        expiresAt: null,
      },
    ],
    settings: {},
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-sdk-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
  gw = buildGateway({
    logger: createLogger({ service: 'test', level: 'silent' }),
    keyring,
    pepper,
    dataDir,
    emitUsage: () => undefined,
  });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const ga = gw.app.server.address();
  base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
});

afterAll(async () => {
  await gw.app.close();
  await mock.close();
});

const tools = [
  {
    name: 'get_weather',
    description: 'Weather for a city',
    input_schema: { type: 'object' as const, properties: { city: { type: 'string' } } },
  },
];

describe('official openai SDK', () => {
  const client = () => new OpenAI({ apiKey: KEY, baseURL: `${base}/v1`, maxRetries: 0 });

  it('chat completion, both to an OpenAI and to an Anthropic upstream', async () => {
    for (const model of ['gpt-x', 'claude-x']) {
      const res = await client().chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.choices[0]?.message.content).toContain('mock');
      expect(res.usage?.prompt_tokens).toBeGreaterThan(0);
    }
  });

  it('streams with usage in the last chunk', async () => {
    const stream = await client().chat.completions.create({
      model: 'claude-x',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    let usage: number | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? '';
      if (chunk.usage) usage = chunk.usage.completion_tokens;
    }
    expect(text).toBe('Hello from the DiRouter mock provider.');
    expect(usage).toBeGreaterThan(0);
  });

  it('tool calls come back as function calls', async () => {
    const res = await client().chat.completions.create({
      model: 'claude-tool',
      messages: [{ role: 'user', content: 'weather in Tehran?' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: tools[0]?.input_schema ?? {} },
        },
      ],
    });
    const call = res.choices[0]?.message.tool_calls?.[0];
    expect(res.choices[0]?.finish_reason).toBe('tool_calls');
    expect(call?.type === 'function' ? call.function.name : '').toBe('get_weather');
  });

  it('lists models and surfaces errors as SDK errors', async () => {
    const models = await client().models.list();
    expect(models.data.map((m) => m.id)).toEqual(expect.arrayContaining(['gpt-x', 'claude-x']));
    const bad = new OpenAI({ apiKey: 'dr-wrong', baseURL: `${base}/v1`, maxRetries: 0 });
    await expect(
      bad.chat.completions.create({ model: 'gpt-x', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
  });
});

describe('official anthropic SDK', () => {
  const client = () => new Anthropic({ apiKey: KEY, baseURL: base, maxRetries: 0 });

  it('messages, both to an Anthropic and to an OpenAI upstream', async () => {
    for (const model of ['claude-x', 'gpt-x']) {
      const res = await client().messages.create({
        model,
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const first = res.content[0];
      expect(first?.type === 'text' ? first.text : '').toContain('mock');
      expect(res.usage.output_tokens).toBeGreaterThan(0);
    }
  });

  it('streams events and assembles the final message', async () => {
    const stream = client().messages.stream({
      model: 'gpt-x',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const final = await stream.finalMessage();
    const first = final.content[0];
    expect(first?.type === 'text' ? first.text : '').toBe('Hello from the DiRouter mock provider.');
    expect(final.stop_reason).toBe('end_turn');
  });

  it('a streamed tool call round trip with tool_result', async () => {
    const stream = client().messages.stream({
      model: 'gpt-tool',
      max_tokens: 100,
      tools,
      messages: [{ role: 'user', content: 'weather in Tehran?' }],
    });
    const msg = await stream.finalMessage();
    const use = msg.content.find((c) => c.type === 'tool_use');
    expect(msg.stop_reason).toBe('tool_use');
    expect(use?.type === 'tool_use' ? use.name : '').toBe('get_weather');
    const followUp = await client().messages.create({
      model: 'gpt-x',
      max_tokens: 100,
      tools,
      messages: [
        { role: 'user', content: 'weather in Tehran?' },
        { role: 'assistant', content: msg.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: use?.type === 'tool_use' ? use.id : '',
              content: '18C',
            },
          ],
        },
      ],
    });
    expect(followUp.stop_reason).toBe('end_turn');
  });

  it('count_tokens is answered locally', async () => {
    const res = await client().messages.countTokens({
      model: 'claude-x',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'What is the weather in Tehran today?' }],
      tools,
    });
    expect(res.input_tokens).toBeGreaterThan(10);
  });

  it('errors keep the Anthropic shape', async () => {
    const bad = new Anthropic({ apiKey: 'dr-wrong', baseURL: base, maxRetries: 0 });
    await expect(
      bad.messages.create({
        model: 'claude-x',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
  });
});
