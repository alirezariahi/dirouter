/**
 * Async video tasks (card 30.6), OpenAI Videos compatible: `POST /v1/videos`, `GET /v1/videos`,
 * `GET /v1/videos/{id}`, `GET /v1/videos/{id}/content` and `DELETE /v1/videos/{id}`, plus
 * `POST /v1/videos/{id}/cancel` and an optional `webhook_url` on create (DiRouter extensions).
 *
 * A task is routed with the caller's key to a model with the `video` capability on a provider
 * with a video adapter (OpenAI-shaped, Google Veo, fal), started there, and followed by the job poller (and on every
 * retrieve) until it ends. Admission is the same as for a batch: rate limit, budgets and a wallet
 * hold of the worst case. Only a task that completes is billed (per generated second and per
 * request); a failed or cancelled task records an error event at zero cost and releases the hold.
 * When a task ends, a signed webhook is sent to its `webhook_url`.
 */
import { Readable } from 'node:stream';

import {
  type ModelConfig,
  type ProviderType,
  type SalePrice,
  USAGE_EVENT_SCHEMA_VERSION,
  type UsageEvent,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { computeCostUsd } from '@dirouter/model-catalog';
import {
  type UpstreamVideoJob,
  videoAdapterFor,
  type VideoState,
  type VideoVariant,
} from '@dirouter/providers';
import { type Candidate, isRouteError } from '@dirouter/routing';
import { DiRouterError, ForbiddenError, formatUsd, NotFoundError, ulid } from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { admitJob, releaseJob } from './jobs/admission.js';
import {
  authed,
  invalid,
  json,
  type JobsDeps,
  notFound,
  nowSeconds,
  sendError,
  sendUpstream,
  targetFor,
  upstreamFailure,
} from './jobs/context.js';
import { checkJobWebhookUrl, enqueueWebhook, webhookSecret } from './jobs/webhooks.js';
import { parseMultipart } from './media.js';
import { chargeUnits } from './pricing.js';
import { budgetScopes } from './spend-guard.js';
import { callUpstream, mergeTimeouts, readErrorBody } from './upstream.js';

/** A task record is kept a week; the provider may drop the video itself sooner. */
const TASK_TTL_SECONDS = 7 * 86_400;
/** The wallet holds a task's worst case for six hours. */
const TASK_HOLD_MS = 6 * 3_600_000;
const MAX_SECONDS = 60;
const MAX_PROMPT = 32_000;
const REFRESH_AFTER_MS = 2_000;

type Status = VideoState['status'];
const TERMINAL: readonly Status[] = ['completed', 'failed'];

export interface TaskRecord {
  id: string;
  type: 'video';
  organizationId: string;
  projectId: string;
  teamId: string | null;
  virtualKeyId: string;
  walletId?: string;
  priceMultiplier?: string;
  model: string;
  modelId: string;
  providerId: string;
  credentialId: string;
  providerType: ProviderType;
  pricing: ModelConfig['pricing'];
  sale?: SalePrice;
  prompt: string;
  seconds: number;
  size?: string;
  status: Status;
  progress: number;
  error?: { code: string; message: string };
  upstream: UpstreamVideoJob;
  createdAt: number;
  completedAt?: number;
  expiresAt: number;
  billedSeconds?: number;
  costUsd?: string;
  chargeUsd?: string;
  webhookUrl?: string;
  settled: boolean;
  checkedAt: number;
}

export const videoView = (t: TaskRecord) => ({
  id: t.id,
  object: 'video' as const,
  model: t.model,
  status: t.status,
  progress: t.progress,
  created_at: t.createdAt,
  completed_at: t.completedAt ?? null,
  expires_at: t.expiresAt,
  prompt: t.prompt,
  seconds: String(t.billedSeconds ?? t.seconds),
  size: t.size ?? null,
  remixed_from_video_id: null,
  error: t.error ?? null,
});

/** What a task costs and is charged for its generated seconds and the request itself. */
export function taskAmounts(
  model: Pick<ModelConfig, 'pricing'> & { sale?: SalePrice | undefined },
  seconds: number,
  groupMultiplier: string | undefined,
) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  const media = { seconds, requests: 1 };
  return {
    usage,
    media,
    costUsd: computeCostUsd(usage, model.pricing, media),
    chargeUsd: formatUsd(chargeUnits(usage, model, { groupMultiplier, media })),
  };
}

// ───────────── Create ─────────────

