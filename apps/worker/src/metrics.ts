/** متریک‌های Prometheus worker (کارت ۶.۵): طول صف‌ها، نوشتن مصرف و کارهای نگهداری. */
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

export interface QueueCounts {
  name: string;
  counts(): Promise<Record<string, number>>;
}

export function createMetrics(queues: QueueCounts[]) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'dirouter_worker_' });

  new Gauge({
    name: 'dirouter_queue_jobs',
    help: 'Jobs per BullMQ queue and state',
    labelNames: ['queue', 'state'],
    registers: [registry],
    async collect() {
      for (const q of queues) {
        try {
          for (const [state, n] of Object.entries(await q.counts())) {
            this.set({ queue: q.name, state }, n);
          }
        } catch {
          // Valkey در دسترس نیست؛ مقدار قبلی می‌ماند و dirouter_worker_up نشان می‌دهد.
        }
      }
    },
  });

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
      name: 'dirouter_maintenance_job_seconds',
      help: 'Maintenance job duration',
      labelNames: ['job', 'outcome'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120],
      registers: [registry],
    }),
  };
}
export type WorkerMetrics = ReturnType<typeof createMetrics>;
