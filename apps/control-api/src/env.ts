import { baseEnvSchema, envKeyring, envPort } from '@dirouter/shared';
import { z } from 'zod';

export const envSchema = baseEnvSchema.extend({
  PORT: envPort(3000),
  DATABASE_URL: z.string().min(1),
  VALKEY_URL: z.string().min(1),
  MASTER_KEY: envKeyring(),
  KEY_PEPPER: z.string().min(32),
  JWT_SECRET: z.string().min(32),
  INTERNAL_TOKEN: z.string().min(32),
  DASHBOARD_ORIGIN: z.string().default('https://app.localhost'),
  PUBLIC_DASHBOARD_URL: z.string().default('https://app.localhost'),
  /** Gateway for testing the connection and discovering provider models (card 3.6). */
  GATEWAY_INTERNAL_URL: z.string().default('http://gateway:8080'),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('DiRouter <noreply@localhost>'),
  /** OpenAI-compatible embeddings endpoint used by the pgvector semantic cache (card 13.2). */
  // Compose passes unset variables as empty strings; empty means "not configured".
  SEMANTIC_CACHE_EMBEDDING_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url().optional(),
  ),
  SEMANTIC_CACHE_EMBEDDING_KEY: z.string().optional(),
  SEMANTIC_CACHE_EMBEDDING_MODEL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().default('text-embedding-3-small'),
  ),
});

export type Env = z.infer<typeof envSchema>;

/** DI token for the validated env. */
export const ENV = Symbol('ENV');
