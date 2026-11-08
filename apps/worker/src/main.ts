/**
 * worker (کارت ۶.۵): مصرف صف usage و نوشتن دسته‌ای در Postgres (کارت ۶.۴)، rollup،
 * پارتیشن و retention با job scheduler، dead-letter برای jobهای ناموفق، و /metrics.
 */
import { createServer } from 'node:http';

import { QUEUES, UsageEvent } from '@dirouter/contracts';
import { createPrismaClient } from '@dirouter/db';
import { createLogger, loadEnvOrExit } from '@dirouter/shared';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { workerEnvSchema } from './env.js';
import {
  DIRTY_HOURS_KEY,
  dropOldPartitions,
  ensurePartitions,
  type MaintenanceDb,
  rollup,
} from './maintenance.js';
import { type BudgetDb, processBudgetAlerts, reconcileBudgets } from './budgets.js';
import { createMetrics } from './metrics.js';
import { type UsageDb, UsageBatchWriter } from './writer.js';

const env = loadEnvOrExit(workerEnvSchema);
const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });
const db = createPrismaClient({
  databaseUrl: env.DATABASE_URL,
  maxConnections: env.DB_MAX_CONNECTIONS,
});
// BullMQ برای Worker به maxRetriesPerRequest=null نیاز دارد (اتصال blocking).
const connection = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null });
connection.on('error', (error: Error) => {
  logger.warn({ err: error }, 'valkey connection error');
});

const usageQueue = new Queue(QUEUES.usage, { connection });
const deadQueue = new Queue(QUEUES.usageDead, { connection });
const maintenanceQueue = new Queue(QUEUES.maintenance, { connection });
const metrics = createMetrics(
  [usageQueue, deadQueue, maintenanceQueue].map((q) => ({
    name: q.name,
    counts: () => q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
  })),
);

const writer = new UsageBatchWriter({
  db: db as unknown as UsageDb,
  logger,
  batchSize: env.USAGE_BATCH_SIZE,
  flushMs: env.USAGE_FLUSH_MS,
  onWritten: async (hours, count) => {
    metrics.usageWritten.inc(count);
    await connection.sadd(DIRTY_HOURS_KEY, ...hours);
  },
});

const usageWorker = new Worker(
  QUEUES.usage,
  async (job: Job) => {
    const parsed = UsageEvent.safeParse(job.data);
    // رویداد نامعتبر با retry درست نمی‌شود: مستقیم به dead-letter.
    if (!parsed.success)
      throw new UnrecoverableError(`invalid usage event: ${parsed.error.message}`);
    try {
      await writer.add(parsed.data);
    } catch (error) {
      metrics.usageFailed.inc();
      throw error;
    }
  },
  { connection, concurrency: env.USAGE_CONCURRENCY },
);

usageWorker.on('failed', (job, error) => {
  if (!job) return;
  const final = error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!final) return;
  metrics.usageDead.inc();
  logger.error({ err: error, jobId: job.id }, 'usage event moved to dead-letter queue');
  void deadQueue
    .add(
      'dead',
      { event: job.data as unknown, error: error.message, failedAt: new Date().toISOString() },
      { ...(job.id ? { jobId: job.id } : {}), removeOnComplete: false, removeOnFail: false },
    )
    .catch((err: unknown) => {
      logger.error({ err }, 'failed to write dead-letter job');
    });
});
usageWorker.on('error', (error) => {
  logger.warn({ err: error }, 'usage worker error');
});

const mdb = db as unknown as MaintenanceDb;
const jobs: Record<string, () => Promise<unknown>> = {
  rollup: () => rollup(mdb, connection, logger),
  partitions: () => ensurePartitions(mdb, 3),
  retention: () => dropOldPartitions(mdb, env.REQUEST_LOG_RETENTION_MONTHS),
  'budget-alerts': () => processBudgetAlerts(db as unknown as BudgetDb, connection, logger),
  'budget-reconcile': () => reconcileBudgets(db as unknown as BudgetDb, connection, logger),
};

const maintenanceWorker = new Worker(
  QUEUES.maintenance,
  async (job: Job) => {
    const run = jobs[job.name];
    if (!run) throw new UnrecoverableError(`unknown maintenance job ${job.name}`);
    const end = metrics.jobDuration.startTimer({ job: job.name });
    try {
      const result = await run();
      end({ outcome: 'success' });
      logger.info(
        { job: job.name, result, instance: process.env.HOSTNAME },
        'maintenance job done',
      );
      return result;
    } catch (error) {
      end({ outcome: 'error' });
      throw error;
    }
  },
  { connection, concurrency: 1 },
);
maintenanceWorker.on('failed', (job, error) => {
  logger.error({ err: error, job: job?.name }, 'maintenance job failed');
});

// upsert در هر replica بی‌خطر است: scheduler یکی است و هر tick یک job می‌سازد.
const schedule = {
  rollup: { every: env.ROLLUP_INTERVAL_MS },
  partitions: { every: 3_600_000 },
  retention: { pattern: '17 3 * * *', tz: 'UTC' },
  'budget-alerts': { every: 10_000 },
  'budget-reconcile': { every: 300_000 },
};
for (const [name, repeat] of Object.entries(schedule)) {
  await maintenanceQueue.upsertJobScheduler(name, repeat, {
    name,
    opts: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
}

async function ready(): Promise<boolean> {
  try {
    await Promise.all([db.$queryRawUnsafe('SELECT 1'), connection.ping()]);
    return true;
  } catch {
    return false;
  }
}

const health = createServer((req, res) => {
  const send = (status: number, body: string, type = 'application/json') =>
    res.writeHead(status, { 'content-type': type }).end(body);
  if (req.url === '/healthz') return send(200, '{"status":"ok"}');
  if (req.url === '/readyz') {
    void ready().then((ok) => send(ok ? 200 : 503, JSON.stringify({ status: ok ? 'ok' : 'down' })));
    return;
  }
  if (req.url === '/metrics') {
    void metrics.registry
      .metrics()
      .then((body) => send(200, body, metrics.registry.contentType))
      .catch(() => send(500, ''));
    return;
  }
  send(404, '{}');
});
health.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'worker started');
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    // jobهای فعال تمام می‌شوند (writer بافر را می‌نویسد)، بعد اتصال‌ها بسته می‌شوند.
    void Promise.all([usageWorker.close(), maintenanceWorker.close(), writer.drain()])
      .then(() => Promise.all([usageQueue.close(), deadQueue.close(), maintenanceQueue.close()]))
      .then(() => db.$disconnect())
      .finally(() => {
        connection.disconnect();
        health.close(() => process.exit(0));
      });
  });
}
