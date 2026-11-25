/**
 * `/v1/batches` (card 30.1), OpenAI-compatible: create, retrieve, cancel and list.
 *
 * A batch runs on the provider's own batch API (OpenAI or Anthropic, see batch-native.ts), chosen
 * by routing the model of its lines with the caller's key. At creation the key's rate limit counts
 * one request, its budgets must have room, and the wallet holds the batch's worst case at the
 * batch price. The gateway then follows the upstream batch (the job poller, and every retrieve),
 * and when it ends copies the results into the organization's files, records one usage event with
 * the summed usage at the catalog's batch discount and swaps the wallet hold for the real charge.
 */
import {
  type CanonicalUsage,
  type ModelConfig,
  type SalePrice,
  USAGE_EVENT_SCHEMA_VERSION,
  type UsageEvent,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { batchPrice, computeCost } from '@dirouter/model-catalog';
import { applyDataPolicy, type Candidate, isRouteError } from '@dirouter/routing';
import { DiRouterError, ForbiddenError, formatUsd, NotFoundError, ulid } from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  addUsage,
  anthropicBatch,
  BATCH_ENDPOINTS,
  type BatchLine,
  convertAnthropicResults,
  convertOpenAIResults,
  type NativeBatchKind,
  nativeBatchKind,
  openaiBatch,
  type UpstreamBatchState,
} from './batch-native.js';
import { type Attribution, requestAttribution } from './attribution.js';
import { guardBodies } from './body-guardrails.js';
import { loadFile, saveFile } from './files.js';
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
import { admitJob, releaseJob } from './jobs/admission.js';
import { checkJobWebhookUrl, enqueueWebhook } from './jobs/webhooks.js';
import { chargeUnits } from './pricing.js';
import { planErrorToClient, routingFromRequest } from './route-request.js';
import { budgetScopes, quotaRefs } from './spend-guard.js';

/** OpenAI's limits: 50,000 requests per batch, a 24 hour completion window. */
export const MAX_BATCH_LINES = 50_000;
const COMPLETION_WINDOW_SECONDS = 86_400;
/** Batch records are kept a week after their window, like OpenAI's batch objects. */
const BATCH_TTL_SECONDS = COMPLETION_WINDOW_SECONDS + 30 * 86_400;
/** The wallet holds a batch's worst case until it ends (window plus an hour of finishing). */
const BATCH_HOLD_MS = (COMPLETION_WINDOW_SECONDS + 3_600) * 1000;
/** Output reserved per line when the line sets no limit and the model has no cap. */
const DEFAULT_LINE_OUTPUT_TOKENS = 4_096;
/** A retrieve refreshes from the provider at most this often. */
const REFRESH_AFTER_MS = 2_000;
/** How long one worker owns a batch it is checking or collecting; extended while it works. */
const LOCK_MS = 300_000;

type Status = UpstreamBatchState['status'];
const TERMINAL: readonly Status[] = ['completed', 'failed', 'expired', 'cancelled'];

export interface BatchRecord {
  id: string;
  organizationId: string;
  projectId: string;
  teamId: string | null;
  virtualKeyId: string;
  walletId?: string;
  priceMultiplier?: string;
  endpoint: string;
  inputFileId: string;
  completionWindow: string;
  metadata: Record<string, string> | null;
  /** The model the lines asked for, and what it resolved to. */
  model: string;
  modelId: string;
  providerId: string;
  credentialId: string;
  /** Prices at creation: the batch is billed at what it was quoted. */
  pricing: ModelConfig['pricing'];
  sale?: SalePrice;
  kind: NativeBatchKind;
  upstreamId: string;
  status: Status;
  requestCounts: { total: number; completed: number; failed: number };
  errors?: { code?: string; message?: string; line?: number | null }[];
  outputFileId?: string;
  errorFileId?: string;
  resultsUrl?: string;
  createdAt: number;
  expiresAt: number;
  inProgressAt?: number;
  finalizingAt?: number;
  completedAt?: number;
  failedAt?: number;
  expiredAt?: number;
  cancellingAt?: number;
  cancelledAt?: number;
  usage?: CanonicalUsage;
  costUsd?: string;
  chargeUsd?: string;
  /** Where the end of the batch is announced (card 30.6, a DiRouter extension). */
  webhookUrl?: string;
  /** End user, tags and cost center at creation: their budgets count the batch's spend. */
  attribution?: Attribution;
  /** Usage recorded and wallet settled; the batch needs no more work. */
  settled: boolean;
  checkedAt: number;
  configVersion: number;
}

