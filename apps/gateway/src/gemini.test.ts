/**
 * Gemini behind DiRouter (card 4.8): the official OpenAI and Anthropic clients, unchanged, reach
 * a gemini-type upstream; text, stream and a full tool calling round trip.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import type { ConfigSnapshotInput } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import OpenAI from 'openai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const KEY = 'dr-gem-test-key-0001';
const mock = buildMock();
let gw: ReturnType<typeof buildGateway>;
let base = '';
let mockRoot = '';

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const ma = mock.server.address();
  mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
  const provider = (id: string, type: 'gemini', secret: string) => ({
    id,
    organizationId: 'org',
    slug: id,
    type,
    name: id,
    baseUrl: mockRoot,
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
    providers: [provider('gm', 'gemini', 'AIza-test'), provider('gm-tool', 'gemini', 'mock:tool')],
    models: [
      model('gemini-x', 'gm', 'gemini-2.5-flash'),
      model('gemini-tool', 'gm-tool', 'gemini-2.5-flash'),
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
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-gem-'));
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

interface UpstreamBody {
  contents: { role: string; parts: Record<string, unknown>[] }[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: { functionDeclarations: { name: string; parameters: unknown }[] }[];
  generationConfig?: Record<string, unknown>;
  safetySettings?: unknown[];
}

/** The last body the mock received from the gateway. */
async function lastUpstream(): Promise<UpstreamBody> {
  const stats = (await (await fetch(`${mockRoot}/__mock/stats`)).json()) as {
    last: UpstreamBody[];
  };
  const body = stats.last.at(-1);
  if (!body) throw new Error('mock received nothing');
  return body;
}

beforeEach(async () => {
  await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
});

const weather = {
  type: 'object' as const,
  additionalProperties: false,
  properties: { city: { type: 'string' } },
  required: ['city'],
};

