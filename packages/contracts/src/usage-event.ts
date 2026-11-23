/**
 * UsageEvent: usage event the gateway publishes after each request (outbox → BullMQ
 * → worker → Postgres). The request path never waits for this event to be written.
 */
import { z } from 'zod';

import { CanonicalUsage, InboundApi, MediaUsage } from './canonical.js';
import { IsoDateTime, NonNegativeInt, Ulid, UsdAmount } from './common.js';

export const USAGE_EVENT_SCHEMA_VERSION = 1 as const;

/** Inbound APIs that produce usage events (card 11.x adds Responses, Gemini and embeddings). */
export const UsageInboundApi = InboundApi;
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
