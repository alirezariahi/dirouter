/**
 * Image generation, text to speech and speech to text (card 21.1), OpenAI-compatible:
 * `/v1/images/generations`, `/v1/audio/speech` and `/v1/audio/transcriptions`; and since card
 * 30.4 `/v1/images/edits`, `/v1/images/variations` (multipart uploads) and
 * `/v1/audio/translations` (speech to English text).
 *
 * They run through the same pipeline as chat (routing, fallback, limits, budgets, wallet) and are
 * priced per image, per million characters and per second of audio, plus any token price the
 * provider reports (gpt-image, gpt-4o-transcribe).
 */
import {
  AUDIO_CONTENT_TYPES,
  AUDIO_FORMATS,
  type AudioFormat,
  type ImageResult,
  mediaAdapterFor,
  type TranscriptionResult,
} from '@dirouter/providers';
import type { Candidate } from '@dirouter/routing';
import { DiRouterError, ValidationError } from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { capable, type MeteredResult, runMetered } from './metered.js';
import type { ProxyDeps } from './proxy.js';

/** OpenAI's limits: 25 MB of audio, 4,096 characters of speech, 10 images per request. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_SPEECH_CHARS = 4_096;
const MAX_IMAGES = 10;
/** Output tokens of one gpt-image result at its largest size and quality (wallet worst case). */
const WORST_IMAGE_TOKENS = 6_240;

const ctx = (candidate: Candidate, apiKey: string) => ({
  provider: candidate.provider,
  model: candidate.model,
  apiKey,
  credentialHeaders: candidate.credential.headers,
});

function sendError(
  reply: FastifyReply,
  result: { error: DiRouterError; headers?: Record<string, string> },
) {
  for (const [name, value] of Object.entries(result.headers ?? {})) void reply.header(name, value);
  reply.status(result.error.status).send(result.error.toOpenAI());
}

function sendOk<T>(reply: FastifyReply, result: Extract<MeteredResult<T>, { ok: true }>) {
  for (const [name, value] of Object.entries(result.headers ?? {})) void reply.header(name, value);
  void reply
    .header('x-dirouter-model', result.candidate.model.slug)
    .header('x-dirouter-provider', result.candidate.provider.slug);
}

const invalid = (path: string, message: string) => new ValidationError([{ path, message }]);

// ───────────── Images ─────────────

async function toBase64(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`image download failed (${String(res.status)})`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

export async function handleImages(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const n = body.n === undefined ? 1 : body.n;
  const responseFormat = body.response_format ?? 'url';
  try {
    if (typeof body.model !== 'string') throw invalid('model', 'model is required');
    if (typeof body.prompt !== 'string' || body.prompt === '')
      throw invalid('prompt', 'prompt is required');
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_IMAGES)
      throw invalid('n', `n must be an integer from 1 to ${String(MAX_IMAGES)}`);
    if (responseFormat !== 'url' && responseFormat !== 'b64_json')
      throw invalid('response_format', "response_format must be 'url' or 'b64_json'");
    if (body.size !== undefined && (typeof body.size !== 'string' || !/^\d+x\d+$/.test(body.size)))
      throw invalid('size', 'size must look like 1024x1024');
  } catch (error) {
    sendError(reply, { error: error as DiRouterError });
    return;
  }
  const model = body.model;
  const prompt = body.prompt;
  const estimatedInputTokens = Math.ceil(prompt.length / 4);

  const result = await runMetered<ImageResult>(req, deps, {
    inboundApi: 'openai.images',
    model,
    estimatedInputTokens,
    worstCase: {
      usage: { inputTokens: estimatedInputTokens, outputTokens: n * WORST_IMAGE_TOKENS },
      media: { images: n },
      estimated: true,
    },
    select: (candidates) =>
      capable(
        candidates,
        (c) => c.model.capabilities.images === true && !!mediaAdapterFor(c.provider.type).images,
        'image generation',
        model,
      ),
    build: (candidate, apiKey) =>
      mediaAdapterFor(candidate.provider.type).images?.build(ctx(candidate, apiKey), {
        prompt,
        n,
        responseFormat,
        ...(typeof body.size === 'string' ? { size: body.size } : {}),
        ...(typeof body.quality === 'string' ? { quality: body.quality } : {}),
      }),
    read: async (response, candidate) => {
      const parsed = mediaAdapterFor(candidate.provider.type).images?.parse(await response.json());
      if (!parsed || parsed.images.length === 0) throw new Error('the provider returned no image');
      return parsed;
    },
    // Images are billed as delivered, plus the tokens gpt-image reports.
    meter: (value) => ({
      usage: value.usage ?? {},
      media: { images: value.images.length },
      estimated: false,
    }),
  });
  if (!result.ok) {
    sendError(reply, result);
    return;
  }
  await sendImages(reply, result, responseFormat);
}

