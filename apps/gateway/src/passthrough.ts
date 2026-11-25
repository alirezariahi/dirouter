/**
 * Native provider pass-through (card 30.7): `/passthrough/{provider}/{path}` forwards a request
 * DiRouter does not translate (batches, files, legacy completions, a provider's own API) to the
 * provider's base URL, unchanged, behind the same virtual key.
 *
 * What still applies, exactly as for translated traffic:
 * - virtual-key authentication (expiry, IP allow-list) and the key's own pass-through grant
 *   (`passthroughProviders`: provider slugs or `*`; empty, the default, means off);
 * - the provider's path allow-list (`options.passthroughPaths`; empty means nothing is allowed);
 * - rate limits (RPM and TPM), budgets and the key's concurrency cap;
 * - request guardrails on the JSON body (block and redact), and response guardrails on a JSON
 *   answer (streams and binary answers flow through unchanged);
 * - a usage event per request (inbound API `passthrough`), priced when the answer carries usage
 *   for a model configured on that provider.
 *
 * The client's DiRouter key never reaches the provider: only an allow-list of request headers is
 * forwarded, `?key=` is dropped, and the credential's own authentication is added instead.
 * Prepaid (wallet) keys are refused, since the cost cannot be reserved before the call.
 */
import { Readable } from 'node:stream';

import {
  type CanonicalUsage,
  type ModelConfig,
  type ProviderConfig,
  type ProviderType,
  type UsageEvent,
  USAGE_EVENT_SCHEMA_VERSION,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { computeCostUsd } from '@dirouter/model-catalog';
import {
  adapterForProvider,
  classifyNetworkError,
  type UpstreamRequest,
} from '@dirouter/providers';
import {
  DiRouterError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ulid,
} from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticate, extractApiKey } from './auth.js';
import { resolveCredentialKey } from './credential-tokens.js';
import { evaluateGuardrails, policiesFor } from './guardrails.js';
import { chargeUsd } from './pricing.js';
import { budgetScopes, errorPayload, limitScopes, type ProxyDeps } from './proxy.js';
import { callUpstream, mergeTimeouts, UpstreamTimeout } from './upstream.js';

export const PASSTHROUGH_PREFIX = '/passthrough/';
/** Bytes of the answer inspected for usage; the rest still reaches the client. */
const MAX_CAPTURE = 1_048_576;
/** A JSON answer held for response guardrails may not be larger than this. */
const MAX_GUARDED_ANSWER = 4 * 1_048_576;
const MAX_BODY = 20 * 1_048_576;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** Bedrock signs every request with SigV4 and plugins own their transport: nothing to inject. */
const UNSUPPORTED: readonly ProviderType[] = ['bedrock', 'plugin'];

/** The only client headers that reach the provider; credentials are never among them. */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'openai-beta',
  'idempotency-key',
] as const;
const FORWARDED_RESPONSE_HEADERS =
  /^(content-type|content-disposition|cache-control|retry-after|x-ratelimit-[a-z0-9-]+|anthropic-ratelimit-[a-z0-9-]+)$/;

/** The provider's path allow-list (`options.passthroughPaths`). */
export function passthroughPaths(provider: ProviderConfig): string[] {
  const raw = provider.options.passthroughPaths;
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
}

/** One allow-list entry: `[METHOD ]/path`, where a trailing `*` matches any rest. */
export const PASSTHROUGH_PATH_PATTERN = /^(?:(GET|POST|PUT|PATCH|DELETE) )?(\/[\x21-\x7e]*)$/;

export function pathAllowed(patterns: readonly string[], method: string, path: string): boolean {
  for (const entry of patterns) {
    const match = PASSTHROUGH_PATH_PATTERN.exec(entry.trim());
    if (!match) continue;
    const [, verb, pattern = ''] = match;
    if (verb && verb !== method) continue;
    if (pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern)
      return true;
  }
  return false;
}

/**
 * A path that cannot climb out of the provider's base URL: printable ASCII, no `.`/`..`
 * segments, no empty segments, and no encoded slash, backslash, dot or NUL.
 */
