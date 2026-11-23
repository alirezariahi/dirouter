/** Images, speech and transcription through the gateway, priced per unit (card 21.1). */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, ProviderType, UsageEvent } from '@dirouter/contracts';
import { encodeMultipart } from '@dirouter/providers';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseMultipart, renderTranscript, wavSeconds } from './media.js';
import { buildGateway } from './server.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const pepper = 'p'.repeat(32);
const KEY = 'dr-media-key-00001';

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

describe('media endpoints', () => {
  const mock = buildMock();
  const usage: UsageEvent[] = [];
  let gw: ReturnType<typeof buildGateway>;
  let base = '';

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const root = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const keyring = parseKeyring(generateKey());
    const provider = (id: ProviderType, baseUrl: string, options = {}) => ({
      id,
      organizationId: 'org',
      slug: id,
      type: id,
      name: id,
      baseUrl,
      enabled: true,
      options,
      credentials: [
        { id: `${id}-k`, name: 'k', secret: encrypt(keyring, 'secret', `${id}-k`), enabled: true },
      ],
    });
    const caps = {
      streaming: false,
      tools: false,
      vision: false,
      reasoning: false,
      jsonMode: false,
      embeddings: false,
    };
    const model = (
      slug: string,
      providerId: string,
      upstreamModel: string,
      capabilities: Record<string, boolean>,
      pricing: Record<string, string>,
      extra = {},
    ) => ({
      id: `m-${slug}`,
      organizationId: 'org',
      slug,
      providerId,
      upstreamModel,
      enabled: true,
      pricing: { inputPerMTok: '0', outputPerMTok: '0', ...pricing },
      capabilities: { ...caps, ...capabilities },
      ...extra,
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        provider('openai', `${root}/v1`),
        provider('deepgram', `${root}/v1`),
        provider('elevenlabs', `${root}/v1`, { voices: { alloy: 'voice-1' } }),
        provider('fal', root),
      ],
      models: [
        model(
          'gpt-image',
          'openai',
          'gpt-image-1',
          { images: true },
          {
            inputPerMTok: '5',
            outputPerMTok: '40',
            perImageUsd: '0.01',
          },
        ),
        model(
          'dalle',
          'openai',
          'dall-e-3',
          { images: true },
          { perImageUsd: '0.04' },
          {
            sale: { multiplier: '2', cacheMultiplier: '0' },
          },
        ),
        model('flux', 'fal', 'fal-ai/flux/dev', { images: true }, { perImageUsd: '0.025' }),
        model('tts', 'openai', 'tts-1', { speech: true }, { perMCharUsd: '15' }),
        model(
          'eleven',
          'elevenlabs',
          'eleven_multilingual_v2',
          { speech: true },
          { perMCharUsd: '180' },
        ),
        model(
          'whisper',
          'openai',
          'whisper-1',
          { transcription: true },
          { perSecondUsd: '0.0001' },
        ),
        model('nova', 'deepgram', 'nova-3', { transcription: true }, { perSecondUsd: '0.0000716' }),
        model('chat', 'openai', 'mock-small', {}, { inputPerMTok: '1', outputPerMTok: '1' }),
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
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-media-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({ logger, keyring, pepper, dataDir, emitUsage: (e) => usage.push(e) });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  });
  afterAll(async () => {
    await gw.app.close();
    await mock.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const upload = (fields: [string, string][], audio: Buffer) => {
    const form = encodeMultipart([
      ...fields,
      ['file', { data: audio, filename: 'speech.wav', contentType: 'audio/wav' }],
    ]);
    return fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': form.contentType },
      body: form.body,
    });
  };

  it('images: per-image price plus gpt-image tokens, in the format the client asked for', async () => {
    const res = await post('/v1/images/generations', {
      model: 'gpt-image',
      prompt: 'a red fox',
      n: 2,
      response_format: 'b64_json',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { b64_json?: string }[];
      usage?: { output_tokens: number };
    };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.b64_json).toMatch(/^iVBOR/);
    expect(body.usage?.output_tokens).toBe(544);
    // 3 input tokens × $5/M + 544 output × $40/M + 2 × $0.01
    expect(usage.at(-1)).toMatchObject({
      inboundApi: 'openai.images',
      media: { images: 2 },
      usage: { inputTokens: 3, outputTokens: 544 },
      costUsd: '0.04177500',
      chargeUsd: '0.04177500',
    });

    // dall-e answers with URLs; its sale multiplier of 2 doubles the charge, not the cost.
    const dalle = await post('/v1/images/generations', { model: 'dalle', prompt: 'a fox' });
    expect(
      ((await dalle.json()) as { data: { url: string; revised_prompt: string }[] }).data[0],
    ).toEqual({
      url: 'https://mock.invalid/image.png',
      revised_prompt: 'mock: a fox',
    });
    expect(usage.at(-1)).toMatchObject({ costUsd: '0.04000000', chargeUsd: '0.08000000' });

    // Fal returns URLs only; b64_json downloads them.
    const flux = await post('/v1/images/generations', {
      model: 'flux',
      prompt: 'a fox',
      n: 3,
      response_format: 'b64_json',
    });
    expect(flux.headers.get('x-dirouter-provider')).toBe('fal');
    expect(
      ((await flux.json()) as { data: { b64_json: string }[] }).data.map((d) =>
        d.b64_json.slice(0, 5),
      ),
    ).toEqual(['iVBOR', 'iVBOR', 'iVBOR']);
    expect(usage.at(-1)).toMatchObject({ media: { images: 3 }, costUsd: '0.07500000' });
  });

  it('speech: audio bytes back, priced per character', async () => {
    const input = 'Hello from DiRouter';
    const res = await post('/v1/audio/speech', {
      model: 'tts',
      input,
      voice: 'alloy',
      response_format: 'wav',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    const audio = Buffer.from(await res.arrayBuffer());
    expect(wavSeconds(audio)).toBeCloseTo(input.length * 0.06, 3);
    // 19 characters × $15 per million
    expect(usage.at(-1)).toMatchObject({
      inboundApi: 'openai.speech',
      media: { characters: 19 },
      costUsd: '0.00028500',
    });

    const eleven = await post('/v1/audio/speech', { model: 'eleven', input, voice: 'alloy' });
    expect(eleven.status).toBe(200);
    expect(eleven.headers.get('x-dirouter-provider')).toBe('elevenlabs');
    expect(usage.at(-1)).toMatchObject({ costUsd: '0.00342000' });
  });

  it('transcription: priced per second of audio, rendered as json, text, srt or verbose_json', async () => {
    const res = await upload(
      [
        ['model', 'whisper'],
        ['response_format', 'srt'],
      ],
      wav(2.5),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      '1\n00:00:00,000 --> 00:00:02,500\nHello from the DiRouter mock transcriber.\n',
    );
    expect(usage.at(-1)).toMatchObject({
      inboundApi: 'openai.transcriptions',
      media: { seconds: 2.5 },
      costUsd: '0.00025000',
      usageEstimated: false,
    });

    const nova = await upload(
      [
        ['model', 'nova'],
        ['response_format', 'verbose_json'],
      ],
      wav(10),
    );
    expect(nova.headers.get('x-dirouter-provider')).toBe('deepgram');
    expect(await nova.json()).toMatchObject({
      duration: 10,
      language: 'en',
      text: 'Hello from the DiRouter mock transcriber.',
    });
    expect(usage.at(-1)).toMatchObject({ media: { seconds: 10 }, costUsd: '0.00071600' });

    const text = await upload(
      [
        ['model', 'whisper'],
        ['response_format', 'text'],
      ],
      wav(1),
    );
    expect(await text.text()).toBe('Hello from the DiRouter mock transcriber.\n');
  });

  it('rejects bad input and models without the capability', async () => {
    expect((await post('/v1/images/generations', { model: 'chat', prompt: 'x' })).status).toBe(400);
    expect(
      (await post('/v1/audio/speech', { model: 'whisper', input: 'x', voice: 'a' })).status,
    ).toBe(400);
    expect(
      (await post('/v1/images/generations', { model: 'gpt-image', prompt: 'x', n: 11 })).status,
    ).toBe(422);
    expect(
      (
        await post('/v1/audio/speech', {
          model: 'tts',
          input: 'x',
          voice: 'a',
          response_format: 'ogg',
        })
      ).status,
    ).toBe(422);
    expect((await upload([['response_format', 'json']], wav(1))).status).toBe(422);
    expect(
      (
        await upload(
          [
            ['model', 'whisper'],
            ['response_format', 'docx'],
          ],
          wav(1),
        )
      ).status,
    ).toBe(422);
    const unauth = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts', input: 'x', voice: 'a' }),
    });
    expect(unauth.status).toBe(401);
  });
});