export function batchView(b: BatchRecord) {
  const usage = b.usage;
  return {
    id: b.id,
    object: 'batch' as const,
    endpoint: b.endpoint,
    model: b.model,
    errors: b.errors?.length ? { object: 'list', data: b.errors } : null,
    input_file_id: b.inputFileId,
    completion_window: b.completionWindow,
    status: b.status,
    output_file_id: b.outputFileId ?? null,
    error_file_id: b.errorFileId ?? null,
    created_at: b.createdAt,
    in_progress_at: b.inProgressAt ?? null,
    expires_at: b.expiresAt,
    finalizing_at: b.finalizingAt ?? null,
    completed_at: b.completedAt ?? null,
    failed_at: b.failedAt ?? null,
    expired_at: b.expiredAt ?? null,
    cancelling_at: b.cancellingAt ?? null,
    cancelled_at: b.cancelledAt ?? null,
    request_counts: b.requestCounts,
    ...(usage
      ? {
          usage: {
            input_tokens: usage.inputTokens,
            input_tokens_details: { cached_tokens: usage.cacheReadTokens },
            output_tokens: usage.outputTokens,
            output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        }
      : {}),
    metadata: b.metadata,
  };
}

// ───────────── Input ─────────────

/** Reads and checks the input file: one model, one endpoint, unique custom ids. */
export function parseBatchInput(
  text: string,
  endpoint: string,
): { lines: BatchLine[]; model: string } {
  const lines: BatchLine[] = [];
  const ids = new Set<string>();
  let model: string | undefined;
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const source = raw[i]?.trim() ?? '';
    if (source === '') continue;
    const at = `line ${String(i + 1)}`;
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(source) as Record<string, unknown>;
    } catch {
      throw invalid(`${at} of the input file is not valid JSON`, 'input_file_id');
    }
    if (typeof line.custom_id !== 'string' || line.custom_id === '')
      throw invalid(`${at}: custom_id is required`, 'input_file_id');
    if (ids.has(line.custom_id))
      throw invalid(`${at}: custom_id '${line.custom_id}' is used twice`, 'input_file_id');
    ids.add(line.custom_id);
    if (line.method !== 'POST') throw invalid(`${at}: method must be POST`, 'input_file_id');
    if (line.url !== endpoint)
      throw invalid(`${at}: url must be the batch endpoint ${endpoint}`, 'input_file_id');
    const body = line.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || typeof body.model !== 'string')
      throw invalid(`${at}: body.model is required`, 'input_file_id');
    if (body.stream === true)
      throw invalid(`${at}: streaming is not supported in a batch`, 'input_file_id');
    if (model !== undefined && body.model !== model)
      throw invalid('every line of a batch must use the same model', 'input_file_id');
    model = body.model;
    lines.push({ custom_id: line.custom_id, method: 'POST', url: endpoint, body });
    if (lines.length > MAX_BATCH_LINES)
      throw invalid(`a batch holds at most ${String(MAX_BATCH_LINES)} requests`, 'input_file_id');
  }
  if (!model || lines.length === 0)
    throw invalid('the input file has no requests', 'input_file_id');
  return { lines, model };
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 1 ? value : 1;

/**
 * The most one line may use: `n` choices each up to the output cap, and for legacy completions
 * `best_of` generated completions per prompt (at least `n`), for every prompt of the line.
 */
