/** Media adapters (card 21.1): request shapes per provider and response parsing. */
import type { ModelConfig, ProviderConfig, ProviderType } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { adapterFor } from './adapters.js';
import { encodeMultipart, type MediaContext, mediaAdapterFor } from './media.js';

const ctx = (type: ProviderType, baseUrl: string, upstreamModel: string, options = {}) =>
  ({
    provider: {
      id: 'p',
      organizationId: 'o',
      slug: type,
      type,
      name: type,
      baseUrl,
      enabled: true,
      options,
      credentials: [],
    } satisfies ProviderConfig,
    model: {
      id: 'm',
      organizationId: 'o',
      slug: 'm',
      providerId: 'p',
      upstreamModel,
      enabled: true,
      pricing: { inputPerMTok: '0', outputPerMTok: '0' },
      capabilities: {
        streaming: false,
        tools: false,
        vision: false,
        reasoning: false,
        jsonMode: false,
        embeddings: false,
      },
    } satisfies ModelConfig,
    apiKey: 'secret',
  }) satisfies MediaContext;

const audio = new Uint8Array([1, 2, 3, 4]);
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe('images', () => {
  it('OpenAI: response_format only for dall-e; tokens and revised prompt parsed', () => {
    const images = mediaAdapterFor('openai').images;
    const dalle = images?.build(ctx('openai', 'https://api.openai.com/v1/', 'dall-e-3'), {
      prompt: 'a cat',
      n: 1,
      size: '1024x1024',
      responseFormat: 'url',
    });
    expect(dalle?.url).toBe('https://api.openai.com/v1/images/generations');
    expect(JSON.parse(dalle?.body ?? '')).toMatchObject({
      model: 'dall-e-3',
      response_format: 'url',
    });
    const gpt = images?.build(ctx('openai', 'https://x.test/v1', 'gpt-image-1'), {
      prompt: 'a cat',
      n: 2,
      responseFormat: 'url',
    });
    expect(JSON.parse(gpt?.body ?? '')).not.toHaveProperty('response_format');
    expect(
      images?.parse({
        data: [{ b64_json: 'AAA', revised_prompt: 'a fluffy cat' }],
        usage: { input_tokens: 10, output_tokens: 4160 },
      }),
    ).toEqual({
      images: [{ b64Json: 'AAA', revisedPrompt: 'a fluffy cat' }],
      usage: { inputTokens: 10, outputTokens: 4160 },
    });
  });

  it('Gemini Imagen: predict with sample count and aspect ratio', () => {
    const images = mediaAdapterFor('gemini').images;
    const up = images?.build(
      ctx('gemini', 'https://generativelanguage.googleapis.com', 'models/imagen-4.0-generate-001'),
      { prompt: 'a cat', n: 2, size: '1792x1024', responseFormat: 'b64_json' },
    );
    expect(up?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict',
    );
    expect(up?.headers['x-goog-api-key']).toBe('secret');
    expect(JSON.parse(up?.body ?? '')).toEqual({
      instances: [{ prompt: 'a cat' }],
      parameters: { sampleCount: 2, aspectRatio: '16:9' },
    });
    expect(images?.parse({ predictions: [{ bytesBase64Encoded: 'BBB' }, {}] })).toEqual({
      images: [{ b64Json: 'BBB' }],
    });
  });

  it('Fal: model path, Key auth and image size', () => {
    const images = mediaAdapterFor('fal').images;
    const up = images?.build(ctx('fal', 'https://fal.run', 'fal-ai/flux/dev'), {
      prompt: 'a cat',
      n: 1,
      size: '512x768',
      responseFormat: 'url',
    });
    expect(up?.url).toBe('https://fal.run/fal-ai/flux/dev');
    expect(up?.headers.authorization).toBe('Key secret');
    expect(JSON.parse(up?.body ?? '')).toEqual({
      prompt: 'a cat',
      num_images: 1,
      image_size: { width: 512, height: 768 },
    });
    expect(images?.parse({ images: [{ url: 'https://cdn.test/1.png' }] })).toEqual({
      images: [{ url: 'https://cdn.test/1.png' }],
    });
  });
});