/**
 * The images in the form the client asked for; without `response_format` (edits) each image
 * keeps the form the provider gave, as OpenAI does (gpt-image answers in base64, dall-e with URLs).
 */
async function sendImages(
  reply: FastifyReply,
  result: Extract<MeteredResult<ImageResult>, { ok: true }>,
  responseFormat: 'url' | 'b64_json' | undefined,
): Promise<void> {
  sendOk(reply, result);
  // Give the client the form it asked for: providers that only return URLs are downloaded, and
  // base64-only results become data URLs.
  const data = await Promise.all(
    result.value.images.map(async (image) => {
      const revised = image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {};
      if (responseFormat === 'b64_json' || (responseFormat === undefined && image.b64Json))
        return { b64_json: image.b64Json ?? (await toBase64(image.url ?? '')), ...revised };
      return { url: image.url ?? `data:image/png;base64,${image.b64Json ?? ''}`, ...revised };
    }),
  ).catch((error: unknown) => error as Error);
  if (data instanceof Error) {
    sendError(reply, {
      error: new DiRouterError('upstream_error', { message: data.message }),
    });
    return;
  }
  const usage = result.value.usage;
  reply.status(200).send({
    created: Math.floor(Date.now() / 1000),
    data,
    ...(usage
      ? {
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        }
      : {}),
  });
}

// ───────────── Image edits and variations (card 30.4) ─────────────

/** gpt-image input tokens of one uploaded image at high fidelity (wallet worst case). */
const WORST_INPUT_IMAGE_TOKENS = 6_240;
const MAX_EDIT_IMAGES = 16;

function imageForm(req: FastifyRequest) {
  if (!Buffer.isBuffer(req.body))
    throw invalid('image', 'send the image as multipart/form-data with an image field');
  const parsed = parseMultipart(req.body, req.headers['content-type'] ?? '');
  const images = parsed.files
    .filter((f) => (f.name === 'image' || f.name === 'image[]') && f.data.length > 0)
    .map((f) => ({ data: f.data, filename: f.filename, contentType: f.contentType }));
  const mask = parsed.files.find((f) => f.name === 'mask' && f.data.length > 0);
  const { fields } = parsed;
  if (images.length === 0) throw invalid('image', 'image is required');
  if (!fields.model) throw invalid('model', 'model is required');
  const n = fields.n === undefined ? 1 : Number(fields.n);
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES)
    throw invalid('n', `n must be an integer from 1 to ${String(MAX_IMAGES)}`);
  const responseFormat = fields.response_format;
  if (responseFormat !== undefined && responseFormat !== 'url' && responseFormat !== 'b64_json')
    throw invalid('response_format', "response_format must be 'url' or 'b64_json'");
  if (fields.size !== undefined && !/^(\d+x\d+|auto)$/.test(fields.size))
    throw invalid('size', 'size must look like 1024x1024');
  const format: 'url' | 'b64_json' | undefined = responseFormat;
  return {
    fields,
    model: fields.model,
    images,
    n,
    responseFormat: format,
    ...(mask
      ? { mask: { data: mask.data, filename: mask.filename, contentType: mask.contentType } }
      : {}),
  };
}