export function lineTokens(line: BatchLine, model: Pick<ModelConfig, 'maxOutputTokens'>) {
  const input = Math.ceil(
    JSON.stringify(line.body.messages ?? line.body.input ?? line.body.prompt ?? '').length / 4,
  );
  if (line.url === '/v1/embeddings') return { input, output: 0 };
  const cap = [
    line.body.max_completion_tokens,
    line.body.max_tokens,
    line.body.max_output_tokens,
  ].find((v): v is number => typeof v === 'number' && v > 0);
  const perChoice = cap ?? model.maxOutputTokens ?? DEFAULT_LINE_OUTPUT_TOKENS;
  let choices = count(line.body.n);
  if (line.url === '/v1/completions') {
    choices = Math.max(choices, count(line.body.best_of));
    const prompt = line.body.prompt;
    const prompts =
      Array.isArray(prompt) && prompt.length > 0 && !prompt.every((t) => typeof t === 'number')
        ? prompt.length
        : 1;
    choices *= prompts;
  }
  return { input, output: perChoice * choices };
}

/** What a usage costs and is charged at the batch price. */
export function batchAmounts(
  usage: CanonicalUsage,
  model: Pick<ModelConfig, 'pricing'> & { sale?: SalePrice | undefined },
  groupMultiplier: string | undefined,
) {
  return {
    costUsd: formatUsd(batchPrice(computeCost(usage, model.pricing).total, model.pricing)),
    chargeUnits: batchPrice(chargeUnits(usage, model, { groupMultiplier }), model.pricing),
  };
}

const zero: CanonicalUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

// ───────────── Create ─────────────

