/**
 * Builds the gateway server. The /v1 routes run directly on Fastify (no heavy pipeline);
 * ADR-001: no global hook or middleware on the hot path.
 */
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';

import {
  type CanonicalRequest,
  GeminiGenerateContentRequest,
  type McpCallRecord,
  type UsageEvent,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import {
  BulkheadRegistry,
  estimateMicroUsd,
  type HealthChange,
  HealthRegistry,
  headroom,
  explainPlan,
  isAutoAlias,
  isPlanError,
  parseModelSuffixes,
  planRoute,
  RetryBudget,
  type TaskType,
} from '@dirouter/routing';
import { type DiRouterError, type Keyring, type Logger, prefixedId } from '@dirouter/shared';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Redis } from 'ioredis';
import Fastify, { type FastifyRequest } from 'fastify';

import { authenticate, extractApiKey } from './auth.js';
import { ConfigStore } from './config-store.js';
import { createGatewayMetrics } from './metrics.js';
import { probeProvider } from './probe.js';
import type { WebSearchExtension } from './web-search.js';
import {
  planErrorStatus,
  type RequestRouting,
  routingFromRequest,
  withSuffixes,
} from './route-request.js';
import { balanceForProbe } from './balance.js';
import { handleCountTokens, handleProxy } from './proxy.js';
import { BudgetGuard } from './budget-guard.js';
import { WalletGuard } from './wallet-guard.js';
import { McpGateway } from './mcp/gateway.js';
import { probeMcpServer } from './mcp/probe.js';
import { A2aAgent } from './a2a/agent.js';
import { RateLimiter } from './rate-limiter.js';
import { ExactCache, SemanticCacheClient } from './cache.js';
import { handleModerations } from './classifiers.js';
import { handleCompletions } from './completions.js';
import { handleEmbeddings, handleGeminiEmbeddings } from './embeddings.js';
import { registerMediaRoutes } from './media.js';
import { registerPassthroughRoutes } from './passthrough.js';
import { DEFAULT_REALTIME_SETTINGS, RealtimeGateway, type RealtimeSettings } from './realtime.js';
import { registerRerankRoutes } from './rerank.js';
import { refreshBatch, registerBatchRoutes } from './batches.js';
import { expireFile, registerFileRoutes } from './files.js';
import { type BlobStorage, LocalBlobStorage } from './jobs/blobs.js';
import { DEFAULT_JOBS_OPTIONS, type JobsDeps, type JobsOptions } from './jobs/context.js';
import { JobPoller } from './jobs/poller.js';
import { deliverWebhook } from './jobs/webhooks.js';
import { refreshTask, registerVideoRoutes } from './videos.js';
import { MemoryJobStore, RedisJobStore } from './jobs/store.js';
import { type SearchBackendConfig, WebSearchBackends } from './web/search.js';
import { WebServices } from './web/service.js';
import { configureUpstreamGuard } from './upstream.js';
import { credentialTokens } from './credential-tokens.js';
import { Tracer } from './tracing.js';
import type { RecordBody } from './body-capture.js';
import { type OtlpLogBuffer, OtlpExporter } from './otlp-export.js';
import { SplitSync } from './split-sync.js';
import { geminiRequestToCanonical } from '@dirouter/translator';
import { estimateRequestTokens, pricingForServiceTier } from '@dirouter/model-catalog';
import { enabledPlugins, loadPlugins } from '@dirouter/providers';

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
  /** Valkey connection for conversation state (previous_response_id, card 11.2). */
  stateRedis?: Redis;
  /** Card 8.2: structured end-of-request log alongside the usage event. */
  onRequestComplete?: (event: UsageEvent) => void;
  /** Destination of MCP tool-call records (card 20.1). */
  recordMcpCall?: (call: McpCallRecord) => void;
  /** Log lines to export over OTLP when settings.tracing.logs is on (card 24.3). */
  otlpLogs?: OtlpLogBuffer;
  /** Tests only: OTLP export tick. */
  otlpTickMs?: number;
  /** Destination of captured request bodies (card 24.1); its own queue, never the usage path. */
  recordBody?: RecordBody;
  /** Local usage outbox for the backlog-size gauge. */
  outbox?: { backlogSize(): Promise<number> };
  /** Tests only: limiter window length. */
  limiterWindowMs?: number;
  /** Provider plugins to load at start (card 21.2). */
  plugins?: { dir: string; enabled: string };
  /** SSRF guard: customer providers reach public addresses only (production, card 22.3). */
  blockPrivateUpstreams?: boolean;
  /** Tests only: delays between A2A push notification retries (card 28.2). */
  a2aPushRetryDelaysMs?: readonly number[];
  /**
   * Web search for the `:online` suffix (card 31.5). Defaults to the gateway's own web search
   * (card 30.8); tests can pass another implementation.
   */
  onlineSearch?: WebSearchExtension;
  /** Web search backends (card 30.8): SearXNG, Brave and Tavily addresses and keys. */
  webSearch?: SearchBackendConfig;
  /** Files, batches and async tasks (cards 30.1 and 30.6): limits and where bytes are kept. */
  jobs?: Partial<JobsOptions> & { storage?: BlobStorage; pollerTickMs?: number };
  /** Realtime session limits (card 30.5). */
  realtime?: Partial<RealtimeSettings>;
}

