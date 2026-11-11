/**
 * ساخت سرور گیت‌وی. مسیرهای /v1 مستقیم روی Fastify‌اند (بدون pipeline سنگین)؛
 * ADR-001: هیچ hook یا middleware سراسری روی مسیر داغ.
 */
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';

import type { UsageEvent } from '@dirouter/contracts';
import {
  BulkheadRegistry,
  type HealthChange,
  HealthRegistry,
  RetryBudget,
} from '@dirouter/routing';
import { type Keyring, type Logger, prefixedId } from '@dirouter/shared';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Redis } from 'ioredis';
import Fastify, { type FastifyRequest } from 'fastify';

import { authenticate, extractApiKey } from './auth.js';
import { ConfigStore } from './config-store.js';
import { createGatewayMetrics } from './metrics.js';
import { probeProvider } from './probe.js';
import { handleCountTokens, handleProxy } from './proxy.js';
import { BudgetGuard } from './budget-guard.js';
import { RateLimiter } from './rate-limiter.js';

export interface GatewayOptions {
  logger: Logger;
  keyring: Keyring;
  pepper: string;
  dataDir: string;
  controlApiUrl?: string;
  internalToken?: string;
  instance?: string;
  emitUsage?: (event: UsageEvent) => void;
  /** تغییرات سلامت محلی برای انتشار به replicaهای دیگر (HealthSync). */
  onHealthChange?: (change: HealthChange) => void;
  heartbeatMs?: number;
  /** اتصال Valkey برای rate limiter (کارت ۶.۱)؛ بدون آن limiter محلی تک‌نودی است. */
  limiterRedis?: Redis;
  /** کارت ۸.۲: لاگ ساخت‌یافته پایان هر درخواست در کنار رویداد مصرف. */
  onRequestComplete?: (event: UsageEvent) => void;
  /** outbox محلی usage برای gauge اندازهٔ backlog. */
  outbox?: { backlogSize(): Promise<number> };
  /** فقط برای تست: طول پنجرهٔ limiter. */
  limiterWindowMs?: number;
}

