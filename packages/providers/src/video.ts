/**
 * Video generation adapters (card 30.6): long-running tasks that are started, polled, downloaded
 * and cancelled. Like the other adapters they only know request and response shapes.
 *
 * | type                    | API                                                                      |
 * | ----------------------- | ------------------------------------------------------------------------ |
 * | openai, openai-compatible, mock | OpenAI Videos: `POST /videos`, `GET /videos/{id}`, `/content`, `DELETE` |
 * | gemini                  | Veo: `:predictLongRunning`, the operation, the file URI it returns       |
 * | fal                     | fal queue: submit, `status_url`, `response_url` (video URL), `cancel_url` |
 *
 * OpenAI shut its own Sora API down on 2026-09-24; the OpenAI shape stays for the providers and
 * gateways that still serve it (`openai-compatible`).
 */
import type { ProviderConfig, ProviderType } from '@dirouter/contracts';

import { type UpstreamRequest, geminiModel, geminiVersion } from './adapters.js';
import type { MediaContext } from './media.js';

export interface VideoRequest {
  prompt: string;
  /** Requested length in seconds. */
  seconds?: number;
  /** `WIDTHxHEIGHT`, e.g. `1280x720`. */
  size?: string;
}

export type VideoStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

/** What the gateway keeps about an upstream task to follow it. */
export interface UpstreamVideoJob {
  id: string;
  statusUrl?: string;
  responseUrl?: string;
  cancelUrl?: string;
  /** The finished video, when the provider serves it from its own URL (fal). */
  videoUrl?: string;
}

export interface VideoState {
  status: VideoStatus;
  progress?: number;
  /** Length the provider reports for the finished video. */
  seconds?: number;
  size?: string;
  error?: { code: string; message: string };
  /** Where the finished video is, when the status says so (Veo). */
  videoUrl?: string;
}

export type VideoVariant = 'video' | 'thumbnail' | 'spritesheet';

/** The provider and its decrypted key; enough to address an existing task. */
export interface VideoTarget {
  provider: ProviderConfig;
  apiKey: string;
  credentialHeaders?: Record<string, string> | undefined;
}

export interface VideoAdapter {
  create(ctx: MediaContext, req: VideoRequest): UpstreamRequest;
  /** The started task, from the create response. */
  started(json: unknown): { job: UpstreamVideoJob; state: VideoState };
  status(t: VideoTarget, job: UpstreamVideoJob): UpstreamRequest;
  parseStatus(json: unknown): VideoState;
  /** A second request once the task completed, for providers that return the result separately. */
  result?(t: VideoTarget, job: UpstreamVideoJob): UpstreamRequest;
  parseResult?(json: unknown): { videoUrl?: string; seconds?: number };
  /** The bytes of a finished video; undefined when the variant is not offered. */
  content(
    t: VideoTarget,
    job: UpstreamVideoJob,
    variant: VideoVariant,
  ): UpstreamRequest | undefined;
  cancel(t: VideoTarget, job: UpstreamVideoJob): UpstreamRequest | undefined;
  /** Seconds the client gets when it asks for none. */
  defaultSeconds: number;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** A URL the provider handed back, only when it stays on `base`'s origin. */
export function sameOrigin(url: string | undefined, base: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin === new URL(base).origin ? url : undefined;
  } catch {
    return undefined;
  }
}

// ───────────── OpenAI Videos ─────────────

const OPENAI_STATUS: Record<string, VideoStatus> = {
  queued: 'queued',
  in_progress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
};

const openaiHeaders = (t: VideoTarget) => ({
  ...(t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {}),
  ...t.credentialHeaders,
});

