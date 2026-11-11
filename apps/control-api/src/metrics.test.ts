import 'reflect-metadata';

import { Writable } from 'node:stream';

import { createLogger, generateKey } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from './bootstrap.js';
import { envSchema } from './env.js';

describe('control-api observability', () => {
  let app: NestFastifyApplication;
  const lines: Record<string, unknown>[] = [];
  beforeAll(async () => {
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        done();
      },
    });
    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/none',
        VALKEY_URL: 'redis://127.0.0.1:1',
        MASTER_KEY: generateKey(),
        KEY_PEPPER: 'p'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
      }),
      createLogger({
        service: 'control-api',
        level: 'info',
        destination,
      }),
    );
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());

  it('serves queue metrics with a bounded scrape and preserves request correlation', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/metrics',
        headers: { 'x-request-id': 'req_control_metrics' },
      });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req_control_metrics');
    expect(res.body).toContain('dirouter_queue_jobs');
    expect(res.body).toContain('dirouter_queue_metrics_up');
    expect(res.body).toContain('dirouter_control_api_request_duration_seconds');
    expect(res.body).not.toContain('req_control_metrics');
    const log = lines.find(
      (line) => line.requestId === 'req_control_metrics' && line.msg === 'request',
    );
    expect(log).toMatchObject({ requestId: 'req_control_metrics', status: 200 });
  }, 15_000);
});