describe('OpenAI client → Gemini upstream', () => {
  const client = () => new OpenAI({ apiKey: KEY, baseURL: `${base}/v1`, maxRetries: 0 });

  it('chat completion with system prompt and usage', async () => {
    const res = await client().chat.completions.create({
      model: 'gemini-x',
      max_completion_tokens: 64,
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'Answer briefly.' },
        { role: 'user', content: 'سلام' },
      ],
    });
    expect(res.choices[0]?.message.content).toBe('Hello from the DiRouter mock provider.');
    expect(res.choices[0]?.finish_reason).toBe('stop');
    expect(res.usage?.prompt_tokens).toBeGreaterThan(0);
    const up = await lastUpstream();
    expect(up.systemInstruction).toEqual({ parts: [{ text: 'Answer briefly.' }] });
    expect(up.contents).toEqual([{ role: 'user', parts: [{ text: 'سلام' }] }]);
    expect(up.generationConfig).toMatchObject({ maxOutputTokens: 64, temperature: 0.3 });
    expect(up.safetySettings).toHaveLength(4);
  });

  it('streams text with usage in the last chunk', async () => {
    const stream = await client().chat.completions.create({
      model: 'gemini-x',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
    let text = '';
    let usage: number | undefined;
    let finish: string | null | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? '';
      finish ??= chunk.choices[0]?.finish_reason;
      if (chunk.usage) usage = chunk.usage.completion_tokens;
    }
    expect(text).toBe('Hello from the DiRouter mock provider.');
    expect(finish).toBe('stop');
    expect(usage).toBeGreaterThan(0);
  });

  it('tool calling round trip: functionCall out, functionResponse back', async () => {
    const tools: OpenAI.ChatCompletionTool[] = [
      { type: 'function', function: { name: 'get_weather', parameters: weather } },
    ];
    const first = await client().chat.completions.create({
      model: 'gemini-tool',
      messages: [{ role: 'user', content: 'weather in Tehran?' }],
      tools,
      tool_choice: 'required',
    });
    const choice = first.choices[0];
    expect(choice?.finish_reason).toBe('tool_calls');
    const call = choice?.message.tool_calls?.[0];
    if (call?.type !== 'function') throw new Error('expected a function call');
    expect(call.function.name).toBe('get_weather');
    expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Tehran' });
    const sent = await lastUpstream();
    expect(sent.tools?.[0]?.functionDeclarations[0]).toEqual({
      name: 'get_weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    });

    const second = await client().chat.completions.create({
      model: 'gemini-x',
      tools,
      messages: [
        { role: 'user', content: 'weather in Tehran?' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: '{"celsius":18}' },
      ],
    });
    expect(second.choices[0]?.finish_reason).toBe('stop');
    const up = await lastUpstream();
    expect(up.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    // The thought signature Gemini gave is returned in the tool call ID and sent again.
    expect(up.contents[1]?.parts[0]).toEqual({
      functionCall: { name: 'get_weather', args: { city: 'Tehran' } },
      thoughtSignature: 'c2lnLW1vY2s=',
    });
    expect(up.contents[2]?.parts[0]).toEqual({
      functionResponse: { name: 'get_weather', response: { celsius: 18 } },
    });
  });

  it('upstream errors keep the OpenAI error shape', async () => {
    await fetch(`${mockRoot}/__mock/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directives: 'status=400' }),
    });
    try {
      await expect(
        client().chat.completions.create({
          model: 'gemini-x',
          messages: [{ role: 'user', content: 'x' }],
        }),
      ).rejects.toBeInstanceOf(OpenAI.BadRequestError);
    } finally {
      await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
    }
  });
});

describe('Anthropic client → Gemini upstream', () => {
  const client = () => new Anthropic({ apiKey: KEY, baseURL: base, maxRetries: 0 });
  const tools = [{ name: 'get_weather', description: 'Weather', input_schema: weather }];

  it('messages with system prompt', async () => {
    const res = await client().messages.create({
      model: 'gemini-x',
      max_tokens: 50,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const first = res.content[0];
    expect(first?.type === 'text' ? first.text : '').toBe('Hello from the DiRouter mock provider.');
    expect(res.stop_reason).toBe('end_turn');
    expect(res.usage.input_tokens).toBeGreaterThan(0);
    expect((await lastUpstream()).systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
  });

  it('streams and assembles the final message', async () => {
    const final = await client()
      .messages.stream({
        model: 'gemini-x',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .finalMessage();
    const first = final.content[0];
    expect(first?.type === 'text' ? first.text : '').toBe('Hello from the DiRouter mock provider.');
    expect(final.stop_reason).toBe('end_turn');
    expect(final.usage.output_tokens).toBeGreaterThan(0);
  });

  it('streamed tool_use round trip with tool_result', async () => {
    const msg = await client()
      .messages.stream({
        model: 'gemini-tool',
        max_tokens: 100,
        tools,
        messages: [{ role: 'user', content: 'weather in Tehran?' }],
      })
      .finalMessage();
    expect(msg.stop_reason).toBe('tool_use');
    const use = msg.content.find((c) => c.type === 'tool_use');
    if (use?.type !== 'tool_use') throw new Error('expected tool_use');
    expect(use.name).toBe('get_weather');
    expect(use.input).toEqual({ city: 'Tehran' });

    const followUp = await client().messages.create({
      model: 'gemini-x',
      max_tokens: 100,
      tools,
      messages: [
        { role: 'user', content: 'weather in Tehran?' },
        { role: 'assistant', content: msg.content },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: use.id, content: '18C' },
            { type: 'text', text: 'and tomorrow?' },
          ],
        },
      ],
    });
    expect(followUp.stop_reason).toBe('end_turn');
    const up = await lastUpstream();
    expect(up.contents[1]?.parts[0]).toMatchObject({
      functionCall: { name: 'get_weather', args: { city: 'Tehran' } },
      thoughtSignature: 'c2lnLW1vY2s=',
    });
    expect(up.contents[2]?.parts).toEqual([
      { functionResponse: { name: 'get_weather', response: { result: '18C' } } },
      { text: 'and tomorrow?' },
    ]);
  });
});
