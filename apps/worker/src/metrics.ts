/** Prometheus metrics for the worker (card 6.5): usage writes and maintenance jobs. */
import { createQueueMetrics, type QueueCounts } from '@dirouter/shared';
import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export function createMetrics(queues: QueueCounts[]) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'dirouter_worker_' });
  createQueueMetrics(registry, queues);

  return {
    registry,
    usageWritten: new Counter({
      name: 'dirouter_usage_events_written_total',
      help: 'Usage events committed to request_log',
      registers: [registry],
    }),
    usageFailed: new Counter({
      name: 'dirouter_usage_events_failed_total',
      help: 'Usage events that failed a write attempt',
      registers: [registry],
    }),
    usageDead: new Counter({
      name: 'dirouter_usage_events_dead_total',
      help: 'Usage events moved to the dead-letter queue',
      registers: [registry],
    }),
    jobDuration: new Histogram({
      name: 'dirouter_worker_job_duration_seconds',
      help: 'BullMQ usage and maintenance job duration',
      labelNames: ['job', 'outcome'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120],
      registers: [registry],
    }),
  };
}
export type WorkerMetrics = ReturnType<typeof createMetrics>;
