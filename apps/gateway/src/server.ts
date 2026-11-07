/**
 * ساخت سرور گیت‌وی. مسیرهای /v1 مستقیم روی Fastify‌اند (بدون pipeline سنگین)؛
 * ADR-001: هیچ hook یا middleware سراسری روی مسیر داغ.
 */
import type { IncomingMessage } from 'node:http';
import { hostname } from 'node:os';

import type { UsageEvent } from '@dirouter/contracts';
import { HealthRegistry, RetryBudget } from '@dirouter/routing';
import { type Keyring, type Logger, prefixedId } from '@dirouter/shared';
import Fastify from 'fastify';

import { authenticate, extractApiKey } from './auth.js';
import { ConfigStore } from './config-store.js';
import { handleProxy } from './proxy.js';

export interface GatewayOptions {
  logger: Logger;
  keyring: Keyring;
  pepper: string;
  dataDir: string;
  controlApiUrl?: string;
  internalToken?: string;
  instance?: string;
  emitUsage?: (event: UsageEvent) => void;
  heartbeatMs?: number;
}

export function buildGateway(opts: GatewayOptions) {
  const health = new HealthRegistry();
  const store = new ConfigStore({
    dataDir: opts.dataDir,
    keyring: opts.keyring,
    health,
    logger: opts.logger,
    ...(opts.controlApiUrl ? { controlApiUrl: opts.controlApiUrl } : {}),
    ...(opts.internalToken ? { internalToken: opts.internalToken } : {}),
  });
  const deps = {
    store,
    budget: new RetryBudget(),
    pepper: opts.pepper,
    logger: opts.logger,
    // در داکر hostname همان شناسهٔ کانتینر است؛ برای ردیابی replica در لاگ و هدر.
    instance: opts.instance ?? hostname(),
    emitUsage:
      opts.emitUsage ??
      ((event: UsageEvent) => {
        opts.logger.info({ usage: event }, 'usage');
      }),
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  };

  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 20 * 1024 * 1024,
    requestTimeout: 0,
    // بیشتر از idleConnTimeout ترافیک (۹۰s) تا گیت‌وی زودتر از Traefik اتصال idle را نبندد
    // (وگرنه درخواستی که Traefik روی اتصالِ در حال بسته‌شدن می‌فرستد 502 می‌گیرد).
    keepAliveTimeout: 95_000,
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w.-]{1,128}$/.test(incoming)
        ? incoming
        : prefixedId('req');
    },
  });

  let draining = false;
  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id).header('x-dirouter-instance', deps.instance);
  });

  app.post('/v1/chat/completions', (req, reply) => handleProxy('openai.chat', req, reply, deps));
  app.post('/chat/completions', (req, reply) => handleProxy('openai.chat', req, reply, deps));
  app.post('/v1/messages', (req, reply) => handleProxy('anthropic.messages', req, reply, deps));

  app.get('/v1/models', async (req, reply) => {
    const config = store.current;
    if (!config)
      return reply.status(503).send({
        error: {
          message: 'not ready',
          type: 'server_error',
          param: null,
          code: 'service_unavailable',
        },
      });
    try {
      const key = authenticate(config, extractApiKey(req.headers), opts.pepper, req.ip);
      const names = config.router.index
        .names(key.organizationId)
        .filter((n) => key.allowedModels.length === 0 || key.allowedModels.includes(n));
      return {
        object: 'list',
        data: names.map((id) => ({ id, object: 'model', created: 0, owned_by: 'dirouter' })),
      };
    } catch (error) {
      const e = error as { status?: number; toOpenAI?: () => unknown };
      return reply.status(e.status ?? 401).send(e.toOpenAI?.() ?? {});
    }
  });

  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const ok = store.ready && !draining;
    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ok' : draining ? 'draining' : 'no_config',
      configVersion: store.current?.version ?? 0,
      controlApiSync: store.lastSyncOk,
    });
  });
  app.get('/internal/health', () => health.report());

  return {
    app,
    store,
    health,
    async start() {
      await store.start();
    },
    /** graceful drain: readyz=503 تا Traefik ترافیک جدید نفرستد، سپس بستن. */
    async drain(ms: number) {
      draining = true;
      store.stop();
      await new Promise((r) => setTimeout(r, Math.min(ms, 5_000)));
      await app.close();
    },
  };
}