export function safePath(path: string): boolean {
  if (!path.startsWith('/') || path.length > 2_048) return false;
  if (!/^[\x21-\x7e]+$/.test(path)) return false;
  if (/%(2e|2f|5c|00)/i.test(path) || path.includes('\\') || path.includes('//')) return false;
  return !path.split('/').some((segment) => segment === '.' || segment === '..');
}

export function keyMayPassthrough(key: VirtualKeyConfig, providerSlug: string): boolean {
  const grants = key.passthroughProviders;
  return grants.includes('*') || grants.includes(providerSlug);
}

/** The upstream URL, or undefined when it would leave the provider's base URL. */
export function upstreamUrl(baseUrl: string, path: string, query: string): string | undefined {
  const base = new URL(baseUrl);
  const params = new URLSearchParams(query);
  // A Gemini-style client key in the query string is DiRouter's key, never the provider's.
  params.delete('key');
  const qs = params.toString();
  const target = new URL(`${baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`);
  const basePath = base.pathname.replace(/\/+$/, '');
  if (target.origin !== base.origin) return undefined;
  if (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) return undefined;
  return target.toString();
}

// ───────────── usage in the answer ─────────────

interface Found {
  usage: Partial<CanonicalUsage>;
  model?: string;
}

const num = (value: unknown) => (typeof value === 'number' && value >= 0 ? value : undefined);
const record = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function readUsageObject(raw: Record<string, unknown>): Partial<CanonicalUsage> {
  const out: Partial<CanonicalUsage> = {};
  // Gemini: usageMetadata.
  if (num(raw.promptTokenCount) !== undefined || num(raw.candidatesTokenCount) !== undefined) {
    out.inputTokens = num(raw.promptTokenCount) ?? 0;
    out.outputTokens = (num(raw.candidatesTokenCount) ?? 0) + (num(raw.thoughtsTokenCount) ?? 0);
    if (num(raw.cachedContentTokenCount)) out.cacheReadTokens = num(raw.cachedContentTokenCount);
    if (num(raw.thoughtsTokenCount)) out.reasoningTokens = num(raw.thoughtsTokenCount);
    return out;
  }
  // OpenAI chat and legacy completions.
  if (num(raw.prompt_tokens) !== undefined || num(raw.completion_tokens) !== undefined) {
    out.inputTokens = num(raw.prompt_tokens) ?? 0;
    out.outputTokens = num(raw.completion_tokens) ?? 0;
    const cached = num(record(raw.prompt_tokens_details)?.cached_tokens);
    if (cached) out.cacheReadTokens = cached;
    const reasoning = num(record(raw.completion_tokens_details)?.reasoning_tokens);
    if (reasoning) out.reasoningTokens = reasoning;
    return out;
  }
  // Anthropic (input excludes cache reads and writes) and the OpenAI Responses API.
  if (num(raw.input_tokens) !== undefined || num(raw.output_tokens) !== undefined) {
    const cacheRead = num(raw.cache_read_input_tokens) ?? 0;
    const cacheWrite = num(raw.cache_creation_input_tokens) ?? 0;
    const responsesCached = num(record(raw.input_tokens_details)?.cached_tokens);
    const input = num(raw.input_tokens);
    if (input !== undefined) out.inputTokens = input + cacheRead + cacheWrite;
    const output = num(raw.output_tokens);
    if (output !== undefined) out.outputTokens = output;
    if (cacheRead || responsesCached) out.cacheReadTokens = cacheRead || responsesCached;
    if (cacheWrite) out.cacheWriteTokens = cacheWrite;
    const reasoning = num(record(raw.output_tokens_details)?.reasoning_tokens);
    if (reasoning) out.reasoningTokens = reasoning;
  }
  return out;
}

function inspect(json: unknown, found: Found): void {
  const top = record(json);
  if (!top) return;
  for (const holder of [top, record(top.message), record(top.response)]) {
    if (!holder) continue;
    const model = holder.model ?? holder.modelVersion;
    if (typeof model === 'string' && model !== '' && !found.model) found.model = model;
    const usage = record(holder.usage) ?? record(holder.usageMetadata);
    if (!usage) continue;
    // Streams report usage in pieces (Anthropic: input at the start, output at the end); the
    // largest value of each field is the final one.
    for (const [field, value] of Object.entries(readUsageObject(usage)) as [
      keyof CanonicalUsage,
      number,
    ][])
      found.usage[field] = Math.max(found.usage[field] ?? 0, value);
  }
}

