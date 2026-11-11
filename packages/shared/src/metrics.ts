/** BullMQ metrics shared by control-api and worker; the scrape has a timeout when Valkey is down. */
import { Gauge, type Registry } from 'prom-client';

export interface QueueCounts {
  name: string;
  counts(): Promise<Record<string, number>>;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('metric collection timed out'));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createQueueMetrics(
  registry: Registry,
  queues: QueueCounts[],
  options: { timeoutMs?: number } = {},
) {
  const available = new Gauge({
    name: 'dirouter_queue_metrics_up',
    help: 'Whether the latest queue-state collection succeeded (1) or failed (0)',
    registers: [registry],
  });
  const jobs = new Gauge({
    name: 'dirouter_queue_jobs',
    help: 'Jobs per BullMQ queue and state',
    labelNames: ['queue', 'state'],
    registers: [registry],
    async collect() {
      let failures = 0;
      await Promise.all(
        queues.map(async (q) => {
          try {
            const counts = await withTimeout(q.counts(), options.timeoutMs ?? 2_000);
            for (const [state, n] of Object.entries(counts)) jobs.set({ queue: q.name, state }, n);
          } catch {
            failures += 1;
          }
        }),
      );
      available.set(failures === 0 ? 1 : 0);
    },
  });
  return { jobs, available };
}