describe('media helpers', () => {
  it('parses what encodeMultipart writes, binary included', () => {
    const data = Buffer.from([0, 255, 13, 10, 45, 45]);
    const form = encodeMultipart([
      ['model', 'whisper'],
      ['file', { data, filename: 'a.mp3', contentType: 'audio/mpeg' }],
      ['language', 'fa'],
    ]);
    const parsed = parseMultipart(Buffer.from(form.body), form.contentType);
    expect(parsed.fields).toEqual({ model: 'whisper', language: 'fa' });
    expect(parsed.file).toMatchObject({ filename: 'a.mp3', contentType: 'audio/mpeg' });
    expect(parsed.file?.data.equals(data)).toBe(true);
  });

  it('reads WAV length and renders subtitles', () => {
    expect(wavSeconds(wav(3))).toBe(3);
    expect(
      wavSeconds(Buffer.from('not a wav file at all, just some bytes here....')),
    ).toBeUndefined();
    const vtt = renderTranscript(
      {
        text: 'a b',
        segments: [
          { start: 0, end: 61.5, text: 'a' },
          { start: 61.5, end: 3_725.25, text: 'b' },
        ],
      },
      'vtt',
      3_725.25,
    );
    expect(vtt.body).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:01:01.500\na\n\n00:01:01.500 --> 01:02:05.250\nb\n',
    );
  });
});