function readCreate(req: FastifyRequest): Record<string, unknown> {
  if (!Buffer.isBuffer(req.body)) return (req.body ?? {}) as Record<string, unknown>;
  const parsed = parseMultipart(req.body, req.headers['content-type'] ?? '');
  if (parsed.file) throw invalid('input_reference is not supported yet', 'input_reference');
  return parsed.fields;
}

async function create(req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) {
  const { config, key } = authed(req, deps);
  const body = readCreate(req);
  // OpenAI's default model when none is given.
  if (body.model !== undefined && (typeof body.model !== 'string' || body.model === ''))
    throw invalid('model must be a model name', 'model');
  if (typeof body.prompt !== 'string' || body.prompt === '')
    throw invalid('prompt is required', 'prompt');
  if (body.prompt.length > MAX_PROMPT) throw invalid('prompt is too long', 'prompt');
  let seconds: number | undefined;
  if (body.seconds !== undefined) {
    seconds = Number(body.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS)
      throw invalid(`seconds must be an integer from 1 to ${String(MAX_SECONDS)}`, 'seconds');
  }
  if (body.size !== undefined && (typeof body.size !== 'string' || !/^\d+x\d+$/.test(body.size)))
    throw invalid('size must look like 1280x720', 'size');
  const size = typeof body.size === 'string' ? body.size : undefined;
  const webhookUrl =
    body.webhook_url === undefined
      ? undefined
      : await checkJobWebhookUrl(body.webhook_url, key.organizationId);
  const model = typeof body.model === 'string' ? body.model : 'sora-2';
  const prompt = body.prompt;

  const route = config.router.resolve(key, model, { estimatedInputTokens: 0 });
  if (isRouteError(route))
    throw route.error === 'model_not_found'
      ? new NotFoundError('model_not_found', {
          message: `Model '${model}' not found`,
          param: 'model',
        })
      : route.error === 'model_not_allowed'
        ? new ForbiddenError('model_not_allowed', { param: 'model' })
        : new DiRouterError('service_unavailable', { message: `No provider can serve '${model}'` });
  const candidates = route.candidates.filter(
    (c) => c.model.capabilities.video === true && videoAdapterFor(c.provider.type) !== undefined,
  );
  if (candidates.length === 0)
    throw invalid(`'${model}' does not support video generation`, 'model');

  const id = `video_${ulid()}`;
  const lengthOf = (c: Candidate) =>
    seconds ?? videoAdapterFor(c.provider.type)?.defaultSeconds ?? 8;
  let worst = 0;
  for (const c of candidates)
    worst = Math.max(
      worst,
      Number(taskAmounts(c.model, lengthOf(c), key.priceMultiplier).chargeUsd),
    );
  await admitJob(deps, config, key, {
    id,
    what: 'video',
    worstUsd: worst.toFixed(8),
    holdMs: TASK_HOLD_MS,
  });

  let started: { candidate: Candidate; job: UpstreamVideoJob; state: VideoState } | undefined;
  let failure: DiRouterError | undefined;
  for (const candidate of candidates) {
    const adapter = videoAdapterFor(candidate.provider.type);
    if (!adapter) continue;
    try {
      const target = await targetFor(config, candidate.provider.id, candidate.credential.id);
      const reply = await sendUpstream(
        config,
        target,
        adapter.create(
          {
            provider: candidate.provider,
            model: candidate.model,
            apiKey: target.apiKey,
            credentialHeaders: candidate.credential.headers,
          },
          { prompt, seconds: lengthOf(candidate), ...(size ? { size } : {}) },
        ),
      );
      if (reply.status >= 300) throw upstreamFailure('Starting the video', reply);
      started = { candidate, ...adapter.started(json(reply)) };
      break;
    } catch (error) {
      failure =
        error instanceof DiRouterError
          ? error
          : new DiRouterError('upstream_error', { message: (error as Error).message });
      deps.logger.warn(
        { taskId: id, provider: candidate.provider.slug, error: failure.message },
        'video could not start on this provider',
      );
      if (failure.status === 400) break;
    }
  }
  if (!started) {
    releaseJob(deps, key, id);
    throw (
      failure ??
      new DiRouterError('service_unavailable', { message: 'No provider accepted the video' })
    );
  }

  const now = nowSeconds();
  const record: TaskRecord = {
    id,
    type: 'video',
    organizationId: key.organizationId,
    projectId: key.projectId,
    teamId: key.teamId,
    virtualKeyId: key.id,
    ...(key.walletId ? { walletId: key.walletId } : {}),
    ...(key.priceMultiplier ? { priceMultiplier: key.priceMultiplier } : {}),
    model,
    modelId: started.candidate.model.id,
    providerId: started.candidate.provider.id,
    credentialId: started.candidate.credential.id,
    providerType: started.candidate.provider.type,
    pricing: started.candidate.model.pricing,
    ...(started.candidate.model.sale ? { sale: started.candidate.model.sale } : {}),
    prompt,
    seconds: lengthOf(started.candidate),
    ...(size ? { size } : {}),
    status: started.state.status === 'completed' ? 'in_progress' : started.state.status,
    progress: started.state.progress ?? 0,
    upstream: started.job,
    createdAt: now,
    expiresAt: now + TASK_TTL_SECONDS,
    ...(webhookUrl ? { webhookUrl } : {}),
    settled: false,
    checkedAt: Date.now(),
  };
  await save(deps, record);
  await deps.jobs.schedule('task', id, Date.now() + deps.jobOptions.pollIntervalMs);
  deps.logger.info(
    { taskId: id, provider: started.candidate.provider.slug, reservedUsd: worst.toFixed(8) },
    'video task created',
  );
  return reply.status(200).send(videoView(record));
}