async function create(req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) {
  const { config, key } = authed(req, deps);
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.input_file_id !== 'string')
    throw invalid('input_file_id is required', 'input_file_id');
  const endpoint = body.endpoint;
  if (typeof endpoint !== 'string' || !BATCH_ENDPOINTS.openai.includes(endpoint))
    throw invalid(`endpoint must be one of ${BATCH_ENDPOINTS.openai.join(', ')}`, 'endpoint');
  if (body.completion_window !== '24h')
    throw invalid("completion_window must be '24h'", 'completion_window');
  const metadata = body.metadata ?? null;
  if (
    metadata !== null &&
    (typeof metadata !== 'object' ||
      Object.keys(metadata).length > 16 ||
      Object.entries(metadata).some(
        ([k, v]) => k.length > 64 || typeof v !== 'string' || v.length > 512,
      ))
  )
    throw invalid(
      'metadata holds at most 16 string pairs (keys 64, values 512 characters)',
      'metadata',
    );

  const webhookUrl =
    body.webhook_url === undefined
      ? undefined
      : await checkJobWebhookUrl(body.webhook_url, key.organizationId);

  const file = await loadFile(deps, key.organizationId, body.input_file_id);
  if (!file) throw notFound('file', body.input_file_id);
  if (file.purpose !== 'batch')
    throw invalid("the input file's purpose must be 'batch'", 'input_file_id');
  const bytes = await deps.blobs.get(file.storageKey);
  if (!bytes) throw notFound('file', file.id);
  const { lines, model } = parseBatchInput(bytes.toString('utf8'), endpoint);

  // Request guardrails (card 15.1) on every line, as on chat: a line a policy blocks refuses the
  // whole batch before anything is sent upstream; redaction rewrites the lines that are sent.
  const guard = await guardBodies(
    req,
    deps,
    config,
    key,
    lines.map((l) => l.body),
  );
  if (guard.blocked) {
    const line = lines[guard.blocked.index];
    throw invalid(
      `request '${line?.custom_id ?? ''}' of the input file: ${guard.blocked.message}`,
      'input_file_id',
    );
  }

  const estimatedInputTokens = lines.reduce(
    (sum, l) => sum + Math.ceil(JSON.stringify(l.body).length / 4),
    0,
  );
  // The data policy (card 32.5) of the organization, project, key and request holds for batches
  // like for chat: a provider that keeps or trains on data, or sits outside the allowed regions,
  // never receives the lines.
  const { dataPolicy } = routingFromRequest(config.snapshot.routingPolicies, key, req.body);
  const resolved = config.router.resolve(key, model, { estimatedInputTokens: 0 });
  const route =
    dataPolicy && !isRouteError(resolved) ? applyDataPolicy(resolved, dataPolicy) : resolved;
  if ('error' in route && route.error === 'no_provider_matches_data_policy')
    throw planErrorToClient(route, model);
  if ('error' in route)
    throw route.error === 'model_not_found'
      ? new NotFoundError('model_not_found', {
          message: `Model '${model}' not found`,
          param: 'model',
        })
      : route.error === 'model_not_allowed'
        ? new ForbiddenError('model_not_allowed', { param: 'model' })
        : new DiRouterError('service_unavailable', { message: `No provider can serve '${model}'` });
  const candidates = route.candidates.filter((c) => {
    const kind = nativeBatchKind(c.provider);
    return kind !== undefined && BATCH_ENDPOINTS[kind].includes(endpoint);
  });
  if (candidates.length === 0)
    throw invalid(`'${model}' has no provider with a batch API for ${endpoint}`, 'input_file_id');

  const id = `batch_${ulid()}`;
  const attribution = requestAttribution(req.headers, body.user, key);
  // The wallet holds the most the batch can cost on the most expensive candidate left.
  let reserved = '0.00000000';
  const worstOf = (left: Candidate[]) => {
    let worst = 0n;
    for (const c of left) {
      const usage = lines.reduce((u, l) => {
        const t = lineTokens(l, c.model);
        return addUsage(u, { ...zero, inputTokens: t.input, outputTokens: t.output });
      }, zero);
      const amount = batchAmounts(usage, c.model, key.priceMultiplier).chargeUnits;
      if (amount > worst) worst = amount;
    }
    reserved = formatUsd(worst);
    return reserved;
  };
  // Same admission as chat: end-user block, every budget (with the candidates' model, provider,
  // account and credential budgets and quota windows) and the rate limits.
  const admitted = await admitJob(deps, config, key, {
    id,
    what: 'batch',
    worstUsd: worstOf,
    holdMs: BATCH_HOLD_MS,
    candidates,
    attribution,
    requested: model,
  });

  let started: { candidate: Candidate; upstreamId: string; state: UpstreamBatchState } | undefined;
  let failure: DiRouterError | undefined;
  for (const candidate of admitted) {
    try {
      started = await startUpstream(config, candidate, lines, endpoint);
      break;
    } catch (error) {
      // An unexpected error (network, proxy, malformed answer) may name internal addresses: the
      // client gets a generic message, the log the detail.
      failure =
        error instanceof DiRouterError
          ? error
          : new DiRouterError('upstream_error', {
              message: 'The provider could not start the batch',
              status: 502,
            });
      deps.logger.warn(
        { batchId: id, provider: candidate.provider.slug, error: (error as Error).message },
        'batch could not start on this provider',
      );
      // A request the provider rejects as invalid is not retried elsewhere.
      if (failure.status === 400) break;
    }
  }
  if (!started) {
    releaseJob(deps, key, id);
    throw (
      failure ??
      new DiRouterError('service_unavailable', { message: 'No provider accepted the batch' })
    );
  }

  const now = nowSeconds();
  const record: BatchRecord = {
    id,
    organizationId: key.organizationId,
    projectId: key.projectId,
    teamId: key.teamId,
    virtualKeyId: key.id,
    ...(key.walletId ? { walletId: key.walletId } : {}),
    ...(key.priceMultiplier ? { priceMultiplier: key.priceMultiplier } : {}),
    endpoint,
    inputFileId: file.id,
    completionWindow: '24h',
    metadata: metadata as Record<string, string> | null,
    model,
    modelId: started.candidate.model.id,
    providerId: started.candidate.provider.id,
    credentialId: started.candidate.credential.id,
    pricing: started.candidate.model.pricing,
    ...(started.candidate.model.sale ? { sale: started.candidate.model.sale } : {}),
    kind: nativeBatchKind(started.candidate.provider) ?? 'openai',
    upstreamId: started.upstreamId,
    status: 'validating',
    requestCounts: { total: lines.length, completed: 0, failed: 0 },
    createdAt: now,
    expiresAt: now + COMPLETION_WINDOW_SECONDS,
    ...(webhookUrl ? { webhookUrl } : {}),
    ...(Object.keys(attribution).length > 0 ? { attribution } : {}),
    settled: false,
    checkedAt: Date.now(),
    configVersion: config.version,
  };
  apply(record, started.state);
  await save(deps, record);
  await deps.jobs.schedule('batch', id, Date.now() + deps.jobOptions.pollIntervalMs);
  deps.logger.info(
    {
      batchId: id,
      provider: started.candidate.provider.slug,
      lines: lines.length,
      reservedUsd: reserved,
      estimatedInputTokens,
    },
    'batch created',
  );
  return reply.status(200).send(batchView(record));
}

