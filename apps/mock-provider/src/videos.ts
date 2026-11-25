/**
 * Fake video generation (card 30.6) in the shapes of OpenAI Videos and the fal queue.
 *
 * A task moves one step on every status read (queued → in_progress → completed), so a client that
 * polls sees the whole life cycle without waiting. A prompt containing `mock:fail` fails. The
 * finished video is a few bytes of MP4 header; fal serves it from `/fal-cdn/`, like its CDN, and
 * Veo (Gemini API) from `/v1beta/files/{id}:download`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** An MP4 `ftyp` box: enough for a client to see a video file. */
export const MOCK_MP4 = Buffer.from(
  '0000001c667479706d703432000000006d7034326973366d61766331',
  'hex',
);
const MOCK_WEBP = Buffer.from(
  'RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00/\x00\x00\x00\x10\x07\x10\x11\x11\x88\x88\xfe\x07\x00',
  'latin1',
);

interface Video {
  id: string;
  model: string;
  prompt: string;
  seconds: string;
  size: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  createdAt: number;
  cancelled: boolean;
}

const now = () => Math.floor(Date.now() / 1000);

export interface MockVideos {
  /** `models/{model}:predictLongRunning` of the Gemini API (Veo), called by the Gemini handler. */
  veoStart(model: string, req: FastifyRequest, reply: FastifyReply): unknown;
  /** `models/{model}/operations/{id}:cancel`. */
  veoCancel(operation: string, reply: FastifyReply): unknown;
}

