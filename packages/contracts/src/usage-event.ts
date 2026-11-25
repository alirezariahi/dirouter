/**
 * UsageEvent: usage event the gateway publishes after each request (outbox → BullMQ
 * → worker → Postgres). The request path never waits for this event to be written.
 */
import { z } from 'zod';

import { CanonicalUsage, InboundApi, MediaUsage } from './canonical.js';
import { IsoDateTime, NonNegativeInt, Ulid, UsdAmount } from './common.js';
import { PolicyTrace } from './routing-policy.js';
import { DataPolicy } from './routing-policy.js';

export const USAGE_EVENT_SCHEMA_VERSION = 1 as const;

/**
 * Inbound APIs that produce usage events (card 11.x adds Responses, Gemini and embeddings), plus
 * native provider pass-through (card 30.7) and web search and fetch (card 30.8), which have no
 * canonical request.
 */
export const UsageInboundApi = z.enum([
  ...InboundApi.options,
  'passthrough',
  'web.search',
  'web.fetch',
]);
export type UsageInboundApi = z.infer<typeof UsageInboundApi>;

export const AttemptOutcome = z.enum([
  'success',
  'error',
  'timeout',
  'circuit_open',
  'rate_limited',
  'cancelled',
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

/** One attempt in the retry/fallback chain. */
export const UsageAttempt = z.object({
  providerId: z.string(),
  modelId: z.string(),
  credentialId: z.string(),
  outcome: AttemptOutcome,
  httpStatus: z.int().optional(),
  errorCode: z.string().optional(),
  latencyMs: NonNegativeInt,
  startedAt: IsoDateTime,
});
export type UsageAttempt = z.infer<typeof UsageAttempt>;

/** Routing decision of one request, as stored with its log entry (cards 32.5 and 32.7). */
export const RouteDecision = z.object({
  /** The effective data policy the candidates had to meet (card 32.5). */
  dataPolicy: DataPolicy.optional(),
  /** Targets removed while planning, with the reason. */
  skipped: z
    .array(
      z.object({
        modelId: z.string(),
        credentialId: z.string().optional(),
        reason: z.string(),
      }),
    )
    .max(100)
    .optional(),
  /** Model suffixes the client used, e.g. `floor` or `online` (card 31.5). */
  suffixes: z.array(z.string()).max(10).optional(),
  /** Card 32.7: the model names the candidates came from (requested, then `models` fallbacks). */
  models: z.array(z.string()).max(10).optional(),
  /** The provider preferences applied (card 32.1). */
  preferences: z.record(z.string(), z.unknown()).optional(),
  /** The routing rule that chose the target, when a rules stage matched one. */
  rule: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  /** Candidates in attempt order with the estimated price of this request on each. */
  candidates: z
    .array(
      z.object({
        modelId: z.string(),
        providerId: z.string(),
        credentialId: z.string(),
        estimatedCostUsd: z.string(),
      }),
    )
    .max(50)
    .optional(),
  /** Estimated price on the first candidate (input estimate + output cap). */
  estimatedCostUsd: z.string().optional(),
});
export type RouteDecision = z.infer<typeof RouteDecision>;

export const UsageEvent = z.object({
  schemaVersion: z.literal(USAGE_EVENT_SCHEMA_VERSION),
  eventId: Ulid,
  /** Unique key to prevent counting cost twice (usually the same as requestId). */
  idempotencyKey: z.string().min(1),
  requestId: z.string().min(1),
  occurredAt: IsoDateTime,
  gatewayInstance: z.string(),
  /** Snapshot version; 0 means no snapshot had been loaded yet. */
  configVersion: z.int().nonnegative(),

  organizationId: z.string(),
  teamId: z.string().nullable(),
  projectId: z.string(),
  virtualKeyId: z.string(),
  endUser: z.string().optional(),

  inboundApi: UsageInboundApi,
  requestedModel: z.string(),
  /** Model, provider, and credential of the final attempt (successful or last failed). */
  resolvedModelId: z.string().nullable(),
  providerId: z.string().nullable(),
  credentialId: z.string().nullable(),

  stream: z.boolean(),
  status: z.enum(['success', 'error']),
  httpStatus: z.int(),
  errorCode: z.string().optional(),

  usage: CanonicalUsage,
  /** Cost in dollars (decimal string, 8 digits). */
  costUsd: UsdAmount,
  /** Prepaid wallet charged for this request (card 19.1); absent for postpaid organizations. */
  walletId: z.string().optional(),
  /** What the customer pays (sale price, card 19.4); defaults to costUsd when absent. */
  chargeUsd: UsdAmount.optional(),
  /** true when tokens are estimated (the provider did not return usage). */
  usageEstimated: z.boolean().default(false),
  /** Served from the exact or semantic response cache (cards 13.1 and 13.2). */
  cacheHit: z.boolean().optional(),
  cacheKind: z.enum(['exact', 'semantic']).optional(),
  /** Estimated input tokens removed by context compression (card 13.3). */
  savedInputTokens: NonNegativeInt.optional(),
  /** How an `auto*` alias was resolved (card 20.4): the decision and the reasons for it. */
  routing: z
    .object({
      alias: z.string(),
      target: z.string(),
      taskType: z.string().optional(),
      source: z.enum(['rules', 'model', 'fixed']),
      reasons: z.array(z.string()),
      classifierMicros: NonNegativeInt.optional(),
    })
    .optional(),
  /** What the organization's routing policies did to the request (sprint 5, cards 32.x). */
  policy: PolicyTrace.optional(),
  /** Service tier the request was priced at (card 31.5): `flex` or `priority`. */
  serviceTier: z.string().max(20).optional(),
  /** How the route was planned (cards 32.5 and 32.7), shown in the request log details. */
  routeDecision: RouteDecision.optional(),
  /** Images, characters or audio seconds of a media request (card 21.1). */
  media: MediaUsage.optional(),
  /** Additional upstream attempts started by request hedging (card 12.2). */
  hedgeAttempts: NonNegativeInt.optional(),

  latencyMs: NonNegativeInt,
  ttftMs: NonNegativeInt.optional(),
  attempts: z.array(UsageAttempt),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

/** BullMQ queue names between the gateway and the worker (cards 6.4 and 6.5). */
export const QUEUES = {
  /** Usage events; jobId is the same as idempotencyKey. */
  usage: 'usage',
  /** Usage jobs that failed after all attempts. */
  usageDead: 'usage-dead',
  /** Scheduled jobs: rollup, partition, retention, reconcile. */
  maintenance: 'maintenance',
} as const;