async function editOrVary(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
  kind: 'edit' | 'variation',
): Promise<void> {
  let form: ReturnType<typeof imageForm>;
  try {
    form = imageForm(req);
    if (kind === 'edit' && !form.fields.prompt) throw invalid('prompt', 'prompt is required');
    if (kind === 'edit' && form.images.length > MAX_EDIT_IMAGES)
      throw invalid('image', `at most ${String(MAX_EDIT_IMAGES)} images`);
    if (kind === 'variation' && form.images.length > 1)
      throw invalid('image', 'a variation takes exactly one image');
  } catch (error) {
    sendError(reply, {
      error: error instanceof DiRouterError ? error : invalid('image', 'malformed multipart body'),
    });
    return;
  }
  const { fields, model, images, n, responseFormat } = form;
  const prompt = fields.prompt ?? '';
  const estimatedInputTokens = Math.ceil(prompt.length / 4);
  const result = await runMetered<ImageResult>(req, deps, {
    inboundApi: 'openai.images',
    model,
    estimatedInputTokens,
    worstCase: {
      usage: {
        inputTokens: estimatedInputTokens + images.length * WORST_INPUT_IMAGE_TOKENS,
        outputTokens: n * WORST_IMAGE_TOKENS,
      },
      media: { images: n },
      estimated: true,
    },
    select: (candidates) =>
      capable(
        candidates,
        (c) =>
          c.model.capabilities.images === true && !!mediaAdapterFor(c.provider.type).images?.[kind],
        kind === 'edit' ? 'image editing' : 'image variations',
        model,
      ),
    build: (candidate, apiKey) => {
      const adapter = mediaAdapterFor(candidate.provider.type).images;
      const context = ctx(candidate, apiKey);
      const [first] = images;
      if (kind === 'variation')
        return first
          ? adapter?.variation?.(context, {
              image: first,
              n,
              responseFormat,
              ...(fields.size ? { size: fields.size } : {}),
            })
          : undefined;
      return adapter?.edit?.(context, {
        images,
        prompt,
        n,
        responseFormat,
        ...(form.mask ? { mask: form.mask } : {}),
        ...(fields.size ? { size: fields.size } : {}),
        ...(fields.quality ? { quality: fields.quality } : {}),
        ...(fields.background ? { background: fields.background } : {}),
        ...(fields.input_fidelity ? { inputFidelity: fields.input_fidelity } : {}),
        ...(fields.output_format ? { outputFormat: fields.output_format } : {}),
      });
    },
    read: async (response, candidate) => {
      const parsed = mediaAdapterFor(candidate.provider.type).images?.parse(await response.json());
      if (!parsed || parsed.images.length === 0) throw new Error('the provider returned no image');
      return parsed;
    },
    // Billed like generation: per image delivered plus the tokens gpt-image reports, which
    // include the uploaded images.
    meter: (value) => ({
      usage: value.usage ?? {},
      media: { images: value.images.length },
      estimated: false,
    }),
  });
  if (!result.ok) {
    sendError(reply, result);
    return;
  }
  await sendImages(reply, result, responseFormat);
}

export function handleImageEdits(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  return editOrVary(req, reply, deps, 'edit');
}

export function handleImageVariations(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  return editOrVary(req, reply, deps, 'variation');
}

// ───────────── Speech ─────────────

export async function handleSpeech(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const format = (body.response_format ?? 'mp3') as AudioFormat;
  try {
    if (typeof body.model !== 'string') throw invalid('model', 'model is required');
    if (typeof body.input !== 'string' || body.input === '')
      throw invalid('input', 'input is required');
    if (body.input.length > MAX_SPEECH_CHARS)
      throw invalid('input', `input is limited to ${String(MAX_SPEECH_CHARS)} characters`);
    if (typeof body.voice !== 'string' || body.voice === '')
      throw invalid('voice', 'voice is required');
    if (!AUDIO_FORMATS.includes(format))
      throw invalid(
        'response_format',
        `response_format must be one of ${AUDIO_FORMATS.join(', ')}`,
      );
    if (
      body.speed !== undefined &&
      (typeof body.speed !== 'number' || body.speed < 0.25 || body.speed > 4)
    )
      throw invalid('speed', 'speed must be between 0.25 and 4');
  } catch (error) {
    sendError(reply, { error: error as DiRouterError });
    return;
  }
  const model = body.model;
  const input = body.input;
  const characters = input.length;
  const media = { characters };

  const result = await runMetered<{ audio: Buffer; contentType: string }>(req, deps, {
    inboundApi: 'openai.speech',
    model,
    estimatedInputTokens: Math.ceil(input.length / 4),
    worstCase: { usage: {}, media, estimated: true },
    select: (candidates) =>
      capable(
        candidates,
        (c) => c.model.capabilities.speech === true && !!mediaAdapterFor(c.provider.type).speech,
        'text to speech',
        model,
      ),
    build: (candidate, apiKey) =>
      mediaAdapterFor(candidate.provider.type).speech?.build(ctx(candidate, apiKey), {
        input,
        voice: body.voice as string,
        format,
        ...(typeof body.speed === 'number' ? { speed: body.speed } : {}),
        ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
      }),
    read: async (response) => ({
      audio: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? AUDIO_CONTENT_TYPES[format],
    }),
    meter: () => ({ usage: {}, media, estimated: false }),
  });
  if (!result.ok) {
    sendError(reply, result);
    return;
  }
  sendOk(reply, result);
  reply.status(200).header('content-type', result.value.contentType).send(result.value.audio);
}

