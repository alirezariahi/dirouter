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
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('DiRouter <noreply@localhost>'),
});

export type Env = z.infer<typeof envSchema>;

/** توکن DI برای env اعتبارسنجی‌شده. */
export const ENV = Symbol('ENV');
