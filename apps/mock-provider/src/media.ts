/**
 * Fake image and audio services (card 21.1) in the shapes of OpenAI, Deepgram, ElevenLabs and
 * Fal. Speech comes back as a silent WAV whose length follows the text (60 ms per character), and
 * transcription reads the length of an uploaded WAV, so billing by characters and by seconds can
 * be checked end to end.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** A 1×1 transparent PNG. */
export const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
export const MOCK_TRANSCRIPT = 'Hello from the DiRouter mock transcriber.';
const RATE = 16_000;

/** Silent 16 kHz mono 16-bit WAV. */
export function silentWav(seconds: number): Buffer {
  const samples = Math.round(seconds * RATE);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

/** Length of the first WAV found in a body (raw or inside a multipart upload). */
function wavSecondsIn(body: Buffer): number {
  const at = body.indexOf('RIFF');
  if (at === -1 || body.length < at + 44) return 0;
  return body.readUInt32LE(at + 40) / body.readUInt32LE(at + 28);
}

const field = (body: Buffer, name: string) =>
  new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body.toString('latin1'))?.[1];

const authorized = (req: FastifyRequest, header: string, prefix = '') =>
  typeof req.headers[header] === 'string' && req.headers[header].startsWith(prefix);

export function registerMedia(app: FastifyInstance): void {
  for (const type of ['multipart/form-data', /^audio\//, 'application/octet-stream'])
    app.addContentTypeParser(
      type,
      { parseAs: 'buffer', bodyLimit: 30 * 1024 * 1024 },
      (_r, b, d) => {
        d(null, b);
      },
    );

  // ── OpenAI ──
  app.post('/v1/images/generations', async (req, reply) => {
    const body = (req.body ?? {}) as { model?: string; prompt?: string; n?: number };
    if (!authorized(req, 'authorization', 'Bearer ')) return reply.status(401).send({});
    const n = body.n ?? 1;
    const dalle = body.model?.startsWith('dall-e') === true;
    return {
      created: 1_700_000_000,
      data: Array.from({ length: n }, () =>
        dalle
          ? { url: 'https://mock.invalid/image.png', revised_prompt: `mock: ${body.prompt ?? ''}` }
          : { b64_json: MOCK_PNG_BASE64 },
      ),
      ...(dalle
        ? {}
        : {
            usage: {
              input_tokens: Math.ceil((body.prompt ?? '').length / 4),
              output_tokens: 272 * n,
              total_tokens: Math.ceil((body.prompt ?? '').length / 4) + 272 * n,
            },
          }),
    };
  });

  app.post('/v1/audio/speech', async (req, reply) => {
    const body = (req.body ?? {}) as { input?: string; response_format?: string };
    if (!authorized(req, 'authorization', 'Bearer ')) return reply.status(401).send({});
    return reply
      .header('content-type', body.response_format === 'wav' ? 'audio/wav' : 'audio/mpeg')
      .send(silentWav((body.input ?? '').length * 0.06));
  });

  app.post('/v1/audio/transcriptions', async (req, reply) => {
    const body = req.body as Buffer;
    if (!authorized(req, 'authorization', 'Bearer ')) return reply.status(401).send({});
    const seconds = wavSecondsIn(body);
    const verbose = field(body, 'response_format') === 'verbose_json';
    return verbose
      ? {
          task: 'transcribe',
          language: field(body, 'language') ?? 'english',
          duration: seconds,
          text: MOCK_TRANSCRIPT,
          segments: [{ id: 0, start: 0, end: seconds, text: MOCK_TRANSCRIPT }],
        }
      : { text: MOCK_TRANSCRIPT, usage: { type: 'duration', seconds: Math.ceil(seconds) } };
  });

  // ── Deepgram ──
  app.post('/v1/listen', async (req, reply) => {
    if (!authorized(req, 'authorization', 'Token ')) return reply.status(401).send({});
    const seconds = wavSecondsIn(req.body as Buffer);
    return {
      metadata: { duration: seconds },
      results: {
        channels: [{ alternatives: [{ transcript: MOCK_TRANSCRIPT }], detected_language: 'en' }],
        utterances: [{ start: 0, end: seconds, transcript: MOCK_TRANSCRIPT }],
      },
    };
  });
  app.post('/v1/speak', async (req, reply) => {
    if (!authorized(req, 'authorization', 'Token ')) return reply.status(401).send({});
    const text = (req.body as { text?: string } | undefined)?.text ?? '';
    return reply.header('content-type', 'audio/wav').send(silentWav(text.length * 0.06));
  });

  // ── ElevenLabs ──
  app.post('/v1/text-to-speech/:voice', async (req, reply) => {
    if (!authorized(req, 'xi-api-key')) return reply.status(401).send({});
    const text = (req.body as { text?: string } | undefined)?.text ?? '';
    return reply.header('content-type', 'audio/mpeg').send(silentWav(text.length * 0.06));
  });
  app.post('/v1/speech-to-text', async (req, reply) => {
    if (!authorized(req, 'xi-api-key')) return reply.status(401).send({});
    const seconds = wavSecondsIn(req.body as Buffer);
    return {
      text: MOCK_TRANSCRIPT,
      language_code: 'en',
      words: [{ text: MOCK_TRANSCRIPT, start: 0, end: seconds, type: 'word' }],
    };
  });

  // ── Fal ──
  app.post('/fal-ai/*', async (req, reply) => {
    if (!authorized(req, 'authorization', 'Key ')) return reply.status(401).send({});
    const n = (req.body as { num_images?: number } | undefined)?.num_images ?? 1;
    return {
      images: Array.from({ length: n }, () => ({
        url: `data:image/png;base64,${MOCK_PNG_BASE64}`,
        content_type: 'image/png',
      })),
    };
  });
}