// ───────────── Transcription ─────────────

interface FilePart {
  data: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Minimal multipart/form-data parser for uploads: the text fields, every file part with its field
 * name, and `file` (the part named `file`, else the last one).
 */
export function parseMultipart(
  body: Buffer,
  contentType: string,
): { fields: Record<string, string>; file?: FilePart; files: (FilePart & { name: string })[] } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!marker) throw invalid('file', 'multipart boundary missing');
  const delimiter = Buffer.from(`--${marker}`);
  const fields: Record<string, string> = {};
  const files: (FilePart & { name: string })[] = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const partStart = start + delimiter.length;
    if (body.subarray(partStart, partStart + 2).toString() === '--') break;
    const next = body.indexOf(delimiter, partStart);
    if (next === -1) break;
    // Each part: CRLF, headers, CRLF CRLF, content, CRLF.
    const part = body.subarray(partStart + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const headers = part.subarray(0, split).toString('utf8');
      const content = part.subarray(split + 4);
      const name = /name="([^"]*)"/i.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
      if (name && filename !== undefined)
        files.push({
          name,
          data: content,
          filename: filename || name,
          contentType:
            /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? 'application/octet-stream',
        });
      else if (name) fields[name] = content.toString('utf8');
    }
    start = next;
  }
  const file = files.find((f) => f.name === 'file') ?? files.at(-1);
  return {
    fields,
    files,
    ...(file
      ? { file: { data: file.data, filename: file.filename, contentType: file.contentType } }
      : {}),
  };
}