export function buildGateway(opts: GatewayOptions) {
  const health = new HealthRegistry({
    onChange: (change) => {
      // A credential the upstream rejected (401/403) loses its cached OAuth token (card 27.4):
      // a revoked token is not reused until its refresh window.
      if (change.kind === 'credential_disabled') credentialTokens.invalidate(change.credentialId);
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
  configureUpstreamGuard({
    enabled: opts.blockPrivateUpstreams === true,
    platformOrganizationId: () => store.current?.snapshot.platformOrganizationId,
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
  // Canary rollbacks shared between replicas (card 32.3).
  const splits = new SplitSync({ store, redis: opts.limiterRedis, logger: opts.logger });
  const deps = {
    store,
    splitHealth: splits.health,
    ...(opts.onlineSearch ? { webSearch: opts.onlineSearch } : {}),
    budget: new RetryBudget(),
    // One rolling hedge budget per (ratio, window) pair, shared by every request (card 12.2).
    hedgeBudgets: new Map(),
    lifecycle,
    budgets: new BudgetGuard({
      logger: opts.logger,
      failMode: () => store.current?.snapshot.settings.failMode ?? 'open',
      ...(opts.limiterRedis ? { redis: opts.limiterRedis } : {}),
    }),
    wallets: new WalletGuard({
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
    // Auto routing's optional small-model classifier (card 20.4): one word through the gateway's
    // own endpoint with the caller's key, so it is billed and limited like any request. Unsure or
    // slow (over 1.5 s) means the rules decide.
    classifyWithModel: async (model: string, request: CanonicalRequest, req: FastifyRequest) => {
      const last = [...request.messages].reverse().find((m) => m.role === 'user');
      const text = (last?.content ?? [])
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('\n')
        .slice(0, 2_000);
      const call = app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: req.headers.authorization ?? `Bearer ${extractApiKey(req.headers) ?? ''}`,
          'content-type': 'application/json',
        },
        payload: {
          model,
          temperature: 0,
          max_tokens: 4,
          messages: [
            {
              role: 'system',
              content:
                'Classify the request. Answer with exactly one word: coding, reasoning, summarization or chat.',
            },
            { role: 'user', content: text },
          ],
        },
      });
      const res = await Promise.race([
        call,
        new Promise<undefined>((resolve) => {
          setTimeout(() => {
            resolve(undefined);
          }, 1_500).unref();
        }),
      ]);
      if (res?.statusCode !== 200) return undefined;
      const answer = res
        .json<{ choices?: { message?: { content?: string } }[] }>()
        .choices?.[0]?.message?.content?.toLowerCase();
      return /\b(coding|reasoning|summarization|chat)\b/.exec(answer ?? '')?.[1] as
        TaskType | undefined;
    },
    // Response caches and tracing (cards 13.1, 13.2 and 17.2); settings are read per snapshot.
    cache: new ExactCache({
      ...(opts.limiterRedis ? { redis: opts.limiterRedis } : {}),
    }),
    ...(opts.limiterRedis ? { stateRedis: opts.limiterRedis } : {}),
    ...(opts.stateRedis ? { stateRedis: opts.stateRedis } : {}),
    tracer: new Tracer(() => store.current?.snapshot.settings.tracing, opts.logger),
    ...(opts.recordBody ? { recordBody: opts.recordBody } : {}),
    ...(opts.controlApiUrl && opts.internalToken
      ? {
          semanticCache: new SemanticCacheClient({
            baseUrl: opts.controlApiUrl,
            internalToken: opts.internalToken,
          }),
        }
      : {}),
    // In Docker the hostname is the container ID; used to trace the replica in logs and headers.
    instance: opts.instance ?? hostname(),
    emitUsage: deliverUsage,
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    /** Web search and fetch (card 30.8); set once the server exists. */
    web: undefined as WebServices | undefined,
  };

  // OTLP metrics and logs (card 24.3); each switched on in settings.tracing, read on every tick.
  const otlp = new OtlpExporter({
    settings: () => store.current?.snapshot.settings.tracing,
    registry: metrics.registry,
    logger: opts.logger,
    ...(opts.otlpLogs ? { logs: opts.otlpLogs } : {}),
    instance: deps.instance,
    ...(opts.otlpTickMs ? { tickMs: opts.otlpTickMs } : {}),
  });

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
    // `/v1beta/` (Gemini) and `/v2/` (Cohere rerank) requests are drained like every other API call.
    if (/^\/(v1|v2|v1beta|chat|passthrough)\//.test(req.url)) {
      inFlight++;
      reply.raw.once('close', () => {
        inFlight--;
      });
    }
  });

  // Web search and fetch (card 30.8): /v1/search, /v1/fetch, online mode and the Anthropic
  // web_search server tool for models without one.
  const web = new WebServices(
    app,
    deps,
    new WebSearchBackends(opts.webSearch ?? {}, opts.limiterRedis),
  );
  deps.web = web;
  // The `:online` suffix (card 31.5) searches through these services unless a test injected one.
  deps.webSearch ??= web.onlineExtension();
  const onlineAvailable = () => deps.webSearch?.available?.() ?? deps.webSearch !== undefined;
  web.register();
  app.post('/v1/chat/completions', (req, reply) =>
    web.wants('openai.chat', req.body)
      ? web.handle('openai.chat', req, reply)
      : handleProxy('openai.chat', req, reply, deps),
  );
  app.post('/chat/completions', (req, reply) =>
    web.wants('openai.chat', req.body)
      ? web.handle('openai.chat', req, reply)
      : handleProxy('openai.chat', req, reply, deps),
  );
  app.post('/v1/messages', (req, reply) =>
    web.wants('anthropic.messages', req.body)
      ? web.handle('anthropic.messages', req, reply)
      : handleProxy('anthropic.messages', req, reply, deps),
  );
  app.post('/v1/messages/count_tokens', (req, reply) => {
    handleCountTokens(req, reply, deps);
  });

  // Sprint 2 inbound APIs (cards 11.1, 11.2 and 11.4).
  app.post('/v1/responses', (req, reply) => handleProxy('openai.responses', req, reply, deps));
  // Legacy text completions (card 30.4), native or mapped to chat.
  app.post('/v1/completions', (req, reply) => handleCompletions(req, reply, deps));
  app.post('/v1/embeddings', (req, reply) => handleEmbeddings(req, reply, deps));
  app.post('/v1/moderations', (req, reply) => handleModerations(req, reply, deps));
  registerMediaRoutes(app, deps);
  // Native provider pass-through (card 30.7), with its own raw-body parser.
  registerPassthroughRoutes(app, deps);
  // Realtime API over WebSocket (card 30.5).
  const realtime = new RealtimeGateway(deps, { ...DEFAULT_REALTIME_SETTINGS, ...opts.realtime });
  realtime.register(app);
  registerRerankRoutes(app, deps);

  // Files, batches (card 30.1) and async video tasks with webhooks (card 30.6): state in Valkey (or memory on a single node), bytes in the
  // configured storage, followed upstream by the job poller (ADR-0007).
  const jobsRedis = opts.stateRedis ?? opts.limiterRedis;
  const jobDeps: JobsDeps = {
    ...deps,
    jobs: jobsRedis ? new RedisJobStore(jobsRedis) : new MemoryJobStore(),
    blobs: opts.jobs?.storage ?? new LocalBlobStorage(`${opts.dataDir}/files`),
    jobOptions: { ...DEFAULT_JOBS_OPTIONS, ...opts.jobs },
    keyring: opts.keyring,
  };
  registerFileRoutes(app, jobDeps);
  registerBatchRoutes(app, jobDeps);
  registerVideoRoutes(app, jobDeps);
  const poller = new JobPoller({
    store: jobDeps.jobs,
    logger: opts.logger,
    ...(opts.jobs?.pollerTickMs ? { tickMs: opts.jobs.pollerTickMs } : {}),
    handlers: {
      file: (id) => expireFile(jobDeps, id),
      batch: (id) => refreshBatch(jobDeps, id),
      task: (id) => refreshTask(jobDeps, id),
      webhook: (id) => deliverWebhook(jobDeps, id),
    },
  });
  app.addHook('onClose', async () => {
    await poller.stop();
  });
  app.post('/v1beta/models/:modelAction', (req, reply) => {
    const param = (req.params as { modelAction?: string }).modelAction ?? '';
    const [rawModel = '', action = ''] = param.split(':');
    // Fastify has already decoded the path parameter; decoding it again would throw on a literal
    // '%' and mangle encoded characters.
    const model = rawModel;
    if (action === 'embedContent' || action === 'batchEmbedContents')
      return handleGeminiEmbeddings(req, reply, deps);
    if (action === 'countTokens') {
      const config = store.current;
      if (!config)
        return reply.status(503).send({
          error: { code: 503, message: 'not ready', status: 'UNAVAILABLE' },
        });
      try {
        authenticate(
          config,
          extractApiKey(req.headers, (req.query as { key?: string }).key),
          opts.pepper,
          req.ip,
        );
        const parsed = GeminiGenerateContentRequest.safeParse({
          ...(req.body as Record<string, unknown>),
          model,
        });
        if (!parsed.success)
          return reply.status(400).send({
            error: { code: 400, message: 'invalid request', status: 'INVALID_ARGUMENT' },
          });
        return { totalTokens: estimateRequestTokens(geminiRequestToCanonical(parsed.data)) };
      } catch (error) {
        const e = error as { status?: number; message?: string };
        return reply.status(e.status ?? 400).send({
          error: { code: e.status ?? 400, message: e.message ?? 'invalid request' },
        });
      }
    }
    if (action === 'generateContent' || action === 'streamGenerateContent') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      body.model = model;
      if (action === 'streamGenerateContent') body.stream = true;
      return handleProxy('gemini.generate', req, reply, deps);
    }
    return reply.status(404).send({
      error: { code: 404, message: `unsupported model action '${action}'`, status: 'NOT_FOUND' },
    });
  });
  app.get('/v1beta/models', (req, reply) => {
    const config = store.current;
    if (!config)
      return reply.status(503).send({
        error: { code: 503, message: 'not ready', status: 'UNAVAILABLE' },
      });
    try {
      const key = authenticate(
        config,
        extractApiKey(req.headers, (req.query as { key?: string }).key),
        opts.pepper,
        req.ip,
      );
      const names = config.router.index
        .names(key.organizationId)
        .filter((n) => key.allowedModels.length === 0 || key.allowedModels.includes(n));
      return {
        models: names.map((name) => ({
          name: `models/${name}`,
          displayName: name,
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        })),
      };
    } catch (error) {
      const e = error as { status?: number; message?: string };
      return reply.status(e.status ?? 401).send({
        error: { code: e.status ?? 401, message: e.message ?? 'unauthorized' },
      });
    }
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
      const key = authenticate(
        config,
        extractApiKey(req.headers, (req.query as { key?: string }).key),
        opts.pepper,
        req.ip,
      );
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

  // MCP gateway (card 20.1): Streamable HTTP, authenticated with the virtual key.
  const mcp = new McpGateway({
    store,
    pepper: opts.pepper,
    logger: opts.logger,
    instance: deps.instance,
    keyring: opts.keyring,
    redis: opts.stateRedis ?? opts.limiterRedis,
    ...(opts.recordMcpCall ? { record: opts.recordMcpCall } : {}),
  });
  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    handler: (req, reply) => mcp.handle(req, reply),
  });
  app.addHook('onClose', () => {
    mcp.close();
    splits.stop();
  });

  // A2A (card 20.3): DiRouter as an agent, and registered external agents behind the same key.
  const a2a = new A2aAgent(app, {
    store,
    pepper: opts.pepper,
    logger: opts.logger,
    instance: deps.instance,
    keyring: opts.keyring,
    redis: opts.stateRedis ?? opts.limiterRedis,
    ...(opts.recordMcpCall ? { record: opts.recordMcpCall } : {}),
    ...(opts.a2aPushRetryDelaysMs ? { pushRetryDelaysMs: opts.a2aPushRetryDelaysMs } : {}),
  });
  a2a.register();

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
          wallets: deps.wallets.stats,
          mcp: mcp.stats,
          a2a: a2a.stats,
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

  // Upstream balance of a provider's credentials for the control-api (card 32.9).
  app.post('/internal/providers/balance', async (req, reply) => {
    if (!internalOk(req)) return reply.status(404).send(notFound);
    try {
      return await balanceForProbe(req.body, opts.keyring);
    } catch (error) {
      const e = error as { status?: number; toProblem?: (id: string) => unknown };
      return reply
        .status(e.status ?? 500)
        .send(e.toProblem?.(req.id) ?? { error: 'balance lookup failed' });
    }
  });

  // MCP server / A2A agent connection test and tool discovery for control-api (card 25.3).
  app.post('/internal/mcp/probe', async (req, reply) => {
    if (!internalOk(req)) return reply.status(404).send(notFound);
    try {
      return await probeMcpServer(req.body, opts.keyring, opts.logger);
    } catch (error) {
      const e = error as { status?: number; toProblem?: (id: string) => unknown };
      return reply.status(e.status ?? 500).send(e.toProblem?.(req.id) ?? { error: 'probe failed' });
    }
  });

  // Routing dry-run (card 12.5): same resolver as traffic, no I/O, with exact skip reasons.
  app.post('/internal/routes/simulate', async (req, reply) => {
    if (!internalOk(req)) return reply.status(404).send(notFound);
    const config = store.current;
    if (!config)
      return reply.status(503).send({ error: { message: 'not ready', code: 'unavailable' } });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requested = typeof body.model === 'string' ? body.model : undefined;
    if (!requested)
      return reply
        .status(400)
        .send({ error: { message: 'model is required', code: 'invalid_request' } });
    const virtualKeyId = typeof body.virtualKeyId === 'string' ? body.virtualKeyId : undefined;
    const savedKey = virtualKeyId
      ? config.snapshot.virtualKeys.find((k) => k.id === virtualKeyId)
      : undefined;
    const organizationId =
      (typeof body.organizationId === 'string' ? body.organizationId : undefined) ??
      savedKey?.organizationId ??
      config.snapshot.models.find((m) => m.slug === requested || m.id === requested)
        ?.organizationId ??
      config.snapshot.combos.find((c) => c.slug === requested || c.id === requested)
        ?.organizationId ??
      config.snapshot.providers[0]?.organizationId;
    if (!organizationId)
      return reply
        .status(400)
        .send({ error: { message: 'organizationId is required', code: 'invalid_request' } });
    const key: VirtualKeyConfig = savedKey ?? {
      id: 'simulate',
      organizationId,
      hash: 'a'.repeat(64),
      prefix: 'sim_',
      teamId: null,
      projectId: '',
      enabled: true,
      expiresAt: null,
      allowedModels: [],
      ipAllowlist: [],
      budgets: [],
      mcpTools: [],
      repair: [],
      passthroughProviders: [],
    };
    const number = (value: unknown) => (typeof value === 'number' ? value : undefined);
    const inputTokens = number(body.estimatedInputTokens);
    const outputTokens = number(body.maxOutputTokens);
    // The request's `provider` object and `models` array (card 32.1), read exactly like traffic.
    let requestRouting: RequestRouting;
    try {
      requestRouting = routingFromRequest(config.snapshot.routingPolicies, key, body);
    } catch (error) {
      const e = error as DiRouterError;
      return reply.status(e.status).send(e.toOpenAI());
    }
    // Model suffixes (card 31.5), parsed exactly like traffic.
    const suffix = parseModelSuffixes(
      requested,
      (name) => isAutoAlias(name) || config.router.modelsFor(key, name) !== undefined,
    );
    requestRouting = withSuffixes(requestRouting, suffix);
    // Conditional routing rules (card 32.2) with the request attributes the caller describes.
    const strings = (value: unknown, lower = false): Record<string, string> =>
      value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter((e): e is [string, string] => typeof e[1] === 'string')
              .map(([k, v]) => [lower ? k.toLowerCase() : k, v]),
          )
        : {};
    const spent = (body.budget ?? {}) as Record<string, unknown>;
    const budget = {
      key: number(spent.key) ?? 0,
      project: number(spent.project) ?? 0,
      team: number(spent.team) ?? 0,
      max: 0,
    };
    budget.max = Math.max(budget.key, budget.project, budget.team);
    const decision = config.rules.has(key)
      ? config.rules.evaluate(key, {
          request: {
            model: suffix.model,
            api: 'openai.chat',
            stream: body.stream === true,
            headers: strings(body.headers, true),
            metadata: strings(body.metadata),
            estimated_tokens: inputTokens ?? 0,
            max_output_tokens: outputTokens ?? 0,
            user: '',
            has_tools: body.hasTools === true,
            has_images: body.hasImages === true,
          },
          budget,
        })
      : undefined;
    const ruleNames = new Map(config.snapshot.routingRules.map((r) => [r.id, r.name]));
    const rules = decision
      ? {
          matched: decision.matched.map((id) => ({ id, name: ruleNames.get(id) ?? id })),
          ...(decision.decidedBy ? { decidedBy: decision.decidedBy.id } : {}),
          ...(decision.target ? { target: decision.target } : {}),
          ...(Object.keys(decision.tags).length > 0 ? { tags: decision.tags } : {}),
          ...(decision.reject ? { reject: decision.reject } : {}),
        }
      : undefined;
    if (decision?.reject)
      return reply.status(decision.reject.status).send({
        error: { message: decision.reject.message, code: 'routing_rule_reject' },
        rules,
        skipped: [],
      });
    const result = planRoute(config.router, {
      // A rule's target is the organization's choice, not limited by the key's allow-list.
      key: decision?.target ? { ...key, allowedModels: [] } : key,
      model: decision?.target ?? suffix.model,
      fallbackModels: requestRouting.fallbackModels,
      preferences: requestRouting.preferences,
      dataPolicy: requestRouting.dataPolicy,
      freeOnly: suffix.freeOnly,
      resolve: {
        ...(number(body.estimatedInputTokens) !== undefined
          ? { estimatedInputTokens: number(body.estimatedInputTokens) }
          : {}),
        ...(number(body.maxOutputTokens) !== undefined
          ? { maxOutputTokens: number(body.maxOutputTokens) }
          : {}),
        ...(typeof body.sessionKey === 'string' ? { sessionKey: body.sessionKey } : {}),
        ...(typeof body.promptPrefixHash === 'string'
          ? { promptPrefixHash: body.promptPrefixHash }
          : {}),
        ...(body.p2c === true ? { p2c: true } : {}),
        ...(body.preferLastKnownGood === true ? { preferLastKnownGood: true } : {}),
      },
    });
    const routingView = {
      ...(rules ? { rules } : {}),
      ...(requestRouting.preferences ? { preferences: requestRouting.preferences } : {}),
      policy: {
        lockProvider: requestRouting.policy.lockProvider,
        sources: requestRouting.policy.sources,
      },
      ...(requestRouting.clientIgnored ? { clientPreferencesIgnored: true } : {}),
      // The effective data policy (card 32.5): organization, project, key and request combined.
      ...(requestRouting.dataPolicy ? { dataPolicy: requestRouting.dataPolicy } : {}),
      // Suffixes and what they do (card 31.5).
      ...(suffix.suffixes.length > 0
        ? {
            suffixes: suffix.suffixes,
            ...(suffix.reasoningEffort ? { reasoningEffort: suffix.reasoningEffort } : {}),
            ...(suffix.webSearch
              ? { webSearch: onlineAvailable() ? 'available' : 'unavailable' }
              : {}),
          }
        : {}),
    };
    if (suffix.webSearch && !onlineAvailable())
      return reply.status(400).send({
        error: { message: 'web_search_unavailable', code: 'web_search_unavailable' },
        skipped: [],
        ...routingView,
      });
    if (isPlanError(result)) {
      return reply.status(planErrorStatus(result.error)).send({
        error: { message: result.error, code: result.error },
        ...('neededTokens' in result && result.neededTokens !== undefined
          ? { neededTokens: result.neededTokens }
          : {}),
        skipped: result.skipped,
        ...routingView,
      });
    }
    // The routing explanation (card 32.7), built exactly like the x-dirouter-routing header.
    const tier = typeof body.serviceTier === 'string' ? body.serviceTier : undefined;
    const explanation = explainPlan(result, {
      estimatedInputTokens: inputTokens,
      maxOutputTokens: outputTokens,
      priceMultiplier: key.priceMultiplier,
      priced: (m) => ({ ...m, pricing: pricingForServiceTier(m.pricing, tier) }),
      suffixes: suffix.suffixes,
      ...(decision?.decidedBy
        ? { rule: { id: decision.decidedBy.id, name: decision.decidedBy.name } }
        : {}),
    });
    return {
      explanation,
      // When a rule routed elsewhere, `requested` stays the client's name and `resolvedName` says
      // where the rule sent it (card 32.2).
      requested: decision?.target ? suffix.model : result.requested,
      ...(decision?.target ? { resolvedName: result.requested } : {}),
      models: result.models,
      ...routingView,
      kind: result.kind,
      combo: result.combo
        ? { id: result.combo.id, slug: result.combo.slug, strategy: result.combo.strategy }
        : undefined,
      fallbackOn: result.fallbackOn,
      candidates: result.candidates.map((candidate) => {
        const stats = config.router.stats.snapshot(candidate.model.id);
        const needed = (inputTokens ?? 0) + (outputTokens ?? 0);
        const room = headroom(candidate.model, needed);
        return {
          modelId: candidate.model.id,
          model: candidate.model.slug,
          provider: candidate.provider.slug,
          credentialId: candidate.credential.id,
          // The live inputs of the dynamic strategies (card 25.4), so the simulator can show why
          // latency, cost, least-used and headroom ordered the targets the way they did.
          signals: {
            ...(stats.peakLatencyMs !== undefined
              ? { latencyMs: Math.round(stats.peakLatencyMs) }
              : {}),
            costMicroUsd: estimateMicroUsd(candidate.model, inputTokens ?? 0, outputTokens ?? 0),
            recentRequests: stats.recentRequests,
            inFlight: stats.inFlight,
            ...(stats.throughputTps !== undefined
              ? { throughputTps: Math.round(stats.throughputTps * 10) / 10 }
              : {}),
            ...(room !== Number.MAX_SAFE_INTEGER ? { headroomTokens: room } : {}),
          },
        };
      }),
      skipped: result.skipped,
    };
  });

  return {
    app,
    store,
    health,
    metrics,
    limiter: deps.limiter,
    budgets: deps.budgets,
    splits,
    a2a,
    mcp,
    jobs: jobDeps,
    poller,
    realtime,
    async start() {
      if (opts.plugins) {
        const names = enabledPlugins(opts.plugins.enabled);
        for (const plugin of await loadPlugins(opts.plugins.dir, names)) {
          if (plugin.status === 'loaded')
            opts.logger.info(
              { plugin: plugin.name, version: plugin.manifest?.version },
              'provider plugin loaded',
            );
          // A broken plugin is reported and skipped; its providers fall back to other targets.
          else
            opts.logger.error(
              { plugin: plugin.name, error: plugin.error },
              'provider plugin failed to load',
            );
        }
      }
      await store.start();
      if (opts.limiterRedis) deps.limiter.startNodeCount();
      splits.start();
      poller.start();
    },
    /** Number of open proxy requests (including streams). */
    get inFlight() {
      return inFlight;
    },
    /** Exports the spans still buffered in memory (called once the drain is over). */
    /** Last spans, metrics and log records before exit (cards 17.2 and 24.3). */
    flushTraces: () => Promise.all([deps.tracer.shutdown(), otlp.shutdown()]).then(() => undefined),
    otlp,
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
      void poller.stop();
      deps.limiter.stop();
      await sleep(options.readyDelayMs);
      const closing = app.close();
      const deadline = Date.now() + options.drainMs;
      // Open realtime sessions (card 30.5) are waited for like streams.
      while (inFlight + realtime.size > 0 && Date.now() < deadline) {
        // A keep-alive connection whose response is finished and is idle; closing it is safe.
        app.server.closeIdleConnections();
        await sleep(50);
      }
      const forced = inFlight + realtime.size;
      if (forced > 0) {
        opts.logger.warn(
          { inFlight, realtimeSessions: realtime.size },
          'drain timeout, aborting open requests',
        );
        shutdown.abort(new Error('gateway shutting down'));
        // A short window to write the error event or 503 before connections are closed; a
        // realtime session also gets to finish (or cancel and bill) its response in progress.
        const grace =
          Date.now() + 1_000 + (realtime.size > 0 ? 2 * realtime.settings.closeGraceMs + 1_000 : 0);
        while (inFlight + realtime.size > 0 && Date.now() < grace) await sleep(20);
      }
      app.server.closeAllConnections();
      await Promise.race([closing, sleep(2_000)]);
      return { forced };
    },
  };
}
