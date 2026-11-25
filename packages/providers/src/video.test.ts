/** Video adapters (card 30.6): OpenAI Videos and the fal queue. */
import type { ModelConfig, ProviderConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  falQueueBase,
  falVideo,
  geminiVideo,
  openaiVideo,
  sameOrigin,
  videoAdapterFor,
} from './video.js';

const provider = (type: ProviderConfig['type'], baseUrl: string, options = {}): ProviderConfig => ({
  id: 'p',
  organizationId: 'o',
  slug: 'p',
  type,
  name: 'p',
  baseUrl,
  enabled: true,
  options,
  credentials: [],
});
const model = { upstreamModel: 'sora-2' } as ModelConfig;

describe('OpenAI videos', () => {
  const ctx = { provider: provider('openai', 'https://api.openai.com/v1/'), model, apiKey: 'k' };

  it('creates, follows, downloads and deletes a video', () => {
    const create = openaiVideo.create(ctx, { prompt: 'a cat', seconds: 8, size: '1280x720' });
    expect(create.url).toBe('https://api.openai.com/v1/videos');
    expect(JSON.parse(create.body ?? '')).toEqual({
      model: 'sora-2',
      prompt: 'a cat',
      seconds: '8',
      size: '1280x720',
    });
    expect(create.headers.authorization).toBe('Bearer k');
    const { job, state } = openaiVideo.started({ id: 'video_1', status: 'queued', progress: 0 });
    expect(job).toEqual({ id: 'video_1' });
    expect(state).toEqual({ status: 'queued', progress: 0 });
    expect(openaiVideo.status(ctx, job).url).toBe('https://api.openai.com/v1/videos/video_1');
    expect(openaiVideo.content(ctx, job, 'thumbnail')?.url).toMatch(/content\?variant=thumbnail$/);
    expect(openaiVideo.cancel(ctx, job)?.method).toBe('DELETE');
  });

  it('reads progress, length and errors', () => {
    expect(openaiVideo.parseStatus({ status: 'completed', progress: 100, seconds: '8' })).toEqual({
      status: 'completed',
      progress: 100,
      seconds: 8,
    });
    expect(
      openaiVideo.parseStatus({ status: 'failed', error: { code: 'moderation', message: 'no' } }),
    ).toMatchObject({ status: 'failed', error: { code: 'moderation', message: 'no' } });
  });
});

describe('fal queue', () => {
  it('derives the queue host', () => {
    expect(falQueueBase(provider('fal', 'https://fal.run'))).toBe('https://queue.fal.run');
    expect(falQueueBase(provider('fal', 'https://fal.run', { queueBaseUrl: 'http://q/x/' }))).toBe(
      'http://q/x',
    );
  });

  it('submits with duration and aspect ratio, and follows the URLs fal returns', () => {
    const p = provider('fal', 'https://fal.run');
    const ctx = {
      provider: p,
      model: { upstreamModel: 'fal-ai/veo3' } as ModelConfig,
      apiKey: 'k',
    };
    const create = falVideo.create(ctx, { prompt: 'a cat', seconds: 8, size: '720x1280' });
    expect(create.url).toBe('https://queue.fal.run/fal-ai/veo3');
    expect(create.headers.authorization).toBe('Key k');
    expect(JSON.parse(create.body ?? '')).toEqual({
      prompt: 'a cat',
      duration: '8',
      aspect_ratio: '9:16',
    });
    const { job } = falVideo.started({
      request_id: 'r1',
      status_url: 'https://queue.fal.run/fal-ai/veo3/requests/r1/status',
      response_url: 'https://queue.fal.run/fal-ai/veo3/requests/r1',
      cancel_url: 'https://queue.fal.run/fal-ai/veo3/requests/r1/cancel',
    });
    expect(falVideo.status(ctx, job).url).toBe(job.statusUrl);
    expect(falVideo.cancel(ctx, job)?.method).toBe('PUT');
    expect(falVideo.parseStatus({ status: 'IN_QUEUE' }).status).toBe('queued');
    expect(falVideo.parseStatus({ status: 'COMPLETED' }).status).toBe('completed');
    expect(falVideo.parseResult?.({ video: { url: 'https://v3.fal.media/x.mp4' } })).toEqual({
      videoUrl: 'https://v3.fal.media/x.mp4',
    });
    // The CDN download carries no key.
    expect(
      falVideo.content(ctx, { ...job, videoUrl: 'https://v3.fal.media/x.mp4' }, 'video')?.headers,
    ).toEqual({});
    expect(falVideo.content(ctx, job, 'thumbnail')).toBeUndefined();
  });

  it('never sends the key to a URL off the queue origin', () => {
    const ctx = { provider: provider('fal', 'https://fal.run'), apiKey: 'k' };
    expect(() =>
      falVideo.status(ctx, { id: 'r', statusUrl: 'https://evil.example/status' }),
    ).toThrow(/queue origin/);
    expect(sameOrigin('http://a/x', 'http://a/y')).toBe('http://a/x');
    expect(sameOrigin('not a url', 'http://a')).toBeUndefined();
  });

  it('has adapters for OpenAI-shaped providers, Veo and fal only', () => {
    expect(videoAdapterFor('mock')).toBe(openaiVideo);
    expect(videoAdapterFor('openai-compatible')).toBe(openaiVideo);
    expect(videoAdapterFor('gemini')).toBe(geminiVideo);
    expect(videoAdapterFor('fal')).toBe(falVideo);
    expect(videoAdapterFor('anthropic')).toBeUndefined();
  });
});

describe('Google Veo', () => {
  const p = provider('gemini', 'https://generativelanguage.googleapis.com');
  const ctx = {
    provider: p,
    model: { upstreamModel: 'models/veo-3.0-generate-001' } as ModelConfig,
    apiKey: 'k',
  };

  it('starts a long-running prediction and follows the operation', () => {
    const create = geminiVideo.create(ctx, { prompt: 'a cat', seconds: 8, size: '1280x720' });
    expect(create.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/veo-3.0-generate-001:predictLongRunning',
    );
    expect(create.headers['x-goog-api-key']).toBe('k');
    expect(JSON.parse(create.body ?? '')).toEqual({
      instances: [{ prompt: 'a cat' }],
      parameters: { durationSeconds: 8, aspectRatio: '16:9' },
    });
    const { job } = geminiVideo.started({ name: 'models/veo-3.0-generate-001/operations/op1' });
    expect(geminiVideo.status(ctx, job).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/veo-3.0-generate-001/operations/op1',
    );
    expect(geminiVideo.parseStatus({ done: false }).status).toBe('in_progress');
    const uri = 'https://generativelanguage.googleapis.com/v1beta/files/f1:download?alt=media';
    expect(
      geminiVideo.parseStatus({
        done: true,
        response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } },
      }),
    ).toEqual({ status: 'completed', videoUrl: uri });
    expect(
      geminiVideo.parseStatus({ done: true, error: { code: 3, message: 'blocked' } }),
    ).toMatchObject({
      status: 'failed',
      error: { message: 'blocked' },
    });
    expect(geminiVideo.content(ctx, { ...job, videoUrl: uri }, 'video')?.headers).toEqual({
      'x-goog-api-key': 'k',
    });
    // A file somewhere else gets no key.
    expect(
      geminiVideo.content(ctx, { ...job, videoUrl: 'https://cdn.example/x.mp4' }, 'video')?.headers,
    ).toEqual({});
    expect(() => geminiVideo.status(ctx, { id: '../../evil' })).toThrow();
  });
});
