import 'reflect-metadata';

import fastifyCookie from '@fastify/cookie';
import { createLogger, type Logger, prefixedId } from '@dirouter/shared';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import { SnapshotService } from './snapshot/snapshot.service.js';
import type { Env } from './env.js';
import type { IncomingMessage } from 'node:http';

export const API_PREFIX = 'api/v1';

export async function createApp(
  env: Env,
  logger: Logger = createLogger({ service: 'control-api', level: env.LOG_LEVEL }),
) {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w.-]{1,128}$/.test(incoming)
        ? incoming
        : prefixedId('req');
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env, logger),
    adapter,
    {
      logger: false,
    },
  );

  await app.register(fastifyCookie);
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });
  // هر تغییر موفق در پیکربندی سازمان، snapshot گیت‌وی را دوباره می‌سازد (کارت ۳.۹).
  const snapshots = app.get(SnapshotService);
  fastify.addHook('onResponse', async (request, reply) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.url.startsWith(`/${API_PREFIX}/orgs/`) &&
      reply.statusCode < 400
    )
      snapshots.schedule(`${request.method} ${request.routeOptions.url ?? request.url}`);
  });
  fastify.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });

  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
      { path: 'internal/(.*)', method: RequestMethod.ALL },
    ],
  });
  app.useGlobalFilters(new ProblemFilter(logger));
  app.enableCors({
    origin: [env.DASHBOARD_ORIGIN],
    credentials: true,
    exposedHeaders: ['x-request-id', 'etag'],
  });
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('DiRouter control-api')
      .setDescription('API مدیریتی DiRouter. همهٔ خطاها با قالب application/problem+json.')
      .setVersion('1')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs/openapi.json' });

  return app;
}