async function save(deps: JobsDeps, record: TaskRecord): Promise<void> {
  await deps.jobs.put('task', record.id, record, {
    ttlSeconds: TASK_TTL_SECONDS,
    organizationId: record.organizationId,
    createdAt: record.createdAt * 1000,
  });
}

// ───────────── Follow ─────────────

/** One status check upstream; settles the task when it has ended. Safe across replicas. */
export async function refreshTask(deps: JobsDeps, id: string): Promise<TaskRecord | undefined> {
  if (!(await deps.jobs.lock('task', id, 120_000))) return deps.jobs.get<TaskRecord>('task', id);
  try {
    const record = await deps.jobs.get<TaskRecord>('task', id);
    if (!record || record.settled) {
      await deps.jobs.unschedule('task', id);
      return record;
    }
    const config = deps.store.current;
    const adapter = videoAdapterFor(record.providerType);
    if (!config || !adapter) return record;
    try {
      const target = await targetFor(config, record.providerId, record.credentialId);
      const t = {
        provider: target.provider,
        apiKey: target.apiKey,
        credentialHeaders: target.credential.headers,
      };
      const reply = await sendUpstream(config, target, adapter.status(t, record.upstream));
      if (reply.status >= 300) throw upstreamFailure('Checking the video', reply);
      const state = adapter.parseStatus(json(reply));
      if (state.videoUrl) record.upstream.videoUrl = state.videoUrl;
      let seconds = state.seconds;
      if (state.status === 'completed' && adapter.result && !record.upstream.videoUrl) {
        const result = await sendUpstream(config, target, adapter.result(t, record.upstream));
        if (result.status >= 300) {
          state.status = 'failed';
          state.error = {
            code: 'video_failed',
            message: upstreamFailure('The video', result).message,
          };
        } else {
          const parsed = adapter.parseResult?.(json(result)) ?? {};
          if (parsed.videoUrl) record.upstream.videoUrl = parsed.videoUrl;
          seconds = parsed.seconds ?? seconds;
          if (!parsed.videoUrl) {
            state.status = 'failed';
            state.error = { code: 'video_failed', message: 'The provider returned no video' };
          }
        }
      }
      record.status = state.status;
      record.progress = state.status === 'completed' ? 100 : (state.progress ?? record.progress);
      if (state.error) record.error = state.error;
      if (state.size) record.size = state.size;
      if (seconds !== undefined && seconds > 0) record.billedSeconds = seconds;
      record.checkedAt = Date.now();
      const ended = TERMINAL.includes(record.status);
      if (ended) await settle(deps, config, record);
      await save(deps, record);
      if (ended) await deps.jobs.unschedule('task', id);
      else await deps.jobs.schedule('task', id, Date.now() + deps.jobOptions.pollIntervalMs);
    } catch (error) {
      deps.logger.warn(
        { taskId: id, error: (error as Error).message },
        'video status check failed',
      );
      record.checkedAt = Date.now();
      await save(deps, record);
      await deps.jobs.schedule('task', id, Date.now() + deps.jobOptions.pollIntervalMs);
    }
    return record;
  } finally {
    await deps.jobs.unlock('task', id);
  }
}

/**
 * The end of a task: a completed one is billed per second and per request; a failed or cancelled
 * one records an error event at zero cost. The wallet hold becomes the charge; the webhook is sent.
 */
