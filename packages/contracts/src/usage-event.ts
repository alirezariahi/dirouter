/**
 * UsageEvent: usage event the gateway publishes after each request (outbox → BullMQ
 * → worker → Postgres). The request path never waits for this event to be written.
 */
import { z } from 'zod';

import { CanonicalUsage, InboundApi } from './canonical.js';
import { IsoDateTime, NonNegativeInt, Ulid, UsdAmount } from './common.js';

export const USAGE_EVENT_SCHEMA_VERSION = 1 as const;

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

  inboundApi: InboundApi,
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
  /** true when tokens are estimated (the provider did not return usage). */
  usageEstimated: z.boolean().default(false),

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
