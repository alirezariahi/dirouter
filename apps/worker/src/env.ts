import { baseEnvSchema, envPort } from '@dirouter/shared';
import { z } from 'zod';

export const workerEnvSchema = baseEnvSchema.extend({
  PORT: envPort(3100),
  DATABASE_URL: z.string().min(1),
  VALKEY_URL: z.string().min(1),
  /** نگهداری لاگ خام request_log به ماه؛ جداول تجمیعی و ledger حذف نمی‌شوند. */
  REQUEST_LOG_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(3),
  USAGE_CONCURRENCY: z.coerce.number().int().min(1).max(2000).default(200),
  USAGE_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  USAGE_FLUSH_MS: z.coerce.number().int().min(10).max(10_000).default(200),
  ROLLUP_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(10),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