/** Usage and model reported in a JSON or SSE answer, if any. */
export function usageFromAnswer(contentType: string, text: string): Found {
  const found: Found = { usage: {} };
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '' || data === '[DONE]') continue;
      try {
        inspect(JSON.parse(data), found);
      } catch {
        // A truncated or non-JSON event carries nothing to count.
      }
    }
    return found;
  }
  if (contentType.includes('json'))
    try {
      inspect(JSON.parse(text), found);
    } catch {
      // Not JSON after all.
    }
  return found;
}

// ───────────── guardrails on raw JSON ─────────────

interface Leaf {
  holder: Record<string, unknown> | unknown[];
  key: string | number;
}

/** Every string value of a JSON document (except `model`), for guardrails to read and rewrite. */
function stringLeaves(value: unknown, out: Leaf[] = []): Leaf[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === 'string') out.push({ holder: value, key: index });
      else stringLeaves(item, out);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'model') continue;
      if (typeof item === 'string') out.push({ holder: value as Record<string, unknown>, key });
      else stringLeaves(item, out);
    }
  }
  return out;
}

const leafGet = (leaf: Leaf) =>
  Array.isArray(leaf.holder)
    ? (leaf.holder[leaf.key as number] as string)
    : (leaf.holder[leaf.key as string] as string);
const leafSet = (leaf: Leaf, text: string) => {
  if (Array.isArray(leaf.holder)) leaf.holder[leaf.key as number] = text;
  else leaf.holder[leaf.key as string] = text;
};

type GuardOutcome = { blocked: string } | { body: Buffer | undefined; redactions: number };

/** Request or response guardrails over the string values of a JSON body. */
export function guardJson(
  policies: Parameters<typeof evaluateGuardrails>[0],
  stage: 'request' | 'response',
  body: Buffer,
): GuardOutcome {
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return { body, redactions: 0 };
  }
  const leaves = stringLeaves(json);
  if (leaves.length === 0) return { body, redactions: 0 };
  const parts = leaves.map((leaf) => ({ type: 'text' as const, text: leafGet(leaf) }));
  const result =
    stage === 'request'
      ? evaluateGuardrails(policies, {
          stage,
          request: {
            inboundApi: 'openai.chat',
            model: '',
            system: [],
            messages: [{ role: 'user', content: parts }],
            stream: false,
          },
        })
      : evaluateGuardrails(policies, {
          stage,
          response: {
            id: 'passthrough',
            model: '',
            content: parts,
            finishReason: 'stop',
            created: 0,
          },
        });
  if (result.blocked) return { blocked: result.blocked.message };
  if (result.redactions === 0) return { body, redactions: 0 };
  // The engine rewrote the parts in place; copy them back into the document.
  leaves.forEach((leaf, i) => {
    const part = parts[i];
    if (part) leafSet(leaf, part.text);
  });
  return { body: Buffer.from(JSON.stringify(json)), redactions: result.redactions };
}

// ───────────── route ─────────────

function sendError(reply: FastifyReply, error: DiRouterError, requestId: string) {
  if (error instanceof RateLimitError && error.retryAfterMs !== undefined)
    void reply.header('retry-after', String(Math.ceil(error.retryAfterMs / 1000)));
  return reply.status(error.status).send(errorPayload('openai.chat', error, requestId));
}

/** A weighted pick among the provider's enabled credentials that health has not taken out. */
function pickCredential(provider: ProviderConfig, deps: ProxyDeps) {
  const health = deps.store.healthRegistry;
  const usable = provider.credentials.filter(
    (c) => c.enabled && c.weight > 0 && health.credentialDisabledReason(c.id) === undefined,
  );
  const total = usable.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * total;
  for (const credential of usable) {
    roll -= credential.weight;
    if (roll < 0) return credential;
  }
  return usable[0];
}