async function settle(
  deps: JobsDeps,
  config: NonNullable<JobsDeps['store']['current']>,
  record: TaskRecord,
): Promise<void> {
  const ok = record.status === 'completed';
  if (ok) record.completedAt = nowSeconds();
  const amounts = taskAmounts(
    { pricing: record.pricing, sale: record.sale },
    record.billedSeconds ?? record.seconds,
    record.priceMultiplier,
  );
  const costUsd = ok ? amounts.costUsd : '0.00000000';
  const chargeUsd = ok ? amounts.chargeUsd : '0.00000000';
  record.costUsd = costUsd;
  record.chargeUsd = chargeUsd;
  const event: UsageEvent = {
    schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
    eventId: ulid(),
    idempotencyKey: record.id,
    requestId: record.id,
    occurredAt: new Date().toISOString(),
    gatewayInstance: deps.instance,
    configVersion: config.version,
    organizationId: record.organizationId,
    teamId: record.teamId,
    projectId: record.projectId,
    virtualKeyId: record.virtualKeyId,
    ...(record.walletId ? { walletId: record.walletId } : {}),
    inboundApi: 'openai.videos',
    requestedModel: record.model,
    resolvedModelId: record.modelId,
    providerId: record.providerId,
    credentialId: record.credentialId,
    stream: false,
    status: ok ? 'success' : 'error',
    httpStatus: ok ? 200 : 500,
    ...(ok ? { media: amounts.media } : { errorCode: record.error?.code ?? 'video_failed' }),
    usage: amounts.usage,
    costUsd,
    chargeUsd,
    usageEstimated: ok && record.billedSeconds === undefined,
    latencyMs: Math.max(0, Date.now() - record.createdAt * 1000),
    attempts: [],
  };
  deps.metrics?.observe(event);
  deps.onRequestComplete?.(event);
  deps.emitUsage(event);
  if (record.walletId) deps.wallets?.settle(record.walletId, record.id, chargeUsd);
  const key = config.snapshot.virtualKeys.find(
    (k: VirtualKeyConfig) => k.id === record.virtualKeyId,
  );
  if (key && ok) deps.budgets?.record(budgetScopes(config, key), costUsd, 0);
  record.settled = true;
  if (record.webhookUrl)
    await enqueueWebhook(deps, {
      organizationId: record.organizationId,
      url: record.webhookUrl,
      type: ok ? 'video.completed' : 'video.failed',
      objectId: record.id,
    });
  deps.logger.info(
    { taskId: record.id, status: record.status, costUsd, chargeUsd },
    'video task settled',
  );
}

// ───────────── Routes ─────────────

async function owned(req: FastifyRequest, deps: JobsDeps): Promise<TaskRecord> {
  const { key } = authed(req, deps);
  const id = (req.params as { id: string }).id;
  const record = await deps.jobs.get<TaskRecord>('task', id);
  if (!record || record.organizationId !== key.organizationId) throw notFound('video', id);
  return record;
}

async function retrieve(req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) {
  let record = await owned(req, deps);
  if (
    !record.settled &&
    Date.now() - record.checkedAt >= Math.min(REFRESH_AFTER_MS, deps.jobOptions.pollIntervalMs)
  )
    record = (await refreshTask(deps, record.id)) ?? record;
  return reply.send(videoView(record));
}

/** Stops a running task at the provider and settles it as cancelled (nothing is billed). */
async function cancelTask(deps: JobsDeps, record: TaskRecord): Promise<TaskRecord> {
  if (TERMINAL.includes(record.status)) return record;
  const config = deps.store.current;
  const adapter = videoAdapterFor(record.providerType);
  if (!config || !adapter) throw new DiRouterError('service_unavailable');
  const target = await targetFor(config, record.providerId, record.credentialId);
  const request = adapter.cancel(
    {
      provider: target.provider,
      apiKey: target.apiKey,
      credentialHeaders: target.credential.headers,
    },
    record.upstream,
  );
  if (request) {
    const res = await sendUpstream(config, target, request);
    if (res.status >= 300 && res.status !== 404) throw upstreamFailure('Cancelling the video', res);
  }
  if (!(await deps.jobs.lock('task', record.id, 30_000)))
    throw new DiRouterError('conflict', {
      message: 'The video is being updated, retry shortly',
      status: 409,
    });
  try {
    const current = (await deps.jobs.get<TaskRecord>('task', record.id)) ?? record;
    if (current.settled) return current;
    current.status = 'failed';
    current.error = { code: 'cancelled', message: 'The video was cancelled.' };
    await settle(deps, config, current);
    await save(deps, current);
    await deps.jobs.unschedule('task', current.id);
    return current;
  } finally {
    await deps.jobs.unlock('task', record.id);
  }
}

