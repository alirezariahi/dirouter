import { hostname } from 'node:os';

import {
  baseEnvSchema,
  connectValkey,
  createLogger,
  envBoolean,
  envKeyring,
  envPort,
  loadEnvOrExit,
} from '@dirouter/shared';
import { Redis } from 'ioredis';
import { z } from 'zod';

import { HealthProber } from './health-probe.js';
import { HealthSync } from './health-sync.js';
import { storageFromEnv } from './jobs/blobs.js';
import { buildGateway } from './server.js';
import { UsageSink } from './usage-sink.js';
import { McpCallSink } from './mcp/call-sink.js';
import { BodySink } from './body-capture.js';
import { OtlpLogBuffer } from './otlp-export.js';
import { LivePublisher } from './live.js';

const quiet = (r: Redis) => {
  r.on('error', () => undefined);
  return r;
};

const env = loadEnvOrExit(
  baseEnvSchema.extend({
    PORT: envPort(8787),
    MASTER_KEY: envKeyring(),
    KEY_PEPPER: z.string().min(32),
    INTERNAL_TOKEN: z.string().min(32).optional(),
    CONTROL_API_URL: z.string().optional(),
    DATA_DIR: z.string().default('./.data'),
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(30_000),
    /** Pause after readyz=503 so Traefik (health check every 2 seconds) takes this replica out of rotation. */
    SHUTDOWN_READY_DELAY_MS: z.coerce.number().int().min(0).default(5_000),
    VALKEY_URL: z.string().optional(),
    /** Provider plugins (card 21.2): folder, and the names to load (none by default). */
    PLUGINS_DIR: z.string().default('./plugins'),
    PLUGINS_ENABLED: z.string().default(''),
    /** Files and batches (card 30.1): where bytes are kept, upload cap, retention, polling. */
    FILES_STORAGE: z.enum(['local', 's3']).default('local'),
    FILES_DIR: z.string().optional(),
    FILES_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(512 * 1024 * 1024)
      .default(100 * 1024 * 1024),
    FILES_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    FILES_S3_ENDPOINT: z.string().optional(),
    FILES_S3_BUCKET: z.string().optional(),
    FILES_S3_REGION: z.string().default('us-east-1'),
    FILES_S3_ACCESS_KEY_ID: z.string().optional(),
    FILES_S3_SECRET_ACCESS_KEY: z.string().optional(),
    FILES_S3_PREFIX: z.string().optional(),
    FILES_S3_PATH_STYLE: envBoolean(true),
    JOBS_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15_000),
    /** Realtime sessions (card 30.5): longest session, and open sessions per replica. */
    REALTIME_MAX_SESSION_SECONDS: z.coerce.number().int().min(10).default(1_800),
    REALTIME_MAX_SESSIONS: z.coerce.number().int().min(0).default(1_000),
  }),
);
// Every log line also feeds the OTLP log export (card 24.3); the buffer ignores lines while that
// export is off in the settings.
const otlpLogs = new OtlpLogBuffer();
const logger = createLogger({
  service: 'gateway',
  level: env.LOG_LEVEL,
  destination: {
    write(line: string) {
      process.stdout.write(line);
      otlpLogs.push(line);
    },
  },
});

// Without Valkey (e.g. a local single-file run) events are only logged.
const usageSink = env.VALKEY_URL
  ? new UsageSink({ logger, dataDir: env.DATA_DIR, valkeyUrl: env.VALKEY_URL })
  : undefined;

// Breaker state sync between replicas; the subscribe connection must be separate (pub/sub mode).
// The publisher connection also writes breaker state for the worker's alert rules (card 24.2).
const healthPublisher = env.VALKEY_URL
  ? quiet(
      connectValkey(Redis, env.VALKEY_URL, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      }),
    )
  : undefined;
const healthSync =
  env.VALKEY_URL && healthPublisher
    ? new HealthSync({
        instance: `${hostname()}-${String(process.pid)}`,
        logger,
        publisher: healthPublisher,
        store: healthPublisher,
        subscriber: quiet(connectValkey(Redis, env.VALKEY_URL, { maxRetriesPerRequest: null })),
      })
    : undefined;

const mcpCalls = env.VALKEY_URL ? new McpCallSink(env.VALKEY_URL, logger) : undefined;
// Captured request bodies (card 24.1) have their own queue; they never ride on usage events.
const bodies = env.VALKEY_URL ? new BodySink(env.VALKEY_URL, logger) : undefined;
// Live view over SSE (card 24.4): each finished request is published for control-api.
const live = env.VALKEY_URL ? new LivePublisher(env.VALKEY_URL) : undefined;

