/** متریک‌های control-api: وضعیت صف‌های BullMQ و زمان درخواست مدیریتی. */
import { Queue } from 'bullmq';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

import { QUEUES } from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

import { createQueueMetrics } from '@dirouter/shared';

export function installControlApiMetrics(
  app: FastifyInstance,
  redis: Redis,
  logger: Logger,
): { close(): Promise<void> } {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'dirouter_control_api_' });
  const queues = Object.values(QUEUES).map(
    (name) => new Queue(name, { connection: redis.duplicate({ enableOfflineQueue: false }) }),
  );
  for (const queue of queues)
    queue.on('error', (error: Error) => {
      logger.debug({ err: error }, 'metrics queue error');
    });
  createQueueMetrics(
    registry,
    queues.map((queue) => ({
      name: queue.name,
      counts: () => queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
    })),
  );
  const duration = new Histogram({
    name: 'dirouter_control_api_request_duration_seconds',
    help: 'Control API request duration',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  app.addHook('onResponse', async (request, reply) => {
    duration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status_code: String(reply.statusCode),
      },
      Math.max(0, reply.elapsedTime / 1_000),
    );
  });
  app.get('/metrics', async (_request, reply) =>
    reply.type(registry.contentType).send(await registry.metrics()),
  );
  return {
    close: async () => {
      await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)));
    },
  };
}