async function startUpstream(
  config: NonNullable<JobsDeps['store']['current']>,
  candidate: Candidate,
  lines: BatchLine[],
  endpoint: string,
) {
  const target = await targetFor(config, candidate.provider.id, candidate.credential.id);
  const t = {
    provider: candidate.provider,
    model: candidate.model,
    apiKey: target.apiKey,
    credentialHeaders: candidate.credential.headers,
  };
  if (nativeBatchKind(candidate.provider) === 'anthropic') {
    let request;
    try {
      request = anthropicBatch.create(t, lines);
    } catch (error) {
      throw invalid((error as Error).message, 'input_file_id');
    }
    const created = await sendUpstream(config, target, request);
    if (created.status >= 300)
      throw upstreamFailure('Creating the batch', created, candidate.provider);
    const body = json(created);
    return {
      candidate,
      upstreamId: anthropicBatch.createdId(body),
      state: anthropicBatch.parse(body, false),
    };
  }
  const uploaded = await sendUpstream(config, target, openaiBatch.upload(t, lines));
  if (uploaded.status >= 300)
    throw upstreamFailure('Uploading the batch input', uploaded, candidate.provider);
  const fileId = openaiBatch.uploadedId(json(uploaded));
  const created = await sendUpstream(
    config,
    target,
    openaiBatch.create(t, { fileId, endpoint, completionWindow: '24h' }),
  );
  if (created.status >= 300)
    throw upstreamFailure('Creating the batch', created, candidate.provider);
  const body = json(created) as { id?: unknown };
  if (typeof body.id !== 'string') throw new Error('the provider returned no batch id');
  return { candidate, upstreamId: body.id, state: openaiBatch.parse(body) };
}

// ───────────── Follow ─────────────

const STAMP: Partial<Record<Status, keyof BatchRecord>> = {
  in_progress: 'inProgressAt',
  finalizing: 'finalizingAt',
  completed: 'completedAt',
  failed: 'failedAt',
  expired: 'expiredAt',
  cancelling: 'cancellingAt',
  cancelled: 'cancelledAt',
};

function apply(record: BatchRecord, state: UpstreamBatchState): void {
  // A cancel the client asked for stays visible until the provider confirms the end.
  const status =
    record.status === 'cancelling' && !TERMINAL.includes(state.status)
      ? 'cancelling'
      : state.status;
  if (status !== record.status) {
    const stamp = STAMP[status];
    if (stamp && record[stamp] === undefined)
      (record as unknown as Record<string, number>)[stamp] = nowSeconds();
    if (status !== 'validating' && record.inProgressAt === undefined && status !== 'failed')
      record.inProgressAt = nowSeconds();
  }
  record.status = status;
  if (state.requestCounts.total > 0) record.requestCounts = state.requestCounts;
  if (state.errors?.length) record.errors = state.errors;
  if (state.resultsUrl) record.resultsUrl = state.resultsUrl;
}

