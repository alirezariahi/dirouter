/**
 * What the long-running endpoints (files, batches, async tasks) share: their dependencies, key
 * authentication, OpenAI-shaped errors and upstream calls for a stored provider and credential.
 */
import type { CredentialConfig, ProviderConfig, VirtualKeyConfig } from '@dirouter/contracts';
import {
  adapterForProvider,
  classifyHttpError,
  type ClassifiedError,
  type UpstreamRequest,
} from '@dirouter/providers';
import { DiRouterError, type Keyring, RateLimitError } from '@dirouter/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { authenticate, extractApiKey } from '../auth.js';
import type { LoadedConfig } from '../config-store.js';
import { resolveCredentialKey } from '../credential-tokens.js';
import type { ProxyDeps } from '../proxy.js';
import { callUpstream, mergeTimeouts } from '../upstream.js';
import type { BlobStorage } from './blobs.js';
import type { JobStore } from './store.js';

export interface JobsOptions {
  /** Largest upload accepted by `/v1/files`. */
  maxFileBytes: number;
  /** How long uploaded and generated files are kept unless the upload asks for less. */
  fileRetentionSeconds: number;
  /** Delay between two upstream status checks of a running batch or task. */
  pollIntervalMs: number;
  /** Delays between webhook attempts (card 30.6). */
  webhookRetryDelaysMs: readonly number[];
}

export const DEFAULT_JOBS_OPTIONS: JobsOptions = {
  maxFileBytes: 100 * 1024 * 1024,
  fileRetentionSeconds: 30 * 86_400,
  pollIntervalMs: 15_000,
  webhookRetryDelaysMs: [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000],
};

export interface JobsDeps extends ProxyDeps {
  jobs: JobStore;
  blobs: BlobStorage;
  jobOptions: JobsOptions;
  keyring: Keyring;
}

/**
 * Sends a client error. Anything that is not a DiRouterError is unexpected: its message may name
 * internal addresses, paths or upstream details, so the client gets a generic message and the
 * detail only goes to the server log.
 */
export function sendError(
  reply: FastifyReply,
  error: unknown,
  headers: Record<string, string> = {},
): FastifyReply {
  let e: DiRouterError;
  if (error instanceof DiRouterError) e = error;
  else {
    reply.log.error({ err: error }, 'unexpected error in a job endpoint');
    e = new DiRouterError('internal_error', { message: 'Internal error, retry shortly' });
  }
  if (e instanceof RateLimitError && e.retryAfterMs !== undefined && !headers['retry-after'])
    void reply.header('retry-after', String(Math.ceil(e.retryAfterMs / 1000)));
  for (const [name, value] of Object.entries(headers)) void reply.header(name, value);
  return reply.status(e.status).send(e.toOpenAI());
}

export const invalid = (message: string, param?: string) =>
  new DiRouterError('invalid_request', { message, status: 400, ...(param ? { param } : {}) });

/** 404 for missing ids and for ids of another organization alike, so ids cannot be probed. */
export const notFound = (what: string, id: string) =>
  new DiRouterError('not_found', { message: `No ${what} found with id '${id}'.`, status: 404 });

export function authed(
  req: FastifyRequest,
  deps: Pick<ProxyDeps, 'store' | 'pepper'>,
): { config: LoadedConfig; key: VirtualKeyConfig } {
  const config = deps.store.current;
  if (!config)
    throw new DiRouterError('service_unavailable', { message: 'Gateway has no configuration yet' });
  const key = authenticate(
    config,
    extractApiKey(req.headers, (req.query as { key?: string } | undefined)?.key),
    deps.pepper,
    req.ip,
  );
  return { config, key };
}

export interface UpstreamTarget {
  provider: ProviderConfig;
  credential: CredentialConfig;
  apiKey: string;
  proxyUrl: string | undefined;
}

