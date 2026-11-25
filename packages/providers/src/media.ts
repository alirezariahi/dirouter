/**
 * Media adapters (card 21.1): image generation, text to speech and speech to text.
 *
 * Like the chat adapters they only know request and response shapes. Each provider type supports
 * the services it actually offers:
 *
 * | type                          | images | speech | transcription |
 * | ----------------------------- | ------ | ------ | ------------- |
 * | openai, openai-compatible, mock | yes  | yes    | yes           |
 * | gemini (Imagen)               | yes    |        |               |
 * | fal                           | yes    |        |               |
 * | elevenlabs                    |        | yes    | yes           |
 * | deepgram                      |        | yes    | yes           |
 *
 * Image edits and variations and audio translation (card 30.4) exist for the OpenAI shape only.
 */
import type {
  CanonicalResponse,
  ModelConfig,
  ProviderConfig,
  ProviderType,
} from '@dirouter/contracts';

import {
  type ProviderAdapter,
  type StreamDecoder,
  type UpstreamRequest,
  geminiModel,
  geminiVersion,
} from './adapters.js';
import { type ClassifiedError, type HttpErrorInput, classifyHttpError } from './errors.js';

export interface MediaContext {
  provider: ProviderConfig;
  model: ModelConfig;
  apiKey: string;
  credentialHeaders?: Record<string, string>;
}

export interface ImageRequest {
  prompt: string;
  n: number;
  /** `WIDTHxHEIGHT`, e.g. `1024x1024`. */
  size?: string;
  quality?: string;
  /** What the client wants back; providers that only return one form are converted by the gateway. */
  responseFormat: 'url' | 'b64_json';
}
export interface GeneratedImage {
  url?: string;
  b64Json?: string;
  revisedPrompt?: string;
}
/** An uploaded image (edits and variations, card 30.4). */
export interface ImageUpload {
  data: Uint8Array;
  filename: string;
  contentType: string;
}
export interface ImageEditRequest {
  /** One image, or several for gpt-image models. */
  images: ImageUpload[];
  mask?: ImageUpload;
  prompt: string;
  n: number;
  size?: string;
  quality?: string;
  background?: string;
  inputFidelity?: string;
  outputFormat?: string;
  /** Unset: whatever the model answers with (gpt-image: base64, dall-e: URLs). */
  responseFormat?: 'url' | 'b64_json';
}
export interface ImageVariationRequest {
  image: ImageUpload;
  n: number;
  size?: string;
  responseFormat?: 'url' | 'b64_json';
}

export interface ImageResult {
  images: GeneratedImage[];
  usage?: { inputTokens: number; outputTokens: number };
}

export const AUDIO_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];
export const AUDIO_CONTENT_TYPES: Readonly<Record<AudioFormat, string>> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

export interface SpeechRequest {
  input: string;
  voice: string;
  format: AudioFormat;
  speed?: number;
  instructions?: string;
}