/** Deletes a finished video at a provider whose cancel is a delete (OpenAI); best effort. */
async function forgetUpstream(deps: JobsDeps, record: TaskRecord): Promise<void> {
  const config = deps.store.current;
  const adapter = videoAdapterFor(record.providerType);
  if (!config || !adapter) return;
  try {
    const target = await targetFor(config, record.providerId, record.credentialId);
    const request = adapter.cancel(
      {
        provider: target.provider,
        apiKey: target.apiKey,
        credentialHeaders: target.credential.headers,
      },
      record.upstream,
    );
    if (request?.method === 'DELETE') await sendUpstream(config, target, request);
  } catch (error) {
    deps.logger.warn(
      { taskId: record.id, error: (error as Error).message },
      'upstream video delete failed',
    );
  }
}

async function content(req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) {
  const record = await owned(req, deps);
  const variant = ((req.query as { variant?: string }).variant ?? 'video') as VideoVariant;
  if (!['video', 'thumbnail', 'spritesheet'].includes(variant))
    throw invalid("variant must be 'video', 'thumbnail' or 'spritesheet'", 'variant');
  if (record.status !== 'completed')
    throw invalid(`The video is ${record.status}; content is available once it completes`, 'id');
  const config = deps.store.current;
  const adapter = videoAdapterFor(record.providerType);
  if (!config || !adapter) throw new DiRouterError('service_unavailable');
  const target = await targetFor(config, record.providerId, record.credentialId);
  const request = adapter.content(
    {
      provider: target.provider,
      apiKey: target.apiKey,
      credentialHeaders: target.credential.headers,
    },
    record.upstream,
    variant,
  );
  if (!request) throw invalid(`This provider offers no ${variant} for its videos`, 'variant');
  if (!/^https?:\/\//.test(request.url)) throw new DiRouterError('upstream_error');
  const timeouts = mergeTimeouts(
    config.snapshot.settings.defaultTimeouts,
    target.provider.timeouts,
  );
  const call = await callUpstream(
    target.provider,
    request,
    timeouts,
    AbortSignal.timeout(timeouts.totalMs),
    false,
    target.proxyUrl,
  );
  if (!call.response.ok || !call.response.body) {
    const body = Buffer.from(await readErrorBody(call.response));
    call.done();
    throw upstreamFailure('Downloading the video', {
      status: call.response.status,
      headers: call.response.headers,
      body,
    });
  }
  const stream = Readable.fromWeb(call.response.body);
  stream.once('close', () => {
    call.done();
  });
  const length = call.response.headers.get('content-length');
  if (length) void reply.header('content-length', length);
  return reply
    .header(
      'content-type',
      call.response.headers.get('content-type') ??
        (variant === 'video' ? 'video/mp4' : variant === 'thumbnail' ? 'image/webp' : 'image/jpeg'),
    )
    .send(stream);
}

async function list(req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) {
  const { key } = authed(req, deps);
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  const limit = q.limit === undefined ? 20 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw invalid('limit must be between 1 and 100', 'limit');
  const page = await deps.jobs.list<TaskRecord>('task', key.organizationId, {
    after: q.after,
    limit,
  });
  const data = page.data.map(videoView);
  return reply.send({
    object: 'list',
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: page.hasMore,
  });
}

export function registerVideoRoutes(app: FastifyInstance, deps: JobsDeps): void {
  const handle =
    (fn: (req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply, deps);
      } catch (error) {
        return sendError(reply, error);
      }
    };
  app.post('/v1/videos', handle(create));
  app.get('/v1/videos', handle(list));
  app.get('/v1/videos/:id', handle(retrieve));
  app.get('/v1/videos/:id/content', handle(content));
  app.post(
    '/v1/videos/:id/cancel',
    handle(async (req, reply, d) =>
      reply.send(videoView(await cancelTask(d, await owned(req, d)))),
    ),
  );
  app.delete(
    '/v1/videos/:id',
    handle(async (req, reply, d) => {
      const owned_ = await owned(req, d);
      const wasDone = TERMINAL.includes(owned_.status);
      const record = await cancelTask(d, owned_);
      if (wasDone) await forgetUpstream(d, record);
      await d.jobs.delete('task', record.id, record.organizationId);
      return reply.send({ id: record.id, object: 'video.deleted', deleted: true });
    }),
  );
  // The organization's webhook signing secret (Standard Webhooks, `whsec_…`).
  app.get(
    '/v1/webhooks/secret',
    handle(async (req, reply, d) => {
      const { key } = authed(req, d);
      return reply.send({
        object: 'webhook_secret',
        secret: webhookSecret(d.keyring, key.organizationId),
      });
    }),
  );
}