function openaiState(json: unknown): VideoState {
  const v = rec(json);
  const error = rec(v.error);
  const progress = num(v.progress);
  const seconds = num(v.seconds);
  return {
    status: OPENAI_STATUS[str(v.status) ?? ''] ?? 'in_progress',
    ...(progress !== undefined ? { progress } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(str(v.size) ? { size: str(v.size) } : {}),
    ...(str(error.message)
      ? { error: { code: str(error.code) ?? 'video_failed', message: str(error.message) ?? '' } }
      : {}),
  };
}

export const openaiVideo: VideoAdapter = {
  defaultSeconds: 4,
  create: (ctx, req) => ({
    url: `${trimSlash(ctx.provider.baseUrl)}/videos`,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...openaiHeaders(ctx) },
    body: JSON.stringify({
      model: ctx.model.upstreamModel,
      prompt: req.prompt,
      ...(req.seconds !== undefined ? { seconds: String(req.seconds) } : {}),
      ...(req.size ? { size: req.size } : {}),
    }),
  }),
  started: (json) => {
    const id = str(rec(json).id);
    if (!id) throw new Error('the provider returned no video id');
    return { job: { id }, state: openaiState(json) };
  },
  status: (t, job) => ({
    url: `${trimSlash(t.provider.baseUrl)}/videos/${encodeURIComponent(job.id)}`,
    method: 'GET',
    headers: openaiHeaders(t),
  }),
  parseStatus: openaiState,
  content: (t, job, variant) => ({
    url: `${trimSlash(t.provider.baseUrl)}/videos/${encodeURIComponent(job.id)}/content?variant=${variant}`,
    method: 'GET',
    headers: openaiHeaders(t),
  }),
  cancel: (t, job) => ({
    url: `${trimSlash(t.provider.baseUrl)}/videos/${encodeURIComponent(job.id)}`,
    method: 'DELETE',
    headers: openaiHeaders(t),
  }),
};

// ───────────── fal queue ─────────────

/** The queue host: `options.queueBaseUrl`, else `queue.fal.run` for fal.run, else the base URL. */
export function falQueueBase(provider: ProviderConfig): string {
  const configured = provider.options.queueBaseUrl;
  if (typeof configured === 'string' && configured) return trimSlash(configured);
  const base = trimSlash(provider.baseUrl);
  return base.replace(/^https:\/\/fal\.run(?=$|\/)/, 'https://queue.fal.run');
}

/** A queue URL fal returned, refused unless it is on the queue's own origin. */
function falUrl(url: string | undefined, provider: ProviderConfig, what: string): string {
  const safe = sameOrigin(url, falQueueBase(provider));
  if (!safe) throw new Error(`fal returned no ${what} URL on its queue origin`);
  return safe;
}

const falHeaders = (t: VideoTarget) => ({
  ...(t.apiKey ? { authorization: `Key ${t.apiKey}` } : {}),
  ...t.credentialHeaders,
});

const ASPECT: Readonly<Record<string, string>> = {
  '1280x720': '16:9',
  '1920x1080': '16:9',
  '1792x1024': '16:9',
  '720x1280': '9:16',
  '1080x1920': '9:16',
  '1024x1792': '9:16',
  '1024x1024': '1:1',
};

const FAL_STATUS: Record<string, VideoStatus> = {
  IN_QUEUE: 'queued',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
};

export const falVideo: VideoAdapter = {
  defaultSeconds: 5,
  create: (ctx, req) => ({
    url: `${falQueueBase(ctx.provider)}/${ctx.model.upstreamModel}`,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...falHeaders(ctx) },
    body: JSON.stringify({
      prompt: req.prompt,
      ...(req.seconds !== undefined ? { duration: String(req.seconds) } : {}),
      ...(req.size && ASPECT[req.size] ? { aspect_ratio: ASPECT[req.size] } : {}),
    }),
  }),
  started: (json) => {
    const b = rec(json);
    const id = str(b.request_id);
    if (!id) throw new Error('the provider returned no request id');
    return {
      job: {
        id,
        ...(str(b.status_url) ? { statusUrl: str(b.status_url) } : {}),
        ...(str(b.response_url) ? { responseUrl: str(b.response_url) } : {}),
        ...(str(b.cancel_url) ? { cancelUrl: str(b.cancel_url) } : {}),
      },
      state: { status: 'queued' },
    };
  },
  // Only URLs on the queue's own origin are followed; the key is never sent elsewhere.
  status: (t, job) => ({
    url: falUrl(job.statusUrl, t.provider, 'status'),
    method: 'GET',
    headers: falHeaders(t),
  }),
  parseStatus: (json) => {
    const b = rec(json);
    const status = FAL_STATUS[str(b.status) ?? ''] ?? 'in_progress';
    const error = str(b.error);
    return error
      ? { status: 'failed', error: { code: 'video_failed', message: error } }
      : { status };
  },
  result: (t, job) => ({
    url: falUrl(job.responseUrl, t.provider, 'response'),
    method: 'GET',
    headers: falHeaders(t),
  }),
  parseResult: (json) => {
    const b = rec(json);
    const video = rec(b.video);
    const seconds = num(video.duration) ?? num(b.duration);
    return {
      ...(str(video.url) ? { videoUrl: str(video.url) } : {}),
      ...(seconds !== undefined ? { seconds } : {}),
    };
  },
  // The finished file is on fal's CDN: fetched without the key.
  content: (_t, job, variant) =>
    variant === 'video' && job.videoUrl
      ? { url: job.videoUrl, method: 'GET', headers: {} }
      : undefined,
  cancel: (t, job) => ({
    url: falUrl(job.cancelUrl, t.provider, 'cancel'),
    method: 'PUT',
    headers: falHeaders(t),
  }),
};

