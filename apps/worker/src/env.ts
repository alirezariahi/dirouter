import { DEFAULT_CATALOG_SOURCE } from '@dirouter/model-catalog/sync';
import { baseEnvSchema, envBoolean, envPort } from '@dirouter/shared';
import { z } from 'zod';

/** Comma-separated http(s) URLs, at most five. */
const envUrlList = (defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((value) =>
      value
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).max(5));

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
  /**
   * Days captured request bodies are kept (card 24.1); independent of REQUEST_LOG_RETENTION_MONTHS.
   */
  REQUEST_BODY_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** Days the MCP tool-call log is kept (card 20.1). */
  MCP_CALL_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(10),
  /** SMTP for `email` alert channels (card 24.2); empty means email channels need an HTTP relay. */
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('DiRouter <noreply@localhost>'),
  /** Catalog and price sync from external sources (card 27.5); admin settings override these. */
  CATALOG_SYNC_ENABLED: envBoolean(true),
  /** Comma-separated source URLs: LiteLLM's public list by default, or an internal mirror. */
  CATALOG_SYNC_SOURCES: envUrlList(DEFAULT_CATALOG_SOURCE),
  /** `manual`: price changes wait for an admin; `auto`: applied unless larger than the factor. */
  CATALOG_SYNC_MODE: z.enum(['manual', 'auto']).default('manual'),
  CATALOG_SYNC_INTERVAL_MS: z.coerce.number().int().min(60_000).default(21_600_000),
  CATALOG_SYNC_MAX_CHANGE_FACTOR: z.coerce.number().min(1).max(1000).default(3),
  CATALOG_SYNC_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
