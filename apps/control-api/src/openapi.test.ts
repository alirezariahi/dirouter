/**
 * کامل بودن مستندات Swagger (کارت ۳.۳): هر عملیات اسکیمای پاسخ دارد و هر عملیات نوشتنیِ
 * دارای بدنه، اسکیمای درخواست. بدون DB اجرا می‌شود (ساخت سند به اتصال نیاز ندارد).
 */
import 'reflect-metadata';

import { generateKey } from '@dirouter/shared';
import { describe, expect, it } from 'vitest';

import { createApp } from './bootstrap.js';
import { envSchema } from './env.js';

const NO_BODY = ['/revoke', '/discover', '/sync-catalog', '/logout', '/refresh'];

describe('OpenAPI document', () => {
  it('documents every operation with request and response schemas', async () => {
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
    const doc = res.json<{
      paths: Record<
        string,
        Record<string, { responses?: Record<string, { content?: object }>; requestBody?: object }>
      >;
    }>();
    const missing: string[] = [];
    let operations = 0;
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        operations++;
        const responses = Object.entries(op.responses ?? {});
        if (
          !responses.some(
            ([code, r]) => code === '204' || (r.content && Object.keys(r.content).length > 0),
          )
        )
          missing.push(`${method} ${path}: response`);
        for (const name of [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
          if (
            !(op as { parameters?: { in: string; name: string }[] }).parameters?.some(
              (p) => p.in === 'path' && p.name === name,
            )
          )
            missing.push(`${method} ${path}: path parameter ${String(name)}`);
        if (
          ['post', 'patch', 'put'].includes(method) &&
          !op.requestBody &&
          !NO_BODY.some((n) => path.includes(n))
        )
          missing.push(`${method} ${path}: body`);
      }
    }
    expect(operations).toBeGreaterThanOrEqual(60);
    expect(missing).toEqual([]);
    // endpointهای داخلی در سند عمومی نیستند.
    expect(Object.keys(doc.paths).some((p) => p.startsWith('/internal'))).toBe(false);
    await app.close();
  }, 30_000);
});