describe('speech', () => {
  const speech = { input: 'Hello', voice: 'alloy', format: 'mp3' as const };

  it('OpenAI, ElevenLabs (mapped voice) and Deepgram', () => {
    const oa = mediaAdapterFor('openai').speech?.build(
      ctx('openai', 'https://x.test/v1', 'tts-1'),
      { ...speech, speed: 1.2 },
    );
    expect(oa?.url).toBe('https://x.test/v1/audio/speech');
    expect(JSON.parse(oa?.body ?? '')).toEqual({
      model: 'tts-1',
      input: 'Hello',
      voice: 'alloy',
      response_format: 'mp3',
      speed: 1.2,
    });

    const el = mediaAdapterFor('elevenlabs').speech?.build(
      ctx('elevenlabs', 'https://api.elevenlabs.io/v1', 'eleven_multilingual_v2', {
        voices: { alloy: 'voice123' },
      }),
      { ...speech, format: 'wav' },
    );
    expect(el?.url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=wav_44100',
    );
    expect(el?.headers['xi-api-key']).toBe('secret');
    expect(JSON.parse(el?.body ?? '')).toEqual({
      text: 'Hello',
      model_id: 'eleven_multilingual_v2',
    });

    const dg = mediaAdapterFor('deepgram').speech?.build(
      ctx('deepgram', 'https://api.deepgram.com/v1', 'aura-2-thalia-en'),
      { ...speech, format: 'opus' },
    );
    expect(dg?.url).toBe(
      'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=opus&container=ogg',
    );
    expect(dg?.headers.authorization).toBe('Token secret');
  });
});

