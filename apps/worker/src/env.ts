import { baseEnvSchema, envPort } from '@dirouter/shared';
import { z } from 'zod';

export const workerEnvSchema = baseEnvSchema.extend({
  PORT: envPort(3100),
  DATABASE_URL: z.string().min(1),
  VALKEY_URL: z.string().min(1),
  /** Raw request_log retention in months; aggregate tables and the ledger are not deleted. */
  REQUEST_LOG_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(3),
  USAGE_CONCURRENCY: z.coerce.number().int().min(1).max(2000).default(200),
  USAGE_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  USAGE_FLUSH_MS: z.coerce.number().int().min(10).max(10_000).default(200),
  ROLLUP_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  /** How often alert rules are evaluated (card 16.2). */
  ALERT_EVALUATE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  /** Days of provider probe history kept in provider_health_samples (card 12.3). */
  HEALTH_SAMPLE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Days the MCP tool-call log is kept (card 20.1). */
  MCP_CALL_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(10),
  /** SMTP for `email` alert channels (card 24.2); empty means email channels need an HTTP relay. */
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('DiRouter <noreply@localhost>'),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
