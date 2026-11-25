/* eslint-disable @typescript-eslint/no-deprecated -- the SDK marks the legacy endpoints card 30.4
   serves (variations, translations, completions) as deprecated; tools still call them. */
/**
 * Card 30.4 with the official OpenAI SDK: image edits and variations (multipart), audio
 * translations and the legacy `/v1/completions`, native or mapped to chat. Every call is billed.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, ProviderType, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import OpenAI, { toFile } from 'openai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { unmappable } from './completions.js';
import { parseMultipart } from './media.js';
import { buildGateway } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-legacy-key-000001';
const GUARDED = 'dr-legacy-guard-0001';
const WALLET = 'dr-legacy-wallet-001';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function wav(seconds: number): Buffer {
  const samples = Math.round(seconds * 16_000);
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24);
  b.writeUInt32LE(32_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

describe('image edits, variations, translations and legacy completions', () => {
  const mock = buildMock();
  const usage: UsageEvent[] = [];
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  let sdk: OpenAI;

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const root = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const keyring = parseKeyring(generateKey());
    const provider = (id: string, type: ProviderType, baseUrl: string) => ({
      id,
      organizationId: 'org',
      slug: id,
      type,
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
      capabilities: Record<string, boolean>,
      pricing: Record<string, string>,
    ) => ({
      id: slug,
      organizationId: 'org',
      slug,
      providerId,
      upstreamModel,
      enabled: true,
      pricing: { inputPerMTok: '0', outputPerMTok: '0', ...pricing },
      capabilities: {
        streaming: true,
        tools: false,
        vision: false,
        reasoning: false,
        jsonMode: false,
        embeddings: false,
        ...capabilities,
      },
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        provider('openai', 'openai', `${root}/v1`),
        provider('anthropic', 'anthropic', root),
        provider('azure', 'azure-openai', root),
      ],
      models: [
        model(
          'gpt-image',
          'openai',
          'gpt-image-1',
          { images: true },
          { inputPerMTok: '5', outputPerMTok: '40', perImageUsd: '0.01' },
        ),
        model('dalle2', 'openai', 'dall-e-2', { images: true }, { perImageUsd: '0.02' }),
        model(
          'whisper',
          'openai',
          'whisper-1',
          { transcription: true },
          { perSecondUsd: '0.0001' },
        ),
        model(
          'instruct',
          'openai',
          'gpt-3.5-turbo-instruct',
          { completions: true },
          { inputPerMTok: '1.5', outputPerMTok: '2' },
        ),
        model(
          'azure-instruct',
          'azure',
          'gpt-35-turbo-instruct',
          { completions: true },
          { inputPerMTok: '1.5', outputPerMTok: '2' },
        ),
        model('chat', 'openai', 'mock-small', {}, { inputPerMTok: '1', outputPerMTok: '1' }),
        model('claude', 'anthropic', 'claude-mock', {}, { inputPerMTok: '3', outputPerMTok: '15' }),
      ],
      combos: [],
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
          ipAllowlist: [],
          budgets: [],
          mcpTools: [],
        },
        ...[
          { id: 'vk-guard', raw: GUARDED },
          { id: 'vk-wallet', raw: WALLET, walletId: 'w-legacy' },
        ].map(({ id, raw, ...rest }) => ({
          id,
          hash: hashApiKey(raw, pepper),
          prefix: id,
          organizationId: 'org',
          teamId: null,
          projectId: 'prj',
          enabled: true,
          expiresAt: null,
          allowedModels: [],
          ipAllowlist: [],
          budgets: [],
          mcpTools: [],
          ...rest,
        })),
      ],
      // Card 15.1: the same request guardrails as chat.
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
          name: 'secret codes',
          enabled: true,
          stage: 'request',
          type: 'regex',
          config: { pattern: 'SECRET-\\d+' },
          action: 'redact',
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-legacy-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({ logger, keyring, pepper, dataDir, emitUsage: (e) => usage.push(e) });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
    sdk = new OpenAI({ apiKey: KEY, baseURL: `${base}/v1`, maxRetries: 0 });
  });
  afterAll(async () => {
    await gw.app.close();
    await mock.close();
  });

  const png = (name = 'image.png') => toFile(PNG, name, { type: 'image/png' });

  it('images.edit: uploads reach the provider, billed per image plus gpt-image tokens', async () => {
    const edited = await sdk.images.edit({
      model: 'gpt-image',
      image: await png(),
      prompt: 'add a hat',
      n: 2,
    });
    expect(edited.data?.map((d) => d.b64_json?.slice(0, 5))).toEqual(['iVBOR', 'iVBOR']);
    // 3 prompt + 65 image tokens × $5/M + 544 × $40/M + 2 × $0.01
    expect(usage.at(-1)).toMatchObject({
      inboundApi: 'openai.images',
      resolvedModelId: 'gpt-image',
      usage: { inputTokens: 68, outputTokens: 544 },
      media: { images: 2 },
      costUsd: '0.04210000',
    });

    // Several images (gpt-image) and a mask (dall-e-2, which answers with URLs).
    await sdk.images.edit({
      model: 'gpt-image',
      image: [await png('a.png'), await png('b.png')],
      prompt: 'merge',
    });
    expect(usage.at(-1)?.usage.inputTokens).toBe(2 + 130);
    const masked = await sdk.images.edit({
      model: 'dalle2',
      image: await png(),
      mask: await png('mask.png'),
      prompt: 'a red door',
      response_format: 'url',
    });
    expect(masked.data?.[0]?.url).toBe('https://mock.invalid/edits.png');
    expect(usage.at(-1)).toMatchObject({ media: { images: 1 }, costUsd: '0.02000000' });
  });

  it('images.createVariation: one image in, n variations out, priced per image', async () => {
    const varied = await sdk.images.createVariation({
      model: 'dalle2',
      image: await png(),
      n: 2,
      response_format: 'b64_json',
    });
    // The provider answered with URLs; b64_json is what the client asked for.
    expect(varied.data).toHaveLength(2);
    expect(usage.at(-1)).toMatchObject({
      inboundApi: 'openai.images',
      media: { images: 2 },
      costUsd: '0.04000000',
    });
  });

  it('audio.translations: English text, priced per second, rendered in every format', async () => {
    const translated = await sdk.audio.translations.create({
      model: 'whisper',
      file: await toFile(wav(3), 'speech.wav', { type: 'audio/wav' }),
    });
    expect(translated.text).toBe('Hello from the DiRouter mock translator.');
    expect(usage.at(-1)).toMatchObject({
      inboundApi: 'openai.translations',
      media: { seconds: 3 },
      costUsd: '0.00030000',
      usageEstimated: false,
    });
    const verbose = await sdk.audio.translations.create({
      model: 'whisper',
      file: await toFile(wav(1), 'speech.wav', { type: 'audio/wav' }),
      response_format: 'verbose_json',
    });
    expect(verbose).toMatchObject({ task: 'translate', language: 'english', duration: 1 });
    const srt = await sdk.audio.translations.create({
      model: 'whisper',
      file: await toFile(wav(2), 'speech.wav', { type: 'audio/wav' }),
      response_format: 'srt',
    });
    // Text formats come back as a plain string.
    expect(srt as unknown as string).toContain('00:00:00,000 --> 00:00:02,000');
  });

  it('completions: native for instruct models, every option passed through', async () => {
    const done = await sdk.completions.create({
      model: 'instruct',
      prompt: 'Say hi',
      max_tokens: 5,
      n: 2,
    });
    expect(done.object).toBe('text_completion');
    expect(done.model).toBe('instruct');
    expect(done.choices.map((c) => [c.index, c.text, c.finish_reason])).toEqual([
      [0, 'Hello from the DiRouter mock', 'length'],
      [1, 'Hello from the DiRouter mock', 'length'],
    ]);
    expect(done.usage).toEqual({ prompt_tokens: 2, completion_tokens: 16, total_tokens: 18 });
    // 2 × $1.5/M + 16 × $2/M
    expect(usage.at(-1)).toMatchObject({
      inboundApi: 'openai.completions',
      resolvedModelId: 'instruct',
      usage: { inputTokens: 2, outputTokens: 16 },
      costUsd: '0.00003500',
    });
    const echoed = await sdk.completions.create({
      model: 'instruct',
      prompt: ['A: ', 'B: '],
      echo: true,
    });
    expect(echoed.choices.map((c) => c.text.slice(0, 3))).toEqual(['A: ', 'B: ']);

    // Azure instruct deployments are native too.
    const azure = await sdk.completions.create({ model: 'azure-instruct', prompt: 'Hi' });
    expect(azure.choices[0]?.text).toMatch(/^Hello from/);
    expect(usage.at(-1)?.providerId).toBe('azure');
  });

  it('completions: mapped to chat for chat models, any provider type', async () => {
    const mapped = await sdk.completions.create({
      model: 'chat',
      prompt: 'Say hi',
      max_tokens: 50,
      temperature: 0,
    });
    expect(mapped.choices).toEqual([
      {
        text: 'Hello from the DiRouter mock provider.',
        index: 0,
        logprobs: null,
        finish_reason: 'stop',
      },
    ]);
    expect(mapped.usage?.completion_tokens).toBeGreaterThan(0);
    const event = usage.at(-1);
    expect(event).toMatchObject({ inboundApi: 'openai.completions', resolvedModelId: 'chat' });
    expect(Number(event?.costUsd)).toBeGreaterThan(0);
    // The chat request carried the prompt as one user message.
    const stats = (await (
      await fetch(
        `${base.replace(/:\d+$/, '')}:${String((mock.server.address() as { port: number }).port)}/__mock/stats`,
      )
    ).json()) as { last: { messages?: unknown; max_tokens?: number }[] };
    expect(stats.last.at(-1)).toMatchObject({
      messages: [{ role: 'user', content: 'Say hi' }],
    });

    const claude = await sdk.completions.create({ model: 'claude', prompt: 'Hi' });
    expect(claude.choices[0]?.text.length).toBeGreaterThan(0);
    expect(usage.at(-1)).toMatchObject({
      providerId: 'anthropic',
      inboundApi: 'openai.completions',
    });
  });

  it('completions: stream: true is answered as server-sent chunks with usage', async () => {
    const stream = await sdk.completions.create({
      model: 'chat',
      prompt: 'Say hi',
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let total = 0;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.text ?? '';
      if (chunk.usage) total = chunk.usage.total_tokens;
    }
    expect(text).toBe('Hello from the DiRouter mock provider.');
    expect(total).toBeGreaterThan(0);
    expect(usage.at(-1)?.inboundApi).toBe('openai.completions');
  });

  it("completions: the key's request guardrails block and redact, native and mapped", async () => {
    const guarded = new OpenAI({ apiKey: GUARDED, baseURL: sdk.baseURL, maxRetries: 0 });
    const mockStats = async () =>
      (
        (await (
          await fetch(
            `${base.replace(/:\d+$/, '')}:${String((mock.server.address() as { port: number }).port)}/__mock/stats`,
          )
        ).json()) as { last: unknown[] }
      ).last.at(-1);
    const before = usage.length;
    const refused = await guarded.completions
      .create({ model: 'instruct', prompt: 'a forbidden word' })
      .catch((error: unknown) => error as { status: number; message: string });
    expect(refused).toMatchObject({ status: 400 });
    expect((refused as { message: string }).message).toMatch(/no forbidden/);
    await expect(
      guarded.completions.create({ model: 'chat', prompt: 'a forbidden word' }),
    ).rejects.toMatchObject({ status: 400 });
    // Nothing reached a provider.
    expect(usage.length).toBe(before);

    await guarded.completions.create({ model: 'instruct', prompt: ['code SECRET-123', 'ok'] });
    const native = JSON.stringify(await mockStats());
    expect(native).not.toContain('SECRET-123');
    expect(native).toContain('ok');
    await guarded.completions.create({ model: 'chat', prompt: 'my code is SECRET-456' });
    const mapped = JSON.stringify(await mockStats());
    expect(mapped).not.toContain('SECRET-456');
    expect(mapped).toContain('my code is');
  });

  it('completions: the wallet holds every best_of completion, not only n', async () => {
    const wallets = gw.jobs.wallets;
    if (!wallets) throw new Error('no wallet guard');
    const reserve = vi.spyOn(wallets, 'reserve');
    try {
      const prepaid = new OpenAI({ apiKey: WALLET, baseURL: sdk.baseURL, maxRetries: 0 });
      await prepaid.completions.create({
        model: 'instruct',
        prompt: 'Say hi',
        max_tokens: 100,
        n: 1,
        best_of: 4,
      });
      const amount = reserve.mock.calls.at(-1)?.[2];
      // 4 × 100 output tokens at $2/M is $0.0008, before the input.
      expect(Number(amount)).toBeGreaterThanOrEqual(0.0008);
    } finally {
      reserve.mockRestore();
    }
  });

  it('refuses what cannot be served, with a clear error', async () => {
    const refused = await sdk.completions
      .create({ model: 'chat', prompt: 'x', echo: true, n: 2 })
      .catch((error: unknown) => error as { status: number; message: string });
    expect(refused).toMatchObject({ status: 400 });
    expect((refused as { message: string }).message).toMatch(/echo, n > 1/);
    await expect(
      sdk.completions.create({ model: 'chat', prompt: 'x', n: 0 }),
    ).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      sdk.images.createVariation({ model: 'whisper', image: await png() }),
    ).rejects.toMatchObject({ status: 400 });
    const noPrompt = await fetch(`${base}/v1/images/edits`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'multipart/form-data; boundary=x',
      },
      body: '--x\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image\r\n--x\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nPNG\r\n--x--\r\n',
    });
    expect(noPrompt.status).toBe(422);
    const unauth = await fetch(`${base}/v1/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'chat', prompt: 'x' }),
    });
    expect(unauth.status).toBe(401);
  });

  it('helpers: the reasons chat cannot carry a request, and multi-file uploads', () => {
    expect(unmappable({ prompt: 'x' })).toBeUndefined();
    expect(unmappable({ prompt: [1, 2, 3], logprobs: 2, suffix: '!', best_of: 2 })).toBe(
      'token prompts, logprobs, suffix, best_of',
    );
    expect(unmappable({ prompt: ['a', 'b'] })).toBe('several prompts');
    const form = parseMultipart(
      Buffer.from(
        '--b\r\nContent-Disposition: form-data; name="image[]"; filename="1.png"\r\n\r\nA\r\n' +
          '--b\r\nContent-Disposition: form-data; name="image[]"; filename="2.png"\r\n\r\nB\r\n' +
          '--b\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nhi\r\n--b--\r\n',
      ),
      'multipart/form-data; boundary=b',
    );
    expect(form.files.map((f) => [f.name, f.filename, f.data.toString()])).toEqual([
      ['image[]', '1.png', 'A'],
      ['image[]', '2.png', 'B'],
    ]);
    expect(form.fields).toEqual({ prompt: 'hi' });
  });
});