/** Exact length of a PCM WAV file from its header, when the upload is one. */
export function wavSeconds(data: Buffer): number | undefined {
  if (
    data.length < 44 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE'
  )
    return undefined;
  let offset = 12;
  let byteRate: number | undefined;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ') byteRate = data.readUInt32LE(offset + 16);
    if (id === 'data' && byteRate) return Math.min(size, data.length - offset - 8) / byteRate;
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

const TRANSCRIPT_FORMATS = ['json', 'text', 'srt', 'verbose_json', 'vtt'] as const;
type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

function timestamp(seconds: number, separator: ',' | '.'): string {
  const ms = Math.round(seconds * 1000);
  const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

export function renderTranscript(
  value: TranscriptionResult,
  format: TranscriptFormat,
  seconds: number,
  task: 'transcribe' | 'translate' = 'transcribe',
): { contentType: string; body: string | Record<string, unknown> } {
  const segments = value.segments?.length
    ? value.segments
    : [{ start: 0, end: seconds, text: value.text }];
  switch (format) {
    case 'text':
      return { contentType: 'text/plain; charset=utf-8', body: `${value.text}\n` };
    case 'srt':
      return {
        contentType: 'text/plain; charset=utf-8',
        body: segments
          .map(
            (s, i) =>
              `${String(i + 1)}\n${timestamp(s.start, ',')} --> ${timestamp(s.end, ',')}\n${s.text.trim()}\n`,
          )
          .join('\n'),
      };
    case 'vtt':
      return {
        contentType: 'text/vtt; charset=utf-8',
        body: `WEBVTT\n\n${segments
          .map((s) => `${timestamp(s.start, '.')} --> ${timestamp(s.end, '.')}\n${s.text.trim()}\n`)
          .join('\n')}`,
      };
    case 'verbose_json':
      return {
        contentType: 'application/json',
        body: {
          task,
          language: value.language ?? (task === 'translate' ? 'english' : 'unknown'),
          duration: seconds,
          text: value.text,
          segments: segments.map((s, id) => ({ id, start: s.start, end: s.end, text: s.text })),
        },
      };
    default:
      return { contentType: 'application/json', body: { text: value.text } };
  }
}

export function handleTranscriptions(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  return speechToText(req, reply, deps, 'transcription');
}

/** `/v1/audio/translations` (card 30.4): speech in any language to English text. */
export function handleTranslations(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  return speechToText(req, reply, deps, 'translation');
}

async function speechToText(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
  kind: 'transcription' | 'translation',
): Promise<void> {
  let fields: Record<string, string>;
  let file: FilePart;
  try {
    if (!Buffer.isBuffer(req.body))
      throw invalid('file', 'send the audio as multipart/form-data with a file field');
    const parsed = parseMultipart(req.body, req.headers['content-type'] ?? '');
    if (!parsed.file || parsed.file.data.length === 0) throw invalid('file', 'file is required');
    if (!parsed.fields.model) throw invalid('model', 'model is required');
    const format = parsed.fields.response_format ?? 'json';
    if (!(TRANSCRIPT_FORMATS as readonly string[]).includes(format))
      throw invalid(
        'response_format',
        `response_format must be one of ${TRANSCRIPT_FORMATS.join(', ')}`,
      );
    fields = parsed.fields;
    file = parsed.file;
  } catch (error) {
    sendError(reply, {
      error: error instanceof DiRouterError ? error : invalid('file', 'malformed multipart body'),
    });
    return;
  }
  const model = fields.model ?? '';
  const format = (fields.response_format ?? 'json') as TranscriptFormat;
  const exact = wavSeconds(file.data);
  // Without a provider figure or a WAV header the length is estimated at 128 kbps; the wallet
  // reserves for 16 kbps, the lowest common speech bitrate, so the estimate never exceeds it.
  const estimate = exact ?? file.data.length / 16_000;
  const worst = exact ?? file.data.length / 2_000;
  const temperature = fields.temperature !== undefined ? Number(fields.temperature) : undefined;

  const service = (adapter: ReturnType<typeof mediaAdapterFor>) =>
    kind === 'translation' ? adapter.translation : adapter.transcription;
  const result = await runMetered<TranscriptionResult>(req, deps, {
    inboundApi: kind === 'translation' ? 'openai.translations' : 'openai.transcriptions',
    model,
    estimatedInputTokens: Math.ceil((fields.prompt?.length ?? 0) / 4),
    worstCase: { usage: {}, media: { seconds: worst }, estimated: true },
    select: (candidates) =>
      capable(
        candidates,
        (c) =>
          c.model.capabilities.transcription === true &&
          !!service(mediaAdapterFor(c.provider.type)),
        kind === 'translation' ? 'speech translation' : 'speech to text',
        model,
      ),
    build: (candidate, apiKey) =>
      service(mediaAdapterFor(candidate.provider.type))?.build(ctx(candidate, apiKey), {
        audio: file.data,
        filename: file.filename,
        contentType: file.contentType,
        ...(fields.language ? { language: fields.language } : {}),
        ...(fields.prompt ? { prompt: fields.prompt } : {}),
        ...(temperature !== undefined && Number.isFinite(temperature) ? { temperature } : {}),
      }),
    read: async (response, candidate) => {
      const parsed = service(mediaAdapterFor(candidate.provider.type))?.parse(
        await response.json(),
      );
      if (!parsed) throw new Error(`${kind} not supported`);
      return parsed;
    },
    meter: (value) => ({
      usage: value.usage ?? {},
      media: { seconds: value.seconds ?? estimate },
      estimated: value.seconds === undefined && exact === undefined,
    }),
  });
  if (!result.ok) {
    sendError(reply, result);
    return;
  }
  sendOk(reply, result);
  const rendered = renderTranscript(
    result.value,
    format,
    result.metering.media?.seconds ?? estimate,
    kind === 'translation' ? 'translate' : 'transcribe',
  );
  reply.status(200).header('content-type', rendered.contentType).send(rendered.body);
}

/** Routes and the multipart body parser (raw bytes; parsed by the handler). */
export function registerMediaRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES + 1024 * 1024 },
    (_req, body, done) => {
      done(null, body);
    },
  );
  app.post('/v1/images/generations', (req, reply) => handleImages(req, reply, deps));
  app.post('/v1/audio/speech', (req, reply) => handleSpeech(req, reply, deps));
  app.post('/v1/audio/transcriptions', (req, reply) => handleTranscriptions(req, reply, deps));
  // Card 30.4.
  app.post('/v1/images/edits', (req, reply) => handleImageEdits(req, reply, deps));
  app.post('/v1/images/variations', (req, reply) => handleImageVariations(req, reply, deps));
  app.post('/v1/audio/translations', (req, reply) => handleTranslations(req, reply, deps));
}
