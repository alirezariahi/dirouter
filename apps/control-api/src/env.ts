import { baseEnvSchema, envKeyring, envPort } from '@dirouter/shared';
import { z } from 'zod';

// Compose passes unset variables as empty strings; empty means "not configured".
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);

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
  /** Public origin of this API, used in payment callback URLs (card 19.2). */
  PUBLIC_API_URL: z.string().default('https://admin.localhost'),
  /** Extra origins a payment may send the payer back to (comma-separated; the dashboard is always allowed). */
  PAYMENT_RETURN_ORIGINS: optionalString,
  ZARINPAL_MERCHANT_ID: optionalString,
  ZARINPAL_BASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url().default('https://payment.zarinpal.com'),
  ),
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_BASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url().default('https://api.stripe.com'),
  ),
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