export interface TranscriptionRequest {
  audio: Uint8Array;
  filename: string;
  contentType: string;
  language?: string;
  prompt?: string;
  temperature?: number;
}
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}
export interface TranscriptionResult {
  text: string;
  language?: string;
  /** Audio length as reported by the provider. */
  seconds?: number;
  segments?: TranscriptSegment[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface MediaAdapter {
  images?: {
    build(ctx: MediaContext, req: ImageRequest): UpstreamRequest;
    parse(json: unknown): ImageResult;
    /** `/v1/images/edits` and `/v1/images/variations` (card 30.4); answers parse like `build`. */
    edit?(ctx: MediaContext, req: ImageEditRequest): UpstreamRequest;
    variation?(ctx: MediaContext, req: ImageVariationRequest): UpstreamRequest;
  };
  /** The upstream answers with the audio bytes in the requested format. */
  speech?: { build(ctx: MediaContext, req: SpeechRequest): UpstreamRequest };
  transcription?: {
    build(ctx: MediaContext, req: TranscriptionRequest): UpstreamRequest;
    parse(json: unknown): TranscriptionResult;
  };
  /** Speech to English text, `/v1/audio/translations` (card 30.4); parsed like transcription. */
  translation?: {
    build(ctx: MediaContext, req: TranscriptionRequest): UpstreamRequest;
    parse(json: unknown): TranscriptionResult;
  };
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');
const json = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ctx: MediaContext,
): UpstreamRequest => ({
  url,
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers, ...ctx.credentialHeaders },
  body: JSON.stringify(body),
});
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// ───────────── multipart/form-data ─────────────

export type FormValue = string | { data: Uint8Array; filename: string; contentType: string };

/** Encodes a multipart body (no dependency on a particular FormData implementation). */
export function encodeMultipart(fields: [string, FormValue | undefined][]): {
  body: Uint8Array;
  contentType: string;
} {
  const boundary = `dirouter-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const quote = (s: string) => s.replace(/["\r\n]/g, '_');
  for (const [name, value] of fields) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      chunks.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`,
        ),
      );
    } else {
      chunks.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"; filename="${quote(value.filename)}"\r\nContent-Type: ${value.contentType}\r\n\r\n`,
        ),
        value.data,
        encoder.encode('\r\n'),
      );
    }
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Segments → one transcript, for providers that return words only. */
function wordsToSegments(words: { text: string; start: number; end: number }[]) {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | undefined;
  for (const w of words) {
    current ??= { start: w.start, end: w.end, text: '' };
    current.text += w.text;
    current.end = w.end;
    if (/[.!?؟。]\s*$/.test(w.text)) {
      segments.push({ ...current, text: current.text.trim() });
      current = undefined;
    }
  }
  if (current?.text.trim()) segments.push({ ...current, text: current.text.trim() });
  return segments;
}

// ───────────── OpenAI (and compatible servers) ─────────────

const bearer = (apiKey: string): Record<string, string> =>
  apiKey ? { authorization: `Bearer ${apiKey}` } : {};

const multipart = (
  ctx: MediaContext,
  path: string,
  fields: [string, FormValue | undefined][],
): UpstreamRequest => {
  const form = encodeMultipart(fields);
  return {
    url: `${trimSlash(ctx.provider.baseUrl)}${path}`,
    method: 'POST',
    headers: { 'content-type': form.contentType, ...bearer(ctx.apiKey), ...ctx.credentialHeaders },
    bytes: form.body,
  };
};

/** Whisper reports the duration only in verbose_json; newer models report usage in json. */
const audioForm = (ctx: MediaContext, req: TranscriptionRequest, language: boolean) => {
  const verbose = ctx.model.upstreamModel.includes('whisper');
  return [
    ['model', ctx.model.upstreamModel],
    ['file', { data: req.audio, filename: req.filename, contentType: req.contentType }],
    ['response_format', verbose ? 'verbose_json' : 'json'],
    ['language', language ? req.language : undefined],
    ['prompt', req.prompt],
    ['temperature', req.temperature !== undefined ? String(req.temperature) : undefined],
  ] as [string, FormValue | undefined][];
};