// ───────────── Google Veo (Gemini API) ─────────────

const geminiBase = (provider: ProviderConfig) =>
  `${trimSlash(provider.baseUrl)}/${geminiVersion(provider)}`;
const googHeaders = (t: VideoTarget) => ({ 'x-goog-api-key': t.apiKey, ...t.credentialHeaders });
/** Operation names look like `models/veo-3.0-generate-001/operations/abc`. */
const OPERATION = /^(models\/[\w.-]+\/)?operations\/[\w.-]+$/;

function operation(job: UpstreamVideoJob): string {
  if (!OPERATION.test(job.id)) throw new Error('not a Gemini operation name');
  return job.id;
}

export const geminiVideo: VideoAdapter = {
  defaultSeconds: 8,
  create: (ctx, req) => ({
    url: `${geminiBase(ctx.provider)}/models/${encodeURIComponent(geminiModel(ctx.model.upstreamModel))}:predictLongRunning`,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...googHeaders(ctx) },
    body: JSON.stringify({
      instances: [{ prompt: req.prompt }],
      parameters: {
        ...(req.seconds !== undefined ? { durationSeconds: req.seconds } : {}),
        ...(req.size && ASPECT[req.size] ? { aspectRatio: ASPECT[req.size] } : {}),
      },
    }),
  }),
  started: (json) => {
    const name = str(rec(json).name);
    if (!name || !OPERATION.test(name)) throw new Error('the provider returned no operation');
    return { job: { id: name }, state: { status: 'queued' } };
  },
  status: (t, job) => ({
    url: `${geminiBase(t.provider)}/${operation(job)}`,
    method: 'GET',
    headers: googHeaders(t),
  }),
  parseStatus: (json) => {
    const op = rec(json);
    const error = rec(op.error);
    if (str(error.message))
      return {
        status: 'failed',
        error: {
          code:
            typeof error.code === 'number'
              ? String(error.code)
              : (str(error.code) ?? 'video_failed'),
          message: str(error.message) ?? '',
        },
      };
    if (op.done !== true) return { status: 'in_progress' };
    const samples = rec(rec(op.response).generateVideoResponse).generatedSamples;
    const first = Array.isArray(samples) ? rec(rec(samples[0]).video) : {};
    const uri = str(first.uri);
    return uri
      ? { status: 'completed', videoUrl: uri }
      : {
          status: 'failed',
          error: { code: 'video_failed', message: 'The provider returned no video (filtered?)' },
        };
  },
  // The file URI is on the Gemini API itself; the key is only sent there.
  content: (t, job, variant) =>
    variant === 'video' && job.videoUrl
      ? {
          url: job.videoUrl,
          method: 'GET',
          headers: sameOrigin(job.videoUrl, t.provider.baseUrl) ? googHeaders(t) : {},
        }
      : undefined,
  cancel: (t, job) => ({
    url: `${geminiBase(t.provider)}/${operation(job)}:cancel`,
    method: 'POST',
    headers: googHeaders(t),
  }),
};

const VIDEO: Partial<Record<ProviderType, VideoAdapter>> = {
  openai: openaiVideo,
  'openai-compatible': openaiVideo,
  mock: openaiVideo,
  gemini: geminiVideo,
  fal: falVideo,
};

export function videoAdapterFor(type: ProviderType): VideoAdapter | undefined {
  return VIDEO[type];
}
