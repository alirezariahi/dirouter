import { hostname } from 'node:os';

import { baseEnvSchema, createLogger, envKeyring, envPort, loadEnvOrExit } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { z } from 'zod';

import { HealthSync } from './health-sync.js';
import { buildGateway } from './server.js';
import { UsageSink } from './usage-sink.js';

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
  }),
);
const logger = createLogger({ service: 'gateway', level: env.LOG_LEVEL });

// Without Valkey (e.g. a local single-file run) events are only logged.
const usageSink = env.VALKEY_URL
  ? new UsageSink({ logger, dataDir: env.DATA_DIR, valkeyUrl: env.VALKEY_URL })
  : undefined;

// Breaker state sync between replicas; the subscribe connection must be separate (pub/sub mode).
const healthSync = env.VALKEY_URL
  ? new HealthSync({
      instance: `${hostname()}-${String(process.pid)}`,
      logger,
      publisher: quiet(
        new Redis(env.VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }),
      ),
      subscriber: quiet(new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null })),
    })
  : undefined;

const gateway = buildGateway({
  logger,
  ...(usageSink ? { outbox: usageSink } : {}),
  onRequestComplete: (event) => {
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
  ...(env.CONTROL_API_URL ? { controlApiUrl: env.CONTROL_API_URL } : {}),
  ...(env.INTERNAL_TOKEN ? { internalToken: env.INTERNAL_TOKEN } : {}),
  // Separate connection with offline queue disabled: during a Valkey outage commands fail immediately and the local limiter takes over.
  ...(env.VALKEY_URL
    ? {
        limiterRedis: quiet(
          new Redis(env.VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 0 }),
        ),
      }
    : {}),
});
await gateway.start();
await healthSync?.start(gateway.health);
// Node heartbeat for the Health page (card 7.8): config version and readiness of each replica, expiring after 15 seconds.
if (env.VALKEY_URL) {
  const beat = quiet(
    new Redis(env.VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }),
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
  const configSub = quiet(new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null }));
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
    void gateway
      .drain({ readyDelayMs: env.SHUTDOWN_READY_DELAY_MS, drainMs: env.SHUTDOWN_DRAIN_MS })
      .then(({ forced }) => {
        logger.info({ forced }, 'drained');
      })
      // Events for the last requests are sent (or written to the outbox) before exit.
      .then(() => usageSink?.close())
      .then(() => process.exit(0));
  });
}