const openai: MediaAdapter = {
  images: {
    edit: (ctx, req) => {
      const dalle = ctx.model.upstreamModel.startsWith('dall-e');
      const field = req.images.length > 1 ? 'image[]' : 'image';
      return multipart(ctx, '/images/edits', [
        ['model', ctx.model.upstreamModel],
        ...req.images.map((image): [string, FormValue] => [field, image]),
        ['mask', req.mask],
        ['prompt', req.prompt],
        ['n', String(req.n)],
        ['size', req.size],
        ['quality', req.quality],
        ['background', req.background],
        ['input_fidelity', req.inputFidelity],
        ['output_format', req.outputFormat],
        ['response_format', dalle ? req.responseFormat : undefined],
      ]);
    },
    variation: (ctx, req) =>
      multipart(ctx, '/images/variations', [
        ['model', ctx.model.upstreamModel],
        ['image', req.image],
        ['n', String(req.n)],
        ['size', req.size],
        ['response_format', req.responseFormat],
      ]),
    build: (ctx, req) =>
      json(
        `${trimSlash(ctx.provider.baseUrl)}/images/generations`,
        bearer(ctx.apiKey),
        {
          model: ctx.model.upstreamModel,
          prompt: req.prompt,
          n: req.n,
          ...(req.size ? { size: req.size } : {}),
          ...(req.quality ? { quality: req.quality } : {}),
          // gpt-image models always answer in base64 and reject the parameter.
          ...(ctx.model.upstreamModel.startsWith('dall-e')
            ? { response_format: req.responseFormat }
            : {}),
        },
        ctx,
      ),
    parse: (body) => {
      const b = record(body);
      const usage = record(b.usage);
      const input = num(usage.input_tokens);
      const output = num(usage.output_tokens);
      return {
        images: (Array.isArray(b.data) ? b.data : []).map((item) => {
          const d = record(item);
          const url = str(d.url);
          const b64Json = str(d.b64_json);
          const revisedPrompt = str(d.revised_prompt);
          return {
            ...(url ? { url } : {}),
            ...(b64Json ? { b64Json } : {}),
            ...(revisedPrompt ? { revisedPrompt } : {}),
          };
        }),
        ...(input !== undefined || output !== undefined
          ? { usage: { inputTokens: input ?? 0, outputTokens: output ?? 0 } }
          : {}),
      };
    },
  },
  speech: {
    build: (ctx, req) =>
      json(
        `${trimSlash(ctx.provider.baseUrl)}/audio/speech`,
        bearer(ctx.apiKey),
        {
          model: ctx.model.upstreamModel,
          input: req.input,
          voice: req.voice,
          response_format: req.format,
          ...(req.speed !== undefined ? { speed: req.speed } : {}),
          ...(req.instructions ? { instructions: req.instructions } : {}),
        },
        ctx,
      ),
  },
  transcription: {
    build: (ctx, req) => multipart(ctx, '/audio/transcriptions', audioForm(ctx, req, true)),
    parse: (body) => parseOpenAITranscript(body),
  },
  // The source language is detected; translations take no `language`.
  translation: {
    build: (ctx, req) => multipart(ctx, '/audio/translations', audioForm(ctx, req, false)),
    parse: (body) => parseOpenAITranscript(body),
  },
};

