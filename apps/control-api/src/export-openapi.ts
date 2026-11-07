/**
 * خروجی گرفتن از سند OpenAPI برای تولید کلاینت داشبورد (orval، کارت ۷.۱) بدون DB.
 * استفاده: pnpm --filter @dirouter/control-api openapi:export [مسیر خروجی]
 */
import 'reflect-metadata';

import { writeFile } from 'node:fs/promises';

import { generateKey } from '@dirouter/shared';

import { createApp } from './bootstrap.js';
import { envSchema } from './env.js';

const out = process.argv[2] ?? '../dashboard/openapi.json';
const app = await createApp(
  envSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/none',
    VALKEY_URL: 'redis://127.0.0.1:1',
    MASTER_KEY: generateKey(),
    KEY_PEPPER: 'p'.repeat(32),
    JWT_SECRET: 'j'.repeat(32),
    INTERNAL_TOKEN: 'i'.repeat(32),
  }),
);
await app.getHttpAdapter().getInstance().ready();
const res = await app
  .getHttpAdapter()
  .getInstance()
  .inject({ method: 'GET', url: '/api/docs/openapi.json' });
await writeFile(out, `${JSON.stringify(res.json(), null, 2)}\n`);
await app.close();
process.stdout.write(`openapi → ${out}\n`);
process.exit(0);