export function registerVideos(app: FastifyInstance): MockVideos {
  const videos = new Map<string, Video>();
  const fal = new Map<string, Video & { app: string }>();
  let seq = 0;
  const stats = { created: 0, cancelled: 0, deleted: 0, downloads: 0 };
  const advance = (v: Video) => {
    if (v.cancelled) return;
    if (v.status === 'queued') v.status = 'in_progress';
    else if (v.status === 'in_progress')
      v.status = v.prompt.includes('mock:fail') ? 'failed' : 'completed';
  };
  const bearer = (req: FastifyRequest) =>
    typeof req.headers.authorization === 'string' &&
    req.headers.authorization.startsWith('Bearer ');
  const view = (v: Video) => ({
    id: v.id,
    object: 'video',
    model: v.model,
    status: v.status,
    progress: v.status === 'completed' ? 100 : v.status === 'in_progress' ? 50 : 0,
    created_at: v.createdAt,
    completed_at: v.status === 'completed' ? now() : null,
    expires_at: v.createdAt + 3600,
    prompt: v.prompt,
    seconds: v.seconds,
    size: v.size,
    remixed_from_video_id: null,
    error: v.status === 'failed' ? { code: 'mock_failure', message: 'mock failure' } : null,
  });

  // ── OpenAI Videos ──
  app.post('/v1/videos', (req, reply) => {
    if (!bearer(req)) return reply.status(401).send({ error: { message: 'missing key' } });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.prompt !== 'string')
      return reply.status(400).send({ error: { message: 'prompt is required' } });
    const v: Video = {
      id: `video_mock${String(++seq)}`,
      model: typeof body.model === 'string' ? body.model : 'sora-2',
      prompt: body.prompt,
      seconds: typeof body.seconds === 'string' ? body.seconds : '4',
      size: typeof body.size === 'string' ? body.size : '720x1280',
      status: 'queued',
      createdAt: now(),
      cancelled: false,
    };
    videos.set(v.id, v);
    stats.created++;
    return view(v);
  });
  app.get<{ Params: { id: string } }>('/v1/videos/:id', (req, reply) => {
    const v = videos.get(req.params.id);
    if (!v || !bearer(req)) return reply.status(404).send({ error: { message: 'No such video' } });
    const shown = view(v);
    advance(v);
    return shown;
  });
  app.get<{ Params: { id: string }; Querystring: { variant?: string } }>(
    '/v1/videos/:id/content',
    (req, reply) => {
      const v = videos.get(req.params.id);
      if (!v || !bearer(req) || v.status !== 'completed')
        return reply.status(404).send({ error: { message: 'No content' } });
      stats.downloads++;
      if (req.query.variant === 'thumbnail') return reply.type('image/webp').send(MOCK_WEBP);
      return reply.type('video/mp4').send(MOCK_MP4);
    },
  );
  app.delete<{ Params: { id: string } }>('/v1/videos/:id', (req, reply) => {
    const v = videos.get(req.params.id);
    if (!v || !bearer(req)) return reply.status(404).send({ error: { message: 'No such video' } });
    if (v.status === 'queued' || v.status === 'in_progress') stats.cancelled++;
    v.cancelled = true;
    videos.delete(v.id);
    stats.deleted++;
    return { id: v.id, object: 'video.deleted', deleted: true };
  });

  // ── fal queue (served under /fal-queue so it does not clash with the synchronous /fal-ai) ──
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? 'localhost'}`;
  const falKey = (req: FastifyRequest) =>
    typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Key ');
  app.post<{ Params: { '*': string } }>('/fal-queue/*', (req, reply) => {
    if (!falKey(req)) return reply.status(401).send({ detail: 'missing key' });
    const model = req.params['*'];
    const appId = model.split('/').slice(0, 2).join('/');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = `fal-req-${String(++seq)}`;
    fal.set(id, {
      id,
      app: appId,
      model,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      seconds: typeof body.duration === 'string' ? body.duration.replace(/s$/, '') : '5',
      size: '1280x720',
      status: 'queued',
      createdAt: now(),
      cancelled: false,
    });
    stats.created++;
    const base = `${origin(req)}/fal-queue/${appId}/requests/${id}`;
    return {
      request_id: id,
      status_url: `${base}/status`,
      response_url: base,
      cancel_url: `${base}/cancel`,
      queue_position: 0,
    };
  });
  app.get<{ Params: { '*': string } }>('/fal-queue/*', (req, reply) => {
    if (!falKey(req)) return reply.status(401).send({ detail: 'missing key' });
    const match = /requests\/([^/]+)(\/status)?$/.exec(req.params['*']);
    const v = match ? fal.get(match[1] ?? '') : undefined;
    if (!v) return reply.status(404).send({ detail: 'Request not found' });
    if (match?.[2]) {
      const shown = v.cancelled
        ? 'COMPLETED'
        : {
            queued: 'IN_QUEUE',
            in_progress: 'IN_PROGRESS',
            completed: 'COMPLETED',
            failed: 'COMPLETED',
          }[v.status];
      advance(v);
      return { status: shown, request_id: v.id };
    }
    if (v.cancelled) return reply.status(400).send({ detail: 'Request was cancelled' });
    if (v.status === 'failed') return reply.status(422).send({ detail: 'mock failure' });
    return {
      video: {
        url: `${origin(req)}/fal-cdn/${v.id}.mp4`,
        content_type: 'video/mp4',
        duration: Number(v.seconds),
      },
    };
  });
  app.put<{ Params: { '*': string } }>('/fal-queue/*', (req, reply) => {
    if (!falKey(req)) return reply.status(401).send({ detail: 'missing key' });
    const match = /requests\/([^/]+)\/cancel$/.exec(req.params['*']);
    const v = match ? fal.get(match[1] ?? '') : undefined;
    if (!v) return reply.status(404).send({ detail: 'Request not found' });
    v.cancelled = true;
    stats.cancelled++;
    return reply.status(202).send({ status: 'CANCELLATION_REQUESTED' });
  });
  app.get<{ Params: { file: string } }>('/fal-cdn/:file', (req, reply) => {
    // The CDN is public: a key sent here would be a leak.
    if (req.headers.authorization) return reply.status(400).send('credentials sent to the CDN');
    stats.downloads++;
    return reply.type('video/mp4').send(MOCK_MP4);
  });

  app.get('/__mock/videos', () => stats);

  // ── Google Veo (Gemini API long-running operations) ──
  const veo = new Map<string, Video>();
  const googKey = (req: FastifyRequest) => typeof req.headers['x-goog-api-key'] === 'string';
  app.get<{ Params: { '*': string } }>('/v1beta/models/*', (req, reply) => {
    const match = /^([\w.-]+)\/operations\/([\w.-]+)$/.exec(req.params['*']);
    const v = match ? veo.get(match[2] ?? '') : undefined;
    if (!v || !googKey(req))
      return reply.status(404).send({ error: { code: 404, message: 'not found' } });
    const name = `models/${v.model}/operations/${v.id}`;
    advance(v);
    if (v.status === 'failed')
      return { name, done: true, error: { code: 3, message: 'mock failure' } };
    if (v.status !== 'completed') return { name, done: false };
    return {
      name,
      done: true,
      response: {
        '@type':
          'type.googleapis.com/google.ai.generativelanguage.v1beta.PredictLongRunningResponse',
        generateVideoResponse: {
          generatedSamples: [
            { video: { uri: `${origin(req)}/v1beta/files/${v.id}:download?alt=media` } },
          ],
        },
      },
    };
  });
  app.get<{ Params: { file: string } }>('/v1beta/files/:file', (req, reply) => {
    if (!googKey(req)) return reply.status(403).send({ error: { code: 403, message: 'no key' } });
    stats.downloads++;
    return reply.type('video/mp4').send(MOCK_MP4);
  });

  return {
    veoCancel(operation, reply) {
      const v = veo.get(operation.split('/').at(-1) ?? '');
      if (!v) return reply.status(404).send({ error: { code: 404, message: 'not found' } });
      v.cancelled = true;
      stats.cancelled++;
      return reply.send({});
    },
    veoStart(model, req, reply) {
      if (!googKey(req)) return reply.status(403).send({ error: { code: 403, message: 'no key' } });
      const body = (req.body ?? {}) as {
        instances?: { prompt?: string }[];
        parameters?: { durationSeconds?: number };
      };
      const id = `veo-op-${String(++seq)}`;
      veo.set(id, {
        id,
        model,
        prompt: body.instances?.[0]?.prompt ?? '',
        seconds: String(body.parameters?.durationSeconds ?? 8),
        size: '1280x720',
        status: 'queued',
        createdAt: now(),
        cancelled: false,
      });
      stats.created++;
      return reply.send({ name: `models/${model}/operations/${id}` });
    },
  };
}