function parseOpenAITranscript(body: unknown): TranscriptionResult {
  const b = record(body);
  const usage = record(b.usage);
  const seconds = num(b.duration) ?? (usage.type === 'duration' ? num(usage.seconds) : undefined);
  const input = num(usage.input_tokens);
  const segments = Array.isArray(b.segments)
    ? b.segments.map((item) => {
        const s = record(item);
        return { start: num(s.start) ?? 0, end: num(s.end) ?? 0, text: str(s.text) ?? '' };
      })
    : undefined;
  const language = str(b.language);
  return {
    text: str(b.text) ?? '',
    ...(language ? { language } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(segments ? { segments } : {}),
    ...(input !== undefined
      ? { usage: { inputTokens: input, outputTokens: num(usage.output_tokens) ?? 0 } }
      : {}),
  };
}

// ───────────── Gemini (Imagen) ─────────────

const ASPECT_RATIOS: Readonly<Record<string, string>> = {
  '1024x1024': '1:1',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1792x1024': '16:9',
  '1024x1792': '9:16',
};

const gemini: MediaAdapter = {
  images: {
    build: (ctx, req) =>
      json(
        `${trimSlash(ctx.provider.baseUrl)}/${geminiVersion(ctx.provider)}/models/${encodeURIComponent(geminiModel(ctx.model.upstreamModel))}:predict`,
        { 'x-goog-api-key': ctx.apiKey },
        {
          instances: [{ prompt: req.prompt }],
          parameters: {
            sampleCount: req.n,
            ...(req.size && ASPECT_RATIOS[req.size]
              ? { aspectRatio: ASPECT_RATIOS[req.size] }
              : {}),
          },
        },
        ctx,
      ),
    parse: (body) => ({
      images: (Array.isArray(record(body).predictions)
        ? (record(body).predictions as unknown[])
        : []
      )
        .map((p) => str(record(p).bytesBase64Encoded))
        .filter((b64): b64 is string => Boolean(b64))
        .map((b64Json) => ({ b64Json })),
    }),
  },
};

// ───────────── Fal ─────────────

const fal: MediaAdapter = {
  images: {
    build: (ctx, req) => {
      const [width, height] = (req.size ?? '').split('x').map(Number);
      return json(
        `${trimSlash(ctx.provider.baseUrl)}/${ctx.model.upstreamModel}`,
        { authorization: `Key ${ctx.apiKey}` },
        {
          prompt: req.prompt,
          num_images: req.n,
          ...(width && height ? { image_size: { width, height } } : {}),
        },
        ctx,
      );
    },
    parse: (body) => ({
      images: (Array.isArray(record(body).images) ? (record(body).images as unknown[]) : [])
        .map((i) => str(record(i).url))
        .filter((url): url is string => Boolean(url))
        .map((url) => ({ url })),
    }),
  },
};

// ───────────── ElevenLabs ─────────────

const ELEVENLABS_FORMATS: Readonly<Partial<Record<AudioFormat, string>>> = {
  mp3: 'mp3_44100_128',
  opus: 'opus_48000_128',
  wav: 'wav_44100',
  pcm: 'pcm_24000',
};

const elevenlabs: MediaAdapter = {
  speech: {
    build: (ctx, req) => {
      // OpenAI voice names can be mapped to ElevenLabs voice ids per provider.
      const voices = record(ctx.provider.options.voices);
      const voice = str(voices[req.voice]) ?? req.voice;
      const format = ELEVENLABS_FORMATS[req.format] ?? 'mp3_44100_128';
      return json(
        `${trimSlash(ctx.provider.baseUrl)}/text-to-speech/${encodeURIComponent(voice)}?output_format=${format}`,
        { 'xi-api-key': ctx.apiKey },
        {
          text: req.input,
          model_id: ctx.model.upstreamModel,
          ...(req.speed !== undefined ? { voice_settings: { speed: req.speed } } : {}),
        },
        ctx,
      );
    },
  },
  transcription: {
    build: (ctx, req) => {
      const form = encodeMultipart([
        ['model_id', ctx.model.upstreamModel],
        ['file', { data: req.audio, filename: req.filename, contentType: req.contentType }],
        ['language_code', req.language],
      ]);
      return {
        url: `${trimSlash(ctx.provider.baseUrl)}/speech-to-text`,
        method: 'POST',
        headers: {
          'content-type': form.contentType,
          'xi-api-key': ctx.apiKey,
          ...ctx.credentialHeaders,
        },
        bytes: form.body,
      };
    },
    parse: (body) => {
      const b = record(body);
      const words = (Array.isArray(b.words) ? b.words : [])
        .map(record)
        .filter((w) => w.type !== 'audio_event')
        .map((w) => ({ text: str(w.text) ?? '', start: num(w.start) ?? 0, end: num(w.end) ?? 0 }));
      const language = str(b.language_code);
      const last = words.at(-1);
      return {
        text: str(b.text) ?? '',
        ...(language ? { language } : {}),
        // ElevenLabs does not report the audio length; the last word's end is the closest figure.
        ...(last ? { seconds: last.end } : {}),
        ...(words.length > 0 ? { segments: wordsToSegments(words) } : {}),
      };
    },
  },
};

// ───────────── Deepgram ─────────────

const DEEPGRAM_ENCODINGS: Readonly<Record<AudioFormat, string>> = {
  mp3: 'encoding=mp3',
  opus: 'encoding=opus&container=ogg',
  aac: 'encoding=aac',
  flac: 'encoding=flac',
  wav: 'encoding=linear16&container=wav',
  pcm: 'encoding=linear16&container=none',
};

const deepgram: MediaAdapter = {
  speech: {
    // Deepgram's model name carries the voice (e.g. aura-2-thalia-en).
    build: (ctx, req) =>
      json(
        `${trimSlash(ctx.provider.baseUrl)}/speak?model=${encodeURIComponent(ctx.model.upstreamModel)}&${DEEPGRAM_ENCODINGS[req.format]}`,
        { authorization: `Token ${ctx.apiKey}` },
        { text: req.input },
        ctx,
      ),
  },
  transcription: {
    build: (ctx, req) => {
      const query = new URLSearchParams({
        model: ctx.model.upstreamModel,
        smart_format: 'true',
        utterances: 'true',
        ...(req.language ? { language: req.language } : { detect_language: 'true' }),
      });
      return {
        url: `${trimSlash(ctx.provider.baseUrl)}/listen?${query.toString()}`,
        method: 'POST',
        headers: {
          'content-type': req.contentType,
          authorization: `Token ${ctx.apiKey}`,
          ...ctx.credentialHeaders,
        },
        bytes: req.audio,
      };
    },
    parse: (body) => {
      const b = record(body);
      const results = record(b.results);
      const channel = record(Array.isArray(results.channels) ? results.channels[0] : undefined);
      const alternative = record(
        Array.isArray(channel.alternatives) ? channel.alternatives[0] : undefined,
      );
      const seconds = num(record(b.metadata).duration);
      const language = str(channel.detected_language);
      const segments = Array.isArray(results.utterances)
        ? results.utterances.map((item) => {
            const u = record(item);
            return {
              start: num(u.start) ?? 0,
              end: num(u.end) ?? 0,
              text: str(u.transcript) ?? '',
            };
          })
        : undefined;
      return {
        text: str(alternative.transcript) ?? '',
        ...(language ? { language } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
        ...(segments ? { segments } : {}),
      };
    },
  },
};

const MEDIA: Partial<Record<ProviderType, MediaAdapter>> = {
  openai,
  'openai-compatible': openai,
  mock: openai,
  gemini,
  fal,
  elevenlabs,
  deepgram,
};

export function mediaAdapterFor(type: ProviderType): MediaAdapter {
  return MEDIA[type] ?? {};
}

// ───────────── Chat adapters for media-only providers ─────────────

/** ElevenLabs, Deepgram and Fal serve no chat; this adapter covers discovery and errors. */
export class MediaOnlyAdapter implements ProviderAdapter {
  constructor(readonly type: 'elevenlabs' | 'deepgram' | 'fal') {}

  #unsupported(): never {
    throw new Error(`${this.type} only serves images and audio`);
  }
  buildRequest(): UpstreamRequest {
    this.#unsupported();
  }
  parseResponse(): CanonicalResponse {
    this.#unsupported();
  }
  createStreamDecoder(): StreamDecoder {
    this.#unsupported();
  }
  classifyError(input: HttpErrorInput): ClassifiedError {
    return classifyHttpError(input);
  }
  listModelsRequest(provider: ProviderConfig, apiKey: string): UpstreamRequest {
    const base = trimSlash(provider.baseUrl);
    if (this.type === 'elevenlabs')
      return { url: `${base}/models`, method: 'GET', headers: { 'xi-api-key': apiKey } };
    if (this.type === 'deepgram')
      return {
        url: `${base}/models`,
        method: 'GET',
        headers: { authorization: `Token ${apiKey}` },
      };
    // Fal has no model list endpoint; its models are entered by hand.
    return { url: base, method: 'GET', headers: {} };
  }
  parseModelList(body: unknown): string[] {
    if (Array.isArray(body))
      return body.map((m) => str(record(m).model_id)).filter((id): id is string => Boolean(id));
    const b = record(body);
    return [
      ...(Array.isArray(b.stt) ? (b.stt as unknown[]) : []),
      ...(Array.isArray(b.tts) ? (b.tts as unknown[]) : []),
    ]
      .map((m) => str(record(m).canonical_name))
      .filter((id): id is string => Boolean(id));
  }
}
