/**
 * Builds the gateway server. The /v1 routes run directly on Fastify (no heavy pipeline);
 * ADR-001: no global hook or middleware on the hot path.
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
  /** Local health changes to publish to other replicas (HealthSync). */
  onHealthChange?: (change: HealthChange) => void;
  heartbeatMs?: number;
  /** Valkey connection for the rate limiter (card 6.1); without it the limiter is local single-node. */
  limiterRedis?: Redis;
  /** Card 8.2: structured end-of-request log alongside the usage event. */
  onRequestComplete?: (event: UsageEvent) => void;
  /** Local usage outbox for the backlog-size gauge. */
  outbox?: { backlogSize(): Promise<number> };
  /** Tests only: limiter window length. */
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
  // Shutdown cycle (card 5.8): draining and the forced-disconnect signal for remaining requests.
  const shutdown = new AbortController();
  const lifecycle = { draining: false, signal: shutdown.signal };
  const deliverUsage =
    opts.emitUsage ??
    ((event: UsageEvent) => {
      // The default log is metadata only; usage does not include prompt/response or secrets.
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
    // In Docker the hostname is the container ID; used to trace the replica in logs and headers.
    instance: opts.instance ?? hostname(),
    emitUsage: deliverUsage,
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  };

  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 20 * 1024 * 1024,
    requestTimeout: 0,
    // Longer than the idleConnTimeout of the traffic (90s), so the gateway does not close an idle connection before Traefik does
    // (otherwise a request Traefik sends on a connection that is closing gets a 502).
    keepAliveTimeout: 95_000,
    // A request that arrives on an open connection during shutdown is still served (not 503); the time cap
    // is controlled by drain itself.
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
    // During drain every response closes its connection so Traefik opens a new one (to a healthy replica).
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
  // Internal state (provider and credential IDs) only with INTERNAL_TOKEN; the route is also reachable via Traefik,
  // so without the token it returns 404 to keep its existence hidden.
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
  // Connection test and model discovery for control-api (card 3.6).
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
    /** Number of open proxy requests (including streams). */
    get inFlight() {
      return inFlight;
    },
    /**
     * graceful shutdown (card 5.8):
     * 1. readyz=503 and service continues for `readyDelayMs`, so Traefik's health check takes this replica
     *    out of rotation (during this interval responses carry `connection: close`).
     * 2. Stop accepting new connections and wait for in-flight requests and open streams, up to the `drainMs` cap.
     * 3. Remaining requests are cut: a stream gets a standard error event, and
     *    an unanswered request gets 503.
     */
    async drain(options: { readyDelayMs: number; drainMs: number }): Promise<{ forced: number }> {
      lifecycle.draining = true;
      store.stop();
      deps.limiter.stop();
      await sleep(options.readyDelayMs);
      const closing = app.close();
      const deadline = Date.now() + options.drainMs;
      while (inFlight > 0 && Date.now() < deadline) {
        // A keep-alive connection whose response is finished and is idle; closing it is safe.
        app.server.closeIdleConnections();
        await sleep(50);
      }
      const forced = inFlight;
      if (forced > 0) {
        opts.logger.warn({ inFlight: forced }, 'drain timeout, aborting open requests');
        shutdown.abort(new Error('gateway shutting down'));
        // A short window to write the error event or 503 before connections are closed.
        const grace = Date.now() + 1_000;
        while (inFlight > 0 && Date.now() < grace) await sleep(20);
      }
      app.server.closeAllConnections();
      await Promise.race([closing, sleep(2_000)]);
      return { forced };
    },
  };
}