function matchModel(
  models: readonly ModelConfig[],
  provider: ProviderConfig,
  name: string | undefined,
): ModelConfig | undefined {
  if (!name) return undefined;
  const bare = name.replace(/^models\//, '');
  return models.find(
    (m) => m.providerId === provider.id && (m.upstreamModel === bare || m.slug === bare),
  );
}

export async function handlePassthrough(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<unknown> {
  const requestId = req.id;
  const started = Date.now();
  const config = deps.store.current;
  if (!config)
    return sendError(
      reply,
      new DiRouterError('service_unavailable', { message: 'Gateway has no configuration yet' }),
      requestId,
    );

  // The raw URL, so the path reaches the provider exactly as the client encoded it.
  const rawUrl = req.raw.url ?? '';
  const queryAt = rawUrl.indexOf('?');
  const pathname = queryAt >= 0 ? rawUrl.slice(0, queryAt) : rawUrl;
  const query = queryAt >= 0 ? rawUrl.slice(queryAt + 1) : '';
  const rest = pathname.slice(PASSTHROUGH_PREFIX.length);
  const slash = rest.indexOf('/');
  const slug = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash) : '/';
  const method = req.method.toUpperCase();

  let key: VirtualKeyConfig;
  try {
    key = authenticate(
      config,
      extractApiKey(req.headers, new URLSearchParams(query).get('key') ?? undefined),
      deps.pepper,
      req.ip,
    );
  } catch (error) {
    return sendError(
      reply,
      error instanceof DiRouterError ? error : new DiRouterError('unauthenticated'),
      requestId,
    );
  }
  if (!keyMayPassthrough(key, slug))
    return sendError(
      reply,
      new ForbiddenError('forbidden', {
        message: `This key may not use pass-through to '${slug}'`,
      }),
      requestId,
    );
  const provider = config.snapshot.providers.find(
    (p) => p.organizationId === key.organizationId && p.slug === slug && p.enabled,
  );
  if (!provider)
    return sendError(
      reply,
      new NotFoundError('not_found', { message: `Provider '${slug}' not found` }),
      requestId,
    );
  if (UNSUPPORTED.includes(provider.type))
    return sendError(
      reply,
      new DiRouterError('invalid_request', {
        message: `Pass-through is not available for ${provider.type} providers`,
      }),
      requestId,
    );
  if (!(METHODS as readonly string[]).includes(method))
    return sendError(
      reply,
      new DiRouterError('invalid_request', {
        message: `Method ${method} is not supported`,
        status: 405,
      }),
      requestId,
    );
  if (!safePath(path))
    return sendError(
      reply,
      new DiRouterError('invalid_request', { message: 'Invalid pass-through path' }),
      requestId,
    );
  if (!pathAllowed(passthroughPaths(provider), method, path))
    return sendError(
      reply,
      new ForbiddenError('forbidden', {
        message: `${method} ${path} is not in the pass-through allow-list of '${slug}'`,
      }),
      requestId,
    );
  if (key.walletId)
    return sendError(
      reply,
      new ForbiddenError('forbidden', {
        message: 'Pass-through is not available to prepaid keys: its cost cannot be reserved',
      }),
      requestId,
    );
  const url = upstreamUrl(provider.baseUrl, path, query);
  if (!url)
    return sendError(
      reply,
      new DiRouterError('invalid_request', { message: 'Invalid pass-through path' }),
      requestId,
    );

  let body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
  const contentType = req.headers['content-type'] ?? '';
  const isJson = contentType.includes('json');
  let requested: Record<string, unknown> | undefined;
  if (body && isJson)
    try {
      requested = record(JSON.parse(body.toString('utf8')));
    } catch {
      requested = undefined;
    }

  // Guardrails (card 15.1) on the string values of a JSON body; a blocked request never leaves.
  const policies = policiesFor(config.snapshot.guardrails, key);
  if (body && isJson && policies.length > 0) {
    const guard = guardJson(policies, 'request', body);
    if ('blocked' in guard) {
      deps.metrics?.reject('guardrail', 'passthrough');
      return sendError(
        reply,
        new DiRouterError('invalid_request', { message: guard.blocked, status: 400 }),
        requestId,
      );
    }
    body = guard.body;
  }

  const requestedModel =
    typeof requested?.model === 'string' && requested.model.length <= 200
      ? requested.model
      : `${slug}${path}`.slice(0, 200);
  const stream =
    requested?.stream === true || (req.headers.accept ?? '').includes('text/event-stream');

  // Rate limits (RPM, and TPM on a rough estimate of the body) and budgets, as for chat.
  const estimate = Math.ceil((body?.length ?? 0) / 4);
  const admission = deps.limiter
    ? await deps.limiter.acquire(limitScopes(config, key), estimate, requestId)
    : undefined;
  if (admission && !admission.ok) {
    deps.metrics?.reject('rate_limit', admission.unavailable ? 'unavailable' : admission.kind);
    for (const [name, value] of Object.entries(admission.headers)) void reply.header(name, value);
    return sendError(
      reply,
      new RateLimitError({
        message: admission.unavailable
          ? 'Rate limiter unavailable (fail-closed), retry shortly'
          : `Rate limit exceeded for ${admission.scope.split(':')[0] ?? 'key'} (${admission.kind})`,
        retryAfterMs: admission.retryAfterMs,
      }),
      requestId,
    );
  }
  const budgets = budgetScopes(config, key);
  const budgetCheck = deps.budgets ? await deps.budgets.check(budgets) : { ok: true as const };
  if (!budgetCheck.ok) {
    admission?.settle(0);
    admission?.release();
    deps.metrics?.reject('budget', budgetCheck.unavailable ? 'unavailable' : budgetCheck.kind);
    void reply.header(
      'retry-after',
      String(Math.max(1, Math.ceil((budgetCheck.resetAt.getTime() - Date.now()) / 1000))),
    );
    return sendError(
      reply,
      new DiRouterError('budget_exceeded', {
        message: budgetCheck.unavailable
          ? 'Budget check unavailable (fail-closed), retry shortly'
          : `${budgetCheck.period === 'daily' ? 'Daily' : 'Monthly'} ${budgetCheck.scope} budget exceeded`,
      }),
      requestId,
    );
  }

  const clientGone = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) clientGone.abort(new Error('client disconnected'));
  });
  const onShutdown = () => {
    clientGone.abort(new Error('gateway shutting down'));
  };
  deps.lifecycle?.signal.addEventListener('abort', onShutdown, { once: true });
  const keyBulkhead = deps.bulkheads?.get(`key:${key.id}`, key.rateLimit?.maxConcurrency, {});
  const releaseKey = keyBulkhead ? await keyBulkhead.acquire(clientGone.signal) : () => undefined;

  let settled = false;
  const finish = (outcome: {
    status: number;
    ok: boolean;
    errorCode?: string;
    credentialId: string | null;
    found?: Found;
  }) => {
    if (settled) return;
    settled = true;
    const found = outcome.found ?? { usage: {} };
    const usage: CanonicalUsage = {
      inputTokens: found.usage.inputTokens ?? 0,
      outputTokens: found.usage.outputTokens ?? 0,
      cacheReadTokens: found.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: found.usage.cacheWriteTokens ?? 0,
      reasoningTokens: found.usage.reasoningTokens ?? 0,
    };
    const model = matchModel(
      config.snapshot.models,
      provider,
      found.model ?? (typeof requested?.model === 'string' ? requested.model : undefined),
    );
    const costUsd = model ? computeCostUsd(usage, model.pricing) : '0';
    const charged = model
      ? chargeUsd(usage, model, { groupMultiplier: key.priceMultiplier })
      : '0.00000000';
    const tokens = usage.inputTokens + usage.outputTokens;
    const event: UsageEvent = {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: ulid(),
      idempotencyKey: requestId,
      requestId,
      occurredAt: new Date(started).toISOString(),
      gatewayInstance: deps.instance,
      configVersion: config.version,
      organizationId: key.organizationId,
      teamId: key.teamId,
      projectId: key.projectId,
      virtualKeyId: key.id,
      inboundApi: 'passthrough',
      requestedModel,
      resolvedModelId: model?.id ?? null,
      providerId: provider.id,
      credentialId: outcome.credentialId,
      stream,
      status: outcome.ok ? 'success' : 'error',
      httpStatus: outcome.status,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      usage,
      costUsd,
      chargeUsd: charged,
      usageEstimated: false,
      latencyMs: Date.now() - started,
      attempts: outcome.credentialId
        ? [
            {
              providerId: provider.id,
              modelId: model?.id ?? '',
              credentialId: outcome.credentialId,
              outcome: outcome.ok ? 'success' : 'error',
              httpStatus: outcome.status,
              ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
              latencyMs: Date.now() - started,
              startedAt: new Date(started).toISOString(),
            },
          ]
        : [],
    };
    // Metrics label by model; a path (with file or batch ids) would explode their cardinality.
    deps.metrics?.observe(model ? event : { ...event, requestedModel: `passthrough:${slug}` });
    deps.onRequestComplete?.(event);
    deps.emitUsage(event);
    deps.lifecycle?.signal.removeEventListener('abort', onShutdown);
    releaseKey?.();
    admission?.settle(tokens);
    admission?.release();
    deps.budgets?.record(budgets, costUsd, tokens);
    deps.logger.info(
      { requestId, provider: provider.slug, method, path, status: outcome.status },
      'passthrough request',
    );
  };

  if (!releaseKey) {
    deps.lifecycle?.signal.removeEventListener('abort', onShutdown);
    admission?.settle(0);
    admission?.release();
    deps.metrics?.reject('concurrency', 'key');
    return sendError(
      reply,
      new RateLimitError({
        message: `Too many concurrent requests for this key (limit ${String(keyBulkhead?.limit)})`,
        retryAfterMs: 1_000,
      }),
      requestId,
    );
  }

  const credential = pickCredential(provider, deps);
  if (!credential) {
    finish({ status: 503, ok: false, errorCode: 'no_credential', credentialId: null });
    return sendError(
      reply,
      new DiRouterError('service_unavailable', {
        message: `Provider '${slug}' has no usable credential`,
      }),
      requestId,
    );
  }
  const settings = config.snapshot.settings;
  const proxyUrl = credential.proxy?.url ?? provider.proxy?.url ?? settings.proxy?.url;
  let apiKey: string;
  try {
    apiKey = await resolveCredentialKey(
      provider,
      credential,
      config.secret(credential.id, credential.secret),
      { signal: clientGone.signal, proxyUrl },
    );
  } catch (error) {
    deps.logger.warn(
      { requestId, provider: provider.slug, error: (error as Error).message },
      'passthrough credential unusable',
    );
    finish({ status: 502, ok: false, errorCode: 'auth', credentialId: credential.id });
    return sendError(
      reply,
      new DiRouterError('upstream_error', { message: 'Provider credential is not usable' }),
      requestId,
    );
  }

  // The credential's authentication, exactly as the adapter sends it for model discovery.
  const auth = adapterForProvider(provider).listModelsRequest(provider, apiKey).headers;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(auth))
    if (name.toLowerCase() !== 'content-type' && name.toLowerCase() !== 'accept')
      headers[name.toLowerCase()] = value;
  for (const [name, value] of Object.entries(credential.headers))
    headers[name.toLowerCase()] = value;
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  if (body && !headers['content-type']) headers['content-type'] = 'application/octet-stream';

  const upstream: UpstreamRequest = {
    url,
    // UpstreamRequest names the methods adapters use; fetch accepts every method checked above.
    method: method as UpstreamRequest['method'],
    headers,
    ...(body && method !== 'GET' ? { bytes: new Uint8Array(body) } : {}),
  };
  const timeouts = mergeTimeouts(settings.defaultTimeouts, provider.timeouts);
  let call;
  try {
    call = await callUpstream(provider, upstream, timeouts, clientGone.signal, stream, proxyUrl);
  } catch (error) {
    const classified = classifyNetworkError(error, error instanceof UpstreamTimeout);
    deps.logger.warn(
      { requestId, provider: provider.slug, error: classified.message },
      'passthrough upstream failed',
    );
    const timeout = classified.class === 'timeout';
    finish({
      status: timeout ? 504 : 502,
      ok: false,
      errorCode: classified.class,
      credentialId: credential.id,
    });
    return sendError(
      reply,
      new DiRouterError(timeout ? 'upstream_timeout' : 'upstream_error', {
        message: timeout ? 'Upstream request timed out' : 'Could not reach the upstream provider',
      }),
      requestId,
    );
  }

  const status = call.response.status;
  const ok = status < 400;
  const answerType = call.response.headers.get('content-type') ?? '';
  for (const [name, value] of call.response.headers)
    if (FORWARDED_RESPONSE_HEADERS.test(name)) void reply.header(name, value);
  void reply.header('x-dirouter-provider', provider.slug);
  void reply.status(status);

  const responsePolicies = policies.filter(
    (p) => p.enabled && (p.stage === 'response' || p.stage === 'both'),
  );
  // A JSON answer is held for response guardrails; streams and binary bodies flow through.
  if (responsePolicies.length > 0 && answerType.includes('json') && ok) {
    let text: Buffer;
    try {
      const bytes = Buffer.from(await call.response.arrayBuffer());
      if (bytes.length > MAX_GUARDED_ANSWER) throw new Error('answer too large for guardrails');
      text = bytes;
    } catch (error) {
      call.done();
      finish({ status: 502, ok: false, errorCode: 'server', credentialId: credential.id });
      deps.logger.warn({ requestId, error: (error as Error).message }, 'passthrough answer lost');
      return sendError(
        reply,
        new DiRouterError('upstream_error', { message: 'Upstream answer could not be checked' }),
        requestId,
      );
    }
    call.done();
    const found = usageFromAnswer(answerType, text.subarray(0, MAX_CAPTURE).toString('utf8'));
    const guard = guardJson(policies, 'response', text);
    if ('blocked' in guard) {
      finish({
        status: 400,
        ok: false,
        errorCode: 'guardrail',
        credentialId: credential.id,
        found,
      });
      return sendError(
        reply,
        new DiRouterError('invalid_request', { message: guard.blocked, status: 400 }),
        requestId,
      );
    }
    finish({ status, ok, credentialId: credential.id, found });
    return reply.send(guard.body ?? text);
  }

  const upstreamBody = call.response.body;
  if (!upstreamBody) {
    call.done();
    finish({
      status,
      ok,
      ...(ok ? {} : { errorCode: `http_${String(status)}` }),
      credentialId: credential.id,
    });
    return reply.send();
  }
  const captured: Buffer[] = [];
  let capturedBytes = 0;
  const source = Readable.fromWeb(upstreamBody);
  source.on('data', (chunk: Buffer) => {
    call.touch();
    if (capturedBytes < MAX_CAPTURE) {
      captured.push(chunk.subarray(0, MAX_CAPTURE - capturedBytes));
      capturedBytes += Math.min(chunk.length, MAX_CAPTURE - capturedBytes);
    }
  });
  const done = (failed?: Error) => {
    call.done();
    const found = usageFromAnswer(answerType, Buffer.concat(captured).toString('utf8'));
    finish({
      status: failed ? 502 : status,
      ok: ok && !failed,
      ...(failed
        ? { errorCode: failed instanceof UpstreamTimeout ? 'timeout' : 'connection' }
        : ok
          ? {}
          : { errorCode: `http_${String(status)}` }),
      credentialId: credential.id,
      found,
    });
  };
  source.once('end', () => {
    done();
  });
  source.once('error', (error) => {
    done(error);
  });
  return reply.send(source);
}

/**
 * Registers `/passthrough/{provider}/*` in its own scope, whose body parser keeps every content
 * type as raw bytes, so the provider receives the body exactly as the client sent it.
 */
export function registerPassthroughRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  void app.register((scope, _opts, next) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_BODY },
      (_req, payload, done) => {
        done(null, payload);
      },
    );
    scope.route({
      method: [...METHODS],
      url: '/passthrough/:provider/*',
      handler: (req, reply) => handlePassthrough(req, reply, deps),
    });
    next();
  });
}
