import { baseEnvSchema, envKeyring, envPort } from '@dirouter/shared';
import { z } from 'zod';

import { parseTrustProxy } from './trust-proxy.js';

// Compose passes unset variables as empty strings; empty means "not configured".
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);

function trustProxySetting(value: string | undefined, ctx: z.RefinementCtx<string | undefined>) {
  try {
    return parseTrustProxy(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
}

export const envSchema = baseEnvSchema.extend({
  PORT: envPort(3000),
  DATABASE_URL: z.string().min(1),
  VALKEY_URL: z.string().min(1),
  MASTER_KEY: envKeyring(),
  KEY_PEPPER: z.string().min(32),
  JWT_SECRET: z.string().min(32),
  INTERNAL_TOKEN: z.string().min(32),
  /**
   * Proxies whose X-Forwarded-For is believed (see trust-proxy.ts): a hop count (default 1, the
   * bundled Traefik), a comma list of proxy addresses/CIDRs, or true/false.
   */
  TRUST_PROXY: z.string().optional().transform(trustProxySetting),
  DASHBOARD_ORIGIN: z.string().default('https://app.localhost'),
  PUBLIC_DASHBOARD_URL: z.string().default('https://app.localhost'),
  /** Gateway for testing the connection and discovering provider models (card 3.6). */
  GATEWAY_INTERNAL_URL: z.string().default('http://gateway:8080'),
  /** Public gateway origin written into generated agent configurations (card 20.5). */
  PUBLIC_GATEWAY_URL: z.string().default('https://api.localhost'),
  /** Provider plugins (card 21.2): the same folder and list the gateway loads. */
  PLUGINS_DIR: z.string().default('./plugins'),
  PLUGINS_ENABLED: z.string().default(''),
  /** Public origin of this API, used in payment callback URLs (card 19.2). */
  PUBLIC_API_URL: z.string().default('https://admin.localhost'),
  /** Extra origins a payment may send the payer back to (comma-separated; the dashboard is always allowed). */
  PAYMENT_RETURN_ORIGINS: optionalString,
  /** Self-service portal (card 19.5): its public URL and an optional OIDC sign-in (e.g. Google). */
  PUBLIC_PORTAL_URL: z.string().default('https://portal.localhost'),
  PORTAL_OIDC_ISSUER: optionalString,
  PORTAL_OIDC_CLIENT_ID: optionalString,
  PORTAL_OIDC_CLIENT_SECRET: optionalString,
  PORTAL_OIDC_NAME: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().default('SSO'),
  ),
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