async function save(deps: JobsDeps, record: BatchRecord): Promise<void> {
  await deps.jobs.put('batch', record.id, record, {
    ttlSeconds: BATCH_TTL_SECONDS,
    organizationId: record.organizationId,
    createdAt: record.createdAt * 1000,
  });
}

/** The worker's lock on a batch ran out and another replica took the batch over. */
class LockLost extends Error {
  constructor(id: string) {
    super(`lost the lock on ${id}`);
  }
}

/**
 * Checks the upstream batch once and, when it has ended, collects the results and settles. Safe
 * to call from several replicas: one holds the lock, the others return the stored record. The lock
 * is extended while the work runs, and ownership is checked again before the batch is billed and
 * saved, so a worker whose lock ran out never settles a batch another replica is settling.
 */
export async function refreshBatch(deps: JobsDeps, id: string): Promise<BatchRecord | undefined> {
  const token = await deps.jobs.acquire('batch', id, LOCK_MS);
  if (token === undefined) return deps.jobs.get<BatchRecord>('batch', id);
  let lost = false;
  const keepAlive = (): Promise<boolean> =>
    deps.jobs.extend('batch', id, token, LOCK_MS).then(
      (ok) => {
        if (!ok) lost = true;
        return ok;
      },
      () => false,
    );
  const keeper = setInterval(() => void keepAlive(), LOCK_MS / 3);
  keeper.unref();
  const stillOwned = async () => {
    if (lost || !(await keepAlive())) throw new LockLost(id);
  };
  try {
    const record = await deps.jobs.get<BatchRecord>('batch', id);
    if (!record) {
      await deps.jobs.unschedule('batch', id);
      return undefined;
    }
    if (record.settled) {
      await deps.jobs.unschedule('batch', id);
      return record;
    }
    const config = deps.store.current;
    if (!config) return record;
    try {
      const target = await targetFor(config, record.providerId, record.credentialId);
      const t = {
        provider: target.provider,
        apiKey: target.apiKey,
        credentialHeaders: target.credential.headers,
      };
      const reply = await sendUpstream(
        config,
        target,
        record.kind === 'anthropic'
          ? anthropicBatch.status(t, record.upstreamId)
          : openaiBatch.status(t, record.upstreamId),
      );
      if (reply.status >= 300) throw upstreamFailure('Checking the batch', reply, target.provider);
      const state =
        record.kind === 'anthropic'
          ? anthropicBatch.parse(json(reply), record.status === 'cancelling')
          : openaiBatch.parse(json(reply));
      apply(record, state);
      record.checkedAt = Date.now();
      const ended = TERMINAL.includes(record.status);
      if (ended) await finish(deps, config, record, state, target, stillOwned);
      await stillOwned();
      await save(deps, record);
      if (ended) await deps.jobs.unschedule('batch', id);
      else await deps.jobs.schedule('batch', id, Date.now() + deps.jobOptions.pollIntervalMs);
    } catch (error) {
      if (error instanceof LockLost) {
        // Another replica owns the batch now: it bills and saves it, this worker writes nothing.
        deps.logger.warn({ batchId: id }, 'batch lock ran out; left to the replica that holds it');
        return (await deps.jobs.get<BatchRecord>('batch', id)) ?? record;
      }
      deps.logger.warn(
        { batchId: id, error: (error as Error).message },
        'batch status check failed',
      );
      record.checkedAt = Date.now();
      await save(deps, record);
      await deps.jobs.schedule('batch', id, Date.now() + deps.jobOptions.pollIntervalMs);
    }
    return record;
  } finally {
    clearInterval(keeper);
    await deps.jobs.release('batch', id, token);
  }
}