/** The provider and credential a job was started on, from the current snapshot. */
export async function targetFor(
  config: LoadedConfig,
  providerId: string,
  credentialId: string,
  signal?: AbortSignal,
): Promise<UpstreamTarget> {
  const provider = config.snapshot.providers.find((p) => p.id === providerId);
  const credential = provider?.credentials.find((c) => c.id === credentialId);
  if (!provider || !credential)
    throw new DiRouterError('upstream_error', {
      message: 'The provider this job runs on is no longer configured',
    });
  const proxyUrl =
    credential.proxy?.url ?? provider.proxy?.url ?? config.snapshot.settings.proxy?.url;
  const apiKey = await resolveCredentialKey(
    provider,
    credential,
    config.secret(credential.id, credential.secret),
    { signal: signal ?? AbortSignal.timeout(30_000), proxyUrl },
  );
  return { provider, credential, apiKey, proxyUrl };
}

export interface UpstreamReply {
  status: number;
  headers: Headers;
  body: Buffer;
}

/**
 * One upstream call of a job step (upload, create, status, results, cancel), with the provider's
 * proxy, the SSRF guard and the snapshot's timeouts. The whole body is read.
 */
export async function sendUpstream(
  config: LoadedConfig,
  target: Pick<UpstreamTarget, 'provider' | 'proxyUrl'>,
  up: UpstreamRequest,
  signal: AbortSignal = AbortSignal.timeout(300_000),
): Promise<UpstreamReply> {
  const timeouts = mergeTimeouts(
    config.snapshot.settings.defaultTimeouts,
    target.provider.timeouts,
  );
  const call = await callUpstream(target.provider, up, timeouts, signal, false, target.proxyUrl);
  try {
    const body = Buffer.from(await call.response.arrayBuffer());
    return { status: call.response.status, headers: call.response.headers, body };
  } finally {
    call.done();
  }
}

/** Longest provider message excerpt a client is shown. */
const MAX_UPSTREAM_DETAIL = 200;
/**
 * Key-shaped tokens and account ids a provider may echo in an error (`Incorrect API key provided:
 * sk-abc***xyz`, `organization org-...`): never shown to the client.
 */
const SECRET_LIKE =
  /\b(?:sk|rk|pk|org|proj|acct|sess)[-_][\w*.-]{4,}|[\w-]*\*{3,}[\w-]*|\b[A-Za-z0-9_-]{32,}\b/gi;

/** A provider's error text as a client may see it: no key-shaped tokens or ids, one short line. */
export function clientSafeDetail(message: string): string {
  const clean = message.replace(SECRET_LIKE, '[redacted]').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_UPSTREAM_DETAIL ? `${clean.slice(0, MAX_UPSTREAM_DETAIL)}…` : clean;
}

/**
 * Upstream failure as a client error. The provider's message is read by its adapter's classifier,
 * as the main proxy does: a credential the provider refused or an unknown object gets a generic
 * message (the provider's text there names keys and accounts); otherwise a short excerpt of the
 * provider's message without key-shaped tokens or account ids.
 */
export function upstreamFailure(
  what: string,
  reply: UpstreamReply,
  provider?: ProviderConfig,
): DiRouterError {
  const input = {
    status: reply.status,
    headers: reply.headers,
    body: reply.body.toString('utf8').slice(0, 16_384),
  };
  let classified: ClassifiedError;
  try {
    classified = provider
      ? adapterForProvider(provider).classifyError(input)
      : classifyHttpError(input);
  } catch {
    classified = classifyHttpError(input);
  }
  const generic: Partial<Record<ClassifiedError['class'], string>> = {
    auth: 'the provider refused the configured credential',
    not_found: 'the provider does not know the requested object',
    timeout: 'the provider timed out',
    connection: 'the provider could not be reached',
  };
  const detail = generic[classified.class] ?? clientSafeDetail(classified.message);
  const status = reply.status === 429 ? 429 : reply.status >= 500 ? 502 : 400;
  return new DiRouterError(status === 429 ? 'rate_limited' : 'upstream_error', {
    message: `${what} failed at the provider (${String(reply.status)}): ${detail}`,
    status,
  });
}

export const json = (reply: UpstreamReply): unknown => JSON.parse(reply.body.toString('utf8'));

export const nowSeconds = (ms = Date.now()) => Math.floor(ms / 1000);
