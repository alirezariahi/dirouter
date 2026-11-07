/**
 * UsageEvent: رویداد مصرف که گیت‌وی بعد از هر درخواست منتشر می‌کند (outbox → BullMQ
 * → worker → Postgres). مسیر درخواست هرگز منتظر نوشتن این رویداد نمی‌ماند.
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

/** یک تلاش در زنجیرهٔ retry/فال‌بک. */
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
  /** کلید یکتا برای جلوگیری از دوبار شمردن هزینه (معمولاً همان requestId). */
  idempotencyKey: z.string().min(1),
  requestId: z.string().min(1),
  occurredAt: IsoDateTime,
  gatewayInstance: z.string(),
  /** نسخهٔ snapshot؛ ۰ یعنی هنوز snapshot بارگذاری نشده بود. */
  configVersion: z.int().nonnegative(),

  organizationId: z.string(),
  teamId: z.string().nullable(),
  projectId: z.string(),
  virtualKeyId: z.string(),
  endUser: z.string().optional(),

  inboundApi: InboundApi,
  requestedModel: z.string(),
  /** مدل، provider و credential تلاشِ نهایی (موفق یا آخرین ناموفق). */
  resolvedModelId: z.string().nullable(),
  providerId: z.string().nullable(),
  credentialId: z.string().nullable(),

  stream: z.boolean(),
  status: z.enum(['success', 'error']),
  httpStatus: z.int(),
  errorCode: z.string().optional(),

  usage: CanonicalUsage,
  /** هزینه به دلار (رشتهٔ اعشاری، ۸ رقم). */
  costUsd: UsdAmount,
  /** true وقتی توکن‌ها تخمینی‌اند (provider usage برنگردانده). */
  usageEstimated: z.boolean().default(false),

  latencyMs: NonNegativeInt,
  ttftMs: NonNegativeInt.optional(),
  attempts: z.array(UsageAttempt),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

/** نام صف‌های BullMQ بین گیت‌وی و worker (کارت‌های ۶.۴ و ۶.۵). */
export const QUEUES = {
  /** رویدادهای مصرف؛ jobId همان idempotencyKey است. */
  usage: 'usage',
  /** jobهای مصرفی که بعد از همهٔ تلاش‌ها شکست خوردند. */
  usageDead: 'usage-dead',
  /** کارهای زمان‌بندی‌شده: rollup، پارتیشن، retention، reconcile. */
  maintenance: 'maintenance',
} as const;
