/**
 * Translation through the whole gateway against the mock provider (sprint 4, epic 27): structured
 * output to Claude and Bedrock (27.1), documents and audio (27.2).
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

const model = (
  id: string,
  providerId: string,
  upstreamModel: string,
  capabilities: Record<string, boolean> = {},
) => ({
  id,
  organizationId: 'org',
  slug: id,
  providerId,
  upstreamModel,
  enabled: true,
  contextWindow: 200_000,
  pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
  capabilities,
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
      model('openai-nodocs', 'oa', 'mock-small', { documents: false }),
    ],
    combos: [
      {
        id: 'claude-then-gemini',
        organizationId: 'org',
        slug: 'claude-then-gemini',
        strategy: 'priority',
        targets: [
          { modelId: 'claude-old', order: 0 },
          { modelId: 'gemini', order: 1 },
        ],
      },
    ],
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

const PDF =
  'JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKdHJhaWxlcjw8Pj4KJSVFT0Y=';
const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

describe('card 27.2: documents and audio', () => {
  const openAIPdf = (model: string) => ({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize this' },
          {
            type: 'file',
            file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${PDF}` },
          },
        ],
      },
    ],
  });
  const lastUserContent = async () => {
    const [body] = await upstreamBodies();
    return body;
  };

  it('a PDF from an OpenAI client reaches Claude as a document block', async () => {
    const res = await post('/v1/chat/completions', openAIPdf('claude-old'));
    expect(res.status).toBe(200);
    const body = (await lastUserContent()) as { messages: { content: unknown[] }[] };
    expect(body.messages[0]?.content).toContainEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: PDF },
    });
  });

  it('a PDF from an OpenAI client reaches Gemini as inlineData', async () => {
    const res = await post('/v1/chat/completions', { ...openAIPdf('gemini'), stream: true });
    expect(res.status).toBe(200);
    await res.text();
    const body = (await lastUserContent()) as { contents: { parts: unknown[] }[] };
    expect(body.contents[0]?.parts).toContainEqual({
      inlineData: { mimeType: 'application/pdf', data: PDF },
    });
  });

  it('a PDF from an OpenAI client reaches Bedrock as a Converse document', async () => {
    const res = await post('/v1/chat/completions', openAIPdf('bedrock-old'));
    expect(res.status).toBe(200);
    const body = (await lastUserContent()) as { messages: { content: unknown[] }[] };
    expect(body.messages[0]?.content).toContainEqual({
      document: { format: 'pdf', name: 'report 1', source: { bytes: PDF } },
    });
  });

  it('a PDF from an Anthropic client (and a Gemini client) reaches OpenAI as a file part', async () => {
    const res = await post(
      '/v1/messages',
      {
        model: 'openai',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                title: 'report',
                source: { type: 'base64', media_type: 'application/pdf', data: PDF },
              },
              { type: 'text', text: 'Summarize this' },
            ],
          },
        ],
      },
      { 'anthropic-version': '2023-06-01' },
    );
    expect(res.status).toBe(200);
    const fromAnthropic = (await lastUserContent()) as { messages: { content: unknown[] }[] };
    expect(fromAnthropic.messages[0]?.content).toContainEqual({
      type: 'file',
      file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${PDF}` },
    });

    await fetch(`${mockUrl}/__mock/reset`, { method: 'POST' });
    const gemini = await fetch(`${base}/v1beta/models/openai:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: PDF } },
              { text: 'Summarize' },
            ],
          },
        ],
      }),
    });
    expect(gemini.status).toBe(200);
    const fromGemini = (await lastUserContent()) as { messages: { content: unknown[] }[] };
    expect(fromGemini.messages[0]?.content).toContainEqual({
      type: 'file',
      file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${PDF}` },
    });
  });

  it('audio reaches the models that take it: OpenAI as input_audio, Gemini as inlineData', async () => {
    const audio = (model: string) => ({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is said here?' },
            { type: 'input_audio', input_audio: { data: WAV, format: 'wav' } },
          ],
        },
      ],
    });
    expect((await post('/v1/chat/completions', audio('openai'))).status).toBe(200);
    const openai = (await lastUserContent()) as { messages: { content: unknown[] }[] };
    expect(openai.messages[0]?.content).toContainEqual({
      type: 'input_audio',
      input_audio: { data: WAV, format: 'wav' },
    });

    await fetch(`${mockUrl}/__mock/reset`, { method: 'POST' });
    // The combo's first target (Claude) cannot take audio, so the request goes to Gemini.
    const res = await post('/v1/chat/completions', audio('claude-then-gemini'));
    expect(res.status).toBe(200);
    const stats = (await (await fetch(`${mockUrl}/__mock/stats`)).json()) as {
      requests: number;
      last: { contents?: { parts: unknown[] }[] }[];
    };
    expect(stats.requests).toBe(1);
    expect(stats.last[0]?.contents?.[0]?.parts).toContainEqual({
      inlineData: { mimeType: 'audio/wav', data: WAV },
    });
  });

  it.each([
    ['audio to a Claude-only model', 'claude-old', 'audio', /cannot take audio input/],
    ['audio to a Bedrock model', 'bedrock-old', 'audio', /cannot take audio input/],
    ['a PDF to a model marked without documents', 'openai-nodocs', 'pdf', /cannot take document/],
    ['a PDF by URL to Bedrock', 'bedrock-old', 'pdf-url', /Converse reads documents inline/],
    ['a Word file to OpenAI', 'openai', 'docx', /only PDF files are accepted/],
  ])('%s: a clear 400, and nothing reaches the provider', async (_name, model, kind, message) => {
    const part =
      kind === 'audio'
        ? { type: 'input_audio', input_audio: { data: WAV, format: 'wav' } }
        : kind === 'pdf'
          ? { type: 'file', file: { file_data: `data:application/pdf;base64,${PDF}` } }
          : kind === 'docx'
            ? { type: 'file', file: { filename: 'a.docx', file_data: 'UEsDBA==' } }
            : undefined;
    const res =
      kind === 'pdf-url'
        ? await post(
            '/v1/messages',
            {
              model,
              max_tokens: 50,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'document', source: { type: 'url', url: 'https://x.test/a.pdf' } },
                  ],
                },
              ],
            },
            { 'anthropic-version': '2023-06-01' },
          )
        : await post('/v1/chat/completions', {
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, part] }],
          });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(message);
    const stats = (await (await fetch(`${mockUrl}/__mock/stats`)).json()) as { requests: number };
    expect(stats.requests).toBe(0);
  });
});