const gateway = buildGateway({
  logger,
  otlpLogs,
  ...(mcpCalls
    ? {
        recordMcpCall: (call) => {
          mcpCalls.record(call);
        },
      }
    : {}),
  ...(bodies
    ? {
        recordBody: (record) => {
          bodies.record(record);
        },
      }
    : {}),
  ...(usageSink ? { outbox: usageSink } : {}),
  onRequestComplete: (event) => {
    live?.publish(event);
    // Allowlist: no organization/project/key/endUser, text errors, prompt or secret.
    logger.info(
      {
        requestId: event.requestId,
        status: event.status,
        httpStatus: event.httpStatus,
        provider: event.providerId,
        model: event.resolvedModelId ?? event.requestedModel,
        stream: event.stream,
        latencyMs: event.latencyMs,
        ttftMs: event.ttftMs,
        attempts: event.attempts.length,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      },
      'request completed',
    );
  },
  ...(healthSync
    ? {
        onHealthChange: (change) => {
          healthSync.publish(change);
        },
      }
    : {}),
  ...(usageSink
    ? {
        emitUsage: (event) => {
          usageSink.emit(event);
        },
      }
    : {}),
  keyring: env.MASTER_KEY,
  pepper: env.KEY_PEPPER,
  dataDir: env.DATA_DIR,
  plugins: { dir: env.PLUGINS_DIR, enabled: env.PLUGINS_ENABLED },
  jobs: {
    storage: storageFromEnv(env, env.DATA_DIR),
    maxFileBytes: env.FILES_MAX_BYTES,
    fileRetentionSeconds: env.FILES_RETENTION_DAYS * 86_400,
    pollIntervalMs: env.JOBS_POLL_INTERVAL_MS,
  },
  blockPrivateUpstreams: env.NODE_ENV === 'production',
  realtime: {
    maxSessionSeconds: env.REALTIME_MAX_SESSION_SECONDS,
    maxSessions: env.REALTIME_MAX_SESSIONS,
  },
  ...(env.CONTROL_API_URL ? { controlApiUrl: env.CONTROL_API_URL } : {}),
  ...(env.INTERNAL_TOKEN ? { internalToken: env.INTERNAL_TOKEN } : {}),
  // Separate connection with offline queue disabled: during a Valkey outage commands fail immediately and the local limiter takes over.
  ...(env.VALKEY_URL
    ? {
        limiterRedis: quiet(
          connectValkey(Redis, env.VALKEY_URL, {
            enableOfflineQueue: false,
            maxRetriesPerRequest: 0,
          }),
        ),
      }
    : {}),
});
await gateway.start();
await healthSync?.start(gateway.health);
// Periodic upstream probes (card 12.3). The loop is always armed but does nothing until
// `settings.healthProbe.enabled` is set in a snapshot, so it can be switched on from the dashboard.
const prober = new HealthProber({
  snapshot: () => gateway.store.current?.snapshot,
  health: gateway.health,
  keyring: env.MASTER_KEY,
  logger,
  instance: `${hostname()}-${String(process.pid)}`,
  ...(env.VALKEY_URL
    ? {
        redis: quiet(
          connectValkey(Redis, env.VALKEY_URL, {
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
          }),
        ),
      }
    : {}),
});
prober.start();
// Node heartbeat for the Health page (card 7.8): config version and readiness of each replica, expiring after 15 seconds.
if (env.VALKEY_URL) {
  const beat = quiet(
    connectValkey(Redis, env.VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }),
  );
  const instance = hostname();
  const startedAt = new Date().toISOString();
  const tick = () => {
    void beat
      .set(
        `dirouter:gateway:node:${instance}`,
        JSON.stringify({
          instance,
          startedAt,
          lastSeen: new Date().toISOString(),
          configVersion: gateway.store.current?.version ?? 0,
          ready: gateway.store.ready,
          controlApiSync: gateway.store.lastSyncOk,
        }),
        'PX',
        15_000,
      )
      .catch(() => undefined);
  };
  tick();
  setInterval(tick, 5_000).unref();
}

// Immediate application of dashboard changes: control-api publishes on this channel after each new version
// (cards 3.9 and 4.2); periodic polling with ETag is the fallback when Valkey is down.
if (env.VALKEY_URL) {
  const configSub = quiet(connectValkey(Redis, env.VALKEY_URL, { maxRetriesPerRequest: null }));
  configSub.on('message', () => {
    void gateway.store.sync();
  });
  await configSub.subscribe('dirouter:config:updated').catch(() => undefined);
}
await gateway.app.listen({ port: env.PORT, host: '0.0.0.0' });
logger.info(
  { port: env.PORT, configVersion: gateway.store.current?.version ?? 0 },
  'gateway listening',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'draining');
    prober.stop();
    void gateway
      .drain({ readyDelayMs: env.SHUTDOWN_READY_DELAY_MS, drainMs: env.SHUTDOWN_DRAIN_MS })
      .then(({ forced }) => {
        logger.info({ forced }, 'drained');
      })
      // Events for the last requests are sent (or written to the outbox) before exit.
      // The last batch of spans is exported before exit (card 17.2).
      .then(() => gateway.flushTraces())
      .then(() => usageSink?.close())
      .then(() => bodies?.close())
      .then(() => live?.close())
      .then(() => process.exit(0));
  });
}