describe('transcription', () => {
  const req = { audio, filename: 'a.wav', contentType: 'audio/wav', language: 'fa' };

  it('OpenAI: multipart with verbose_json for whisper; duration or usage parsed', () => {
    const t = mediaAdapterFor('openai').transcription;
    const up = t?.build(ctx('openai', 'https://x.test/v1', 'whisper-1'), req);
    expect(up?.url).toBe('https://x.test/v1/audio/transcriptions');
    expect(up?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = text(up?.bytes);
    expect(body).toContain('name="response_format"\r\n\r\nverbose_json');
    expect(body).toContain('filename="a.wav"\r\nContent-Type: audio/wav');
    expect(body).toContain('name="language"\r\n\r\nfa');
    expect(
      t?.parse({
        text: 'hi',
        language: 'persian',
        duration: 3.5,
        segments: [{ start: 0, end: 3.5, text: 'hi' }],
      }),
    ).toEqual({
      text: 'hi',
      language: 'persian',
      seconds: 3.5,
      segments: [{ start: 0, end: 3.5, text: 'hi' }],
    });
    expect(t?.parse({ text: 'hi', usage: { type: 'duration', seconds: 2 } })).toMatchObject({
      seconds: 2,
    });
    const gpt = t?.build(ctx('openai', 'https://x.test/v1', 'gpt-4o-transcribe'), req);
    expect(text(gpt?.bytes)).toContain('name="response_format"\r\n\r\njson');
    expect(
      t?.parse({ text: 'hi', usage: { type: 'tokens', input_tokens: 50, output_tokens: 3 } }),
    ).toEqual({ text: 'hi', usage: { inputTokens: 50, outputTokens: 3 } });
  });

  it('Deepgram: raw audio, utterances and duration', () => {
    const t = mediaAdapterFor('deepgram').transcription;
    const up = t?.build(ctx('deepgram', 'https://api.deepgram.com/v1', 'nova-3'), req);
    expect(up?.url).toBe(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&utterances=true&language=fa',
    );
    expect(up?.bytes).toBe(audio);
    expect(up?.headers['content-type']).toBe('audio/wav');
    expect(
      t?.parse({
        metadata: { duration: 12.25 },
        results: {
          channels: [{ alternatives: [{ transcript: 'Hello there.' }], detected_language: 'en' }],
          utterances: [{ start: 0.1, end: 1.2, transcript: 'Hello there.' }],
        },
      }),
    ).toEqual({
      text: 'Hello there.',
      language: 'en',
      seconds: 12.25,
      segments: [{ start: 0.1, end: 1.2, text: 'Hello there.' }],
    });
  });

  it('ElevenLabs: multipart model_id; words grouped into segments', () => {
    const t = mediaAdapterFor('elevenlabs').transcription;
    const up = t?.build(ctx('elevenlabs', 'https://api.elevenlabs.io/v1', 'scribe_v1'), req);
    expect(up?.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(text(up?.bytes)).toContain('name="model_id"\r\n\r\nscribe_v1');
    expect(
      t?.parse({
        text: 'Hi. Bye',
        language_code: 'en',
        words: [
          { text: 'Hi.', start: 0, end: 0.4, type: 'word' },
          { text: ' ', start: 0.4, end: 0.5, type: 'spacing' },
          { text: '(laughs)', start: 0.5, end: 0.9, type: 'audio_event' },
          { text: 'Bye', start: 1, end: 1.3, type: 'word' },
        ],
      }),
    ).toEqual({
      text: 'Hi. Bye',
      language: 'en',
      seconds: 1.3,
      segments: [
        { start: 0, end: 0.4, text: 'Hi.' },
        { start: 0.4, end: 1.3, text: 'Bye' },
      ],
    });
  });
});

describe('media-only providers and multipart', () => {
  it('ElevenLabs, Deepgram and Fal refuse chat and list their models', () => {
    const el = adapterFor('elevenlabs');
    expect(() => el.buildRequest({} as never)).toThrow(/only serves images and audio/);
    expect(el.parseModelList([{ model_id: 'eleven_v3' }])).toEqual(['eleven_v3']);
    expect(
      adapterFor('deepgram').parseModelList({
        stt: [{ canonical_name: 'nova-3' }],
        tts: [{ canonical_name: 'aura-2-thalia-en' }],
      }),
    ).toEqual(['nova-3', 'aura-2-thalia-en']);
    expect(adapterFor('fal').parseModelList({})).toEqual([]);
    expect(mediaAdapterFor('anthropic')).toEqual({});
  });

  it('encodes fields and files, skipping undefined values', () => {
    const { body, contentType } = encodeMultipart([
      ['a', '1'],
      ['skip', undefined],
      ['file', { data: new Uint8Array([0xff, 0x00]), filename: 'x"y.bin', contentType: 'x/y' }],
    ]);
    const boundary = contentType.split('boundary=')[1] ?? '';
    const raw = Buffer.from(body).toString('latin1');
    expect(raw.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="a"`)).toBe(true);
    expect(raw).not.toContain('skip');
    expect(raw).toContain('filename="x_y.bin"\r\nContent-Type: x/y\r\n\r\n\xff\x00\r\n');
    expect(raw.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });
});

describe('image edits, variations and translations (card 30.4)', () => {
  const png = {
    data: new Uint8Array([137, 80, 78, 71]),
    filename: 'a.png',
    contentType: 'image/png',
  };

  it('edits: one image as `image`, several as `image[]`, response_format only for dall-e', () => {
    const adapter = mediaAdapterFor('openai').images;
    const one = adapter?.edit?.(ctx('openai', 'https://api.openai.com/v1', 'dall-e-2'), {
      images: [png],
      mask: { ...png, filename: 'm.png' },
      prompt: 'a hat',
      n: 2,
      size: '512x512',
      responseFormat: 'url',
    });
    expect(one?.url).toBe('https://api.openai.com/v1/images/edits');
    expect(one?.headers).toMatchObject({ authorization: 'Bearer secret' });
    const body = text(one?.bytes);
    expect(body).toContain('name="image"; filename="a.png"');
    expect(body).toContain('name="mask"; filename="m.png"');
    expect(body).toContain('name="response_format"\r\n\r\nurl');
    const many = adapter?.edit?.(ctx('openai', 'https://api.openai.com/v1', 'gpt-image-1'), {
      images: [png, { ...png, filename: 'b.png' }],
      prompt: 'merge',
      n: 1,
      inputFidelity: 'high',
      responseFormat: 'url',
    });
    const manyBody = text(many?.bytes);
    expect(manyBody.match(/name="image\[\]"/g)).toHaveLength(2);
    expect(manyBody).toContain('name="input_fidelity"\r\n\r\nhigh');
    expect(manyBody).not.toContain('response_format');
  });

  it('variations and translations go to their own endpoints', () => {
    const varied = mediaAdapterFor('openai-compatible').images?.variation?.(
      ctx('openai-compatible', 'http://h/v1', 'dall-e-2'),
      { image: png, n: 3, responseFormat: 'b64_json' },
    );
    expect(varied?.url).toBe('http://h/v1/images/variations');
    expect(text(varied?.bytes)).toContain('name="n"\r\n\r\n3');
    const translation = mediaAdapterFor('openai').translation;
    const up = translation?.build(ctx('openai', 'http://h/v1', 'whisper-1'), {
      audio,
      filename: 's.wav',
      contentType: 'audio/wav',
      language: 'fa',
      prompt: 'context',
    });
    expect(up?.url).toBe('http://h/v1/audio/translations');
    // Whisper reports the duration in verbose_json; translations take no language.
    expect(text(up?.bytes)).toContain('name="response_format"\r\n\r\nverbose_json');
    expect(text(up?.bytes)).not.toContain('name="language"');
    expect(translation?.parse({ text: 'hi', duration: 2.5, language: 'english' })).toEqual({
      text: 'hi',
      seconds: 2.5,
      language: 'english',
    });
    expect(mediaAdapterFor('deepgram').translation).toBeUndefined();
    expect(mediaAdapterFor('gemini').images && 'edit' in mediaAdapterFor('gemini').images!).toBe(
      false,
    );
  });
});