export function buildGateway(opts: GatewayOptions) {
  const health = new HealthRegistry({
    onChange: (change) => {
      opts.onHealthChange?.(change);
    },
  });
  const store = new ConfigStore({
    dataDir: opts.dataDir,
    keyring: opts.keyring,
    health,
    logger: opts.logger,
    ...(opts.controlApiUrl ? { controlApiUrl: opts.controlApiUrl } : {}),
    ...(opts.internalToken ? { internalToken: opts.internalToken } : {}),
  });
  const metrics = createGatewayMetrics({
    ...(opts.outbox ? { outbox: { size: opts.outbox.backlogSize.bind(opts.outbox) } } : {}),
    breakerStates: () => {
      const report = health.report();
      const providerModel = new Map<string, string>();
      for (const model of store.current?.snapshot.models ?? [])
        providerModel.set(model.id, model.providerId);
      return [
        ...report.providers.map((b) => ({
          scope: 'provider' as const,
          provider: b.id,
          model: '',
          state: b.state,
        })),
        ...report.models.map((b) => ({
          scope: 'model' as const,
          provider: providerModel.get(b.id) ?? 'unknown',
          model: b.id,
          state: b.state,
        })),
      ];
    },
  });
  // چرخهٔ خاموشی (کارت ۵.۸): draining و سیگنال قطع اجباری درخواست‌های باقی‌مانده.
  const shutdown = new AbortController();
  const lifecycle = { draining: false, signal: shutdown.signal };
  const deliverUsage =
    opts.emitUsage ??
    ((event: UsageEvent) => {
      // لاگ پیش‌فرض فقط metadata است؛ usage شامل prompt/response و secret نیست.
      opts.logger.info({ requestId: event.requestId }, 'usage event emitted locally');
    });
  const deps = {
    store,
    budget: new RetryBudget(),
    lifecycle,
    budgets: new BudgetGuard({
      logger: opts.logger,
      failMode: () => store.current?.snapshot.settings.failMode ?? 'open',
      ...(opts.limiterRedis ? { redis: opts.limiterRedis } : {}),
    }),
    limiter: new RateLimiter({
      logger: opts.logger,
      failMode: () => store.current?.snapshot.settings.failMode ?? 'open',
      ...(opts.limiterRedis ? { redis: opts.limiterRedis } : {}),
      ...(opts.limiterWindowMs ? { windowMs: opts.limiterWindowMs } : {}),
    }),
    bulkheads: new BulkheadRegistry({ queueSize: 16, queueTimeoutMs: 2_000 }),
    pepper: opts.pepper,
    logger: opts.logger,
    metrics,
    onRequestComplete: opts.onRequestComplete,
    // در داکر hostname همان شناسهٔ کانتینر است؛ برای ردیابی replica در لاگ و هدر.
    instance: opts.instance ?? hostname(),
    emitUsage: deliverUsage,
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
    // درخواستی که هنگام بستن روی اتصال باز برسد هنوز سرویس می‌گیرد (نه 503)؛ سقف زمان را
    // خود drain کنترل می‌کند.
    return503OnClosing: false,
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w.-]{1,128}$/.test(incoming)
        ? incoming
        : prefixedId('req');
    },
  });

  let inFlight = 0;
  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id).header('x-dirouter-instance', deps.instance);
    // در drain هر پاسخ اتصالش را می‌بندد تا Traefik اتصال تازه (به replica سالم) باز کند.
    if (lifecycle.draining) void reply.header('connection', 'close');
    if (req.url.startsWith('/v1/') || req.url.startsWith('/chat/')) {
      inFlight++;
      reply.raw.once('close', () => {
        inFlight--;
      });
    }
  });

  app.post('/v1/chat/completions', (req, reply) => handleProxy('openai.chat', req, reply, deps));
  app.post('/chat/completions', (req, reply) => handleProxy('openai.chat', req, reply, deps));
  app.post('/v1/messages', (req, reply) => handleProxy('anthropic.messages', req, reply, deps));
  app.post('/v1/messages/count_tokens', (req, reply) => {
    handleCountTokens(req, reply, deps);
  });

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
  app.get('/metrics', async (_req, reply) =>
    reply.type(metrics.contentType).send(await metrics.registry.metrics()),
  );
  app.get('/readyz', async (_req, reply) => {
    const ok = store.ready && !lifecycle.draining;
    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ok' : lifecycle.draining ? 'draining' : 'no_config',
      configVersion: store.current?.version ?? 0,
      controlApiSync: store.lastSyncOk,
    });
  });
  // وضعیت داخلی (شناسهٔ providerها و credentialها) فقط با INTERNAL_TOKEN؛ مسیر از Traefik هم
  // در دسترس است، پس بدون توکن 404 می‌دهد تا وجودش هم لو نرود.
  const internalOk = (req: FastifyRequest) => {
    const token = opts.internalToken;
    const given = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const expected = token ? `Bearer ${token}` : undefined;
    return (
      expected !== undefined &&
      given.length === expected.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    );
  };
  const notFound = { error: { message: 'Not found', code: 'not_found' } };
  app.get('/internal/health', async (req, reply) =>
    internalOk(req)
      ? {
          ...health.report(),
          bulkheads: deps.bulkheads.snapshot(),
          rateLimiter: { ...deps.limiter.stats, nodes: deps.limiter.nodes },
          budgets: deps.budgets.stats,
        }
      : reply.status(404).send(notFound),
  );
  // تست اتصال و کشف مدل برای control-api (کارت ۳.۶).
  app.post('/internal/providers/probe', async (req, reply) => {
    if (!internalOk(req)) return reply.status(404).send(notFound);
    try {
      return await probeProvider(req.body, opts.keyring);
    } catch (error) {
      const e = error as { status?: number; toProblem?: (id: string) => unknown };
      return reply.status(e.status ?? 500).send(e.toProblem?.(req.id) ?? { error: 'probe failed' });
    }
  });

  return {
    app,
    store,
    health,
    metrics,
    limiter: deps.limiter,
    budgets: deps.budgets,
    async start() {
      await store.start();
      if (opts.limiterRedis) deps.limiter.startNodeCount();
    },
    /** تعداد درخواست‌های proxy باز (از جمله streamها). */
    get inFlight() {
      return inFlight;
    },
    /**
     * graceful shutdown (کارت ۵.۸):
     * 1. readyz=503 و ادامهٔ سرویس به مدت `readyDelayMs` تا health check Traefik این replica
     *    را از چرخش خارج کند (در این فاصله پاسخ‌ها `connection: close` دارند).
     * 2. توقف پذیرش اتصال تازه و انتظار برای درخواست‌ها و streamهای باز تا سقف `drainMs`.
     * 3. درخواست‌های باقی‌مانده قطع می‌شوند: stream رویداد خطای استاندارد می‌گیرد و
     *    درخواست بی‌پاسخ 503.
     */
    async drain(options: { readyDelayMs: number; drainMs: number }): Promise<{ forced: number }> {
      lifecycle.draining = true;
      store.stop();
      deps.limiter.stop();
      await sleep(options.readyDelayMs);
      const closing = app.close();
      const deadline = Date.now() + options.drainMs;
      while (inFlight > 0 && Date.now() < deadline) {
        // اتصال keep-alive که پاسخش تمام شده بیکار است و بستنش امن است.
        app.server.closeIdleConnections();
        await sleep(50);
      }
      const forced = inFlight;
      if (forced > 0) {
        opts.logger.warn({ inFlight: forced }, 'drain timeout, aborting open requests');
        shutdown.abort(new Error('gateway shutting down'));
        // فرصت کوتاه برای نوشتن رویداد خطا یا 503 پیش از بستن اتصال‌ها.
        const grace = Date.now() + 1_000;
        while (inFlight > 0 && Date.now() < grace) await sleep(20);
      }
      app.server.closeAllConnections();
      await Promise.race([closing, sleep(2_000)]);
      return { forced };
    },
  };
}