async function finish(
  deps: JobsDeps,
  config: NonNullable<JobsDeps['store']['current']>,
  record: BatchRecord,
  state: UpstreamBatchState,
  target: Awaited<ReturnType<typeof targetFor>>,
  stillOwned: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  const t = {
    provider: target.provider,
    apiKey: target.apiKey,
    credentialHeaders: target.credential.headers,
  };
  const text = async (request: Parameters<typeof sendUpstream>[2]) => {
    const reply = await sendUpstream(config, target, request);
    if (reply.status >= 300)
      throw upstreamFailure('Downloading batch results', reply, target.provider);
    return reply.body.toString('utf8');
  };
  let converted = { output: [] as string[], errors: [] as string[], usage: zero };
  if (record.kind === 'anthropic') {
    if (record.status !== 'failed') {
      const model = config.snapshot.models.find((m) => m.id === record.modelId);
      converted = convertAnthropicResults(
        await text(anthropicBatch.results(t, record.upstreamId, state.resultsUrl)),
        {
          provider: target.provider,
          model: model ?? ({ upstreamModel: record.model } as ModelConfig),
        },
        record.model,
      );
    }
  } else {
    converted = convertOpenAIResults(
      state.outputFileId ? await text(openaiBatch.content(t, state.outputFileId)) : '',
      state.errorFileId ? await text(openaiBatch.content(t, state.errorFileId)) : '',
      record.model,
    );
  }
  const owner = {
    organizationId: record.organizationId,
    projectId: record.projectId,
    id: record.virtualKeyId,
  };
  const encode = (lines: string[]) => new TextEncoder().encode(`${lines.join('\n')}\n`);
  if (converted.output.length > 0)
    record.outputFileId = (
      await saveFile(deps, owner, {
        filename: `${record.id}_output.jsonl`,
        purpose: 'batch_output',
        data: encode(converted.output),
      })
    ).id;
  if (converted.errors.length > 0)
    record.errorFileId = (
      await saveFile(deps, owner, {
        filename: `${record.id}_error.jsonl`,
        purpose: 'batch_output',
        data: encode(converted.errors),
      })
    ).id;
  if (record.kind === 'anthropic')
    record.requestCounts = {
      total: converted.output.length + converted.errors.length,
      completed: converted.output.length,
      failed: converted.errors.length,
    };
  // Results can take long to collect: bill only while this worker still owns the batch.
  await stillOwned();
  settle(deps, config, record, converted.usage);
  if (record.webhookUrl)
    await enqueueWebhook(deps, {
      organizationId: record.organizationId,
      url: record.webhookUrl,
      type: `batch.${record.status}`,
      objectId: record.id,
    });
}

/** The model, provider and credential a batch ran on, from the current snapshot. */
function servedCandidate(
  config: NonNullable<JobsDeps['store']['current']>,
  record: BatchRecord,
): Candidate | undefined {
  const model = config.snapshot.models.find((m) => m.id === record.modelId);
  const provider = config.snapshot.providers.find((p) => p.id === record.providerId);
  const credential = provider?.credentials.find((c) => c.id === record.credentialId);
  return model && provider && credential ? { model, provider, credential } : undefined;
}

/** One usage event for the whole batch, at the batch price; the wallet hold becomes the charge. */
function settle(
  deps: JobsDeps,
  config: NonNullable<JobsDeps['store']['current']>,
  record: BatchRecord,
  usage: CanonicalUsage,
): void {
  const amounts = batchAmounts(
    usage,
    { pricing: record.pricing, sale: record.sale },
    record.priceMultiplier,
  );
  const chargeUsd = formatUsd(amounts.chargeUnits);
  const ok = record.status !== 'failed' && record.requestCounts.completed > 0;
  record.usage = usage;
  record.costUsd = amounts.costUsd;
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
    inboundApi: 'openai.batches',
    requestedModel: record.model,
    resolvedModelId: record.modelId,
    providerId: record.providerId,
    credentialId: record.credentialId,
    stream: false,
    status: ok ? 'success' : 'error',
    httpStatus: ok ? 200 : 500,
    ...(ok ? {} : { errorCode: `batch_${record.status}` }),
    usage,
    costUsd: amounts.costUsd,
    chargeUsd,
    usageEstimated: false,
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
  if (key) {
    // Every budget the batch was admitted against: the end user's, tags and cost center, and the
    // served model's, provider's, account's and credential's budgets and quota windows.
    const served = servedCandidate(config, record);
    deps.budgets?.record(
      budgetScopes(config, key, served ? [served] : [], record.attribution ?? {}, record.model),
      amounts.costUsd,
      usage.inputTokens + usage.outputTokens,
      served
        ? {
            modelId: served.model.id,
            providerId: served.provider.id,
            credentialId: served.credential.id,
          }
        : undefined,
      served ? quotaRefs([served]) : [],
    );
  }
  record.settled = true;
  deps.logger.info(
    { batchId: record.id, status: record.status, costUsd: amounts.costUsd, chargeUsd },
    'batch settled',
  );
}

