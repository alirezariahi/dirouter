import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { generateKey } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('liveness and readiness', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        VALKEY_URL,
        MASTER_KEY: generateKey(),
        KEY_PEPPER: 'p'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('reports liveness without service calls and readiness with both real checks', async () => {
    const http = app.getHttpAdapter().getInstance();
    expect((await http.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({
      status: 'ok',
    });
    const ready = await http.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ok',
      checks: { database: { status: 'ok' }, valkey: { status: 'ok' } },
    });
    const service = app.get(PrismaService);
    const ping = service.ping.bind(service);
    service.ping = async () => {
      throw new Error('test outage');
    };
    const unavailable = await http.inject({ method: 'GET', url: '/readyz' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      status: 'error',
      checks: { database: { status: 'error', error: 'test outage' } },
    });
    service.ping = ping;
  });
});