// ───────────── Routes ─────────────

async function owned(req: FastifyRequest, deps: JobsDeps): Promise<BatchRecord> {
  const { key } = authed(req, deps);
  const id = (req.params as { id: string }).id;
  const record = await deps.jobs.get<BatchRecord>('batch', id);
  if (!record || record.organizationId !== key.organizationId) throw notFound('batch', id);
  return record;
}

async function retrieve(req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) {
  let record = await owned(req, deps);
  if (
    !record.settled &&
    Date.now() - record.checkedAt >= Math.min(REFRESH_AFTER_MS, deps.jobOptions.pollIntervalMs)
  )
    record = (await refreshBatch(deps, record.id)) ?? record;
  return reply.send(batchView(record));
}

async function cancel(req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) {
  const record = await owned(req, deps);
  if (TERMINAL.includes(record.status) || record.status === 'cancelling')
    return reply.send(batchView(record));
  const config = deps.store.current;
  if (!config) throw new DiRouterError('service_unavailable');
  const target = await targetFor(config, record.providerId, record.credentialId);
  const t = {
    provider: target.provider,
    apiKey: target.apiKey,
    credentialHeaders: target.credential.headers,
  };
  const res = await sendUpstream(
    config,
    target,
    record.kind === 'anthropic'
      ? anthropicBatch.cancel(t, record.upstreamId)
      : openaiBatch.cancel(t, record.upstreamId),
  );
  if (res.status >= 300) throw upstreamFailure('Cancelling the batch', res, target.provider);
  const token = await deps.jobs.acquire('batch', record.id, 30_000);
  if (token === undefined)
    throw new DiRouterError('conflict', {
      message: 'The batch is being updated, retry shortly',
      status: 409,
    });
  try {
    const current = (await deps.jobs.get<BatchRecord>('batch', record.id)) ?? record;
    if (!TERMINAL.includes(current.status)) {
      current.status = 'cancelling';
      current.cancellingAt = nowSeconds();
      await save(deps, current);
      await deps.jobs.schedule('batch', current.id, Date.now());
    }
    return await reply.send(batchView(current));
  } finally {
    await deps.jobs.release('batch', record.id, token);
  }
}

async function list(req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) {
  const { key } = authed(req, deps);
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  const limit = q.limit === undefined ? 20 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw invalid('limit must be between 1 and 100', 'limit');
  const page = await deps.jobs.list<BatchRecord>('batch', key.organizationId, {
    after: q.after,
    limit,
  });
  const data = page.data.map(batchView);
  return reply.send({
    object: 'list',
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: page.hasMore,
  });
}

export function registerBatchRoutes(app: FastifyInstance, deps: JobsDeps): void {
  const handle =
    (fn: (req: FastifyRequest, reply: FastifyReply, deps: JobsDeps) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply, deps);
      } catch (error) {
        return sendError(reply, error);
      }
    };
  app.post('/v1/batches', handle(create));
  app.get('/v1/batches', handle(list));
  app.get('/v1/batches/:id', handle(retrieve));
  app.post('/v1/batches/:id/cancel', handle(cancel));
}
