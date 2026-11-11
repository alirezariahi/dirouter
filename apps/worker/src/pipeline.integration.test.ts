/**
 * Integration test of the usage pipeline against real Postgres and Valkey (cards 3.2, 6.4 and 6.5).
 * Runs only with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL set (the integration job in CI
 * or manually: `make test-integration`).
 */
import { QUEUES, USAGE_EVENT_SCHEMA_VERSION, type UsageEvent } from '@dirouter/contracts';
import { createPrismaClient } from '@dirouter/db';
import { createLogger } from '@dirouter/shared';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DIRTY_HOURS_KEY,
  dropOldPartitions,
  ensurePartitions,
  type MaintenanceDb,
  rollup,
} from './maintenance.js';
import { type UsageDb, UsageBatchWriter } from './writer.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const logger = createLogger({ service: 'test', level: 'silent' });
const ORG = 'org_it';
const RUN = Date.now().toString(36);

const event = (n: number, at: string, status: 'success' | 'error' = 'success'): UsageEvent => ({
  schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
  eventId: `01JABCDEFGHJKMNPQRSTV${String(n).padStart(5, '0')}`,
  idempotencyKey: `req_${RUN}_${String(n)}`,
  requestId: `req_${RUN}_${String(n)}`,
  occurredAt: at,
  gatewayInstance: 'gw-it',
  configVersion: 1,
  organizationId: ORG,
  teamId: null,
  projectId: 'prj_it',
  virtualKeyId: 'vk_it',
  inboundApi: 'openai.chat',
  requestedModel: 'gpt-it',
  resolvedModelId: 'm_it',
  providerId: 'p_it',
  credentialId: 'c_it',
  stream: false,
  status,
  httpStatus: status === 'success' ? 200 : 502,
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
  costUsd: '0.00012345',
  usageEstimated: false,
  latencyMs: 300 + n,
  attempts: [],
});

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('usage pipeline on real services', () => {
  const db = createPrismaClient({ databaseUrl: DATABASE_URL ?? '', maxConnections: 4 });
  const redis = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: null });
  const prefix = `it-${RUN}`;
  let queue: Queue;
  let worker: Worker;
  let writer: UsageBatchWriter;

  beforeAll(async () => {
    await db.$executeRawUnsafe('TRUNCATE request_log, usage_ledger, usage_hourly, usage_daily');
    await db.organization.upsert({
      where: { id: ORG },
      create: { id: ORG, name: 'Integration', slug: 'integration' },
      update: {},
    });
    await redis.del(DIRTY_HOURS_KEY);
    queue = new Queue(QUEUES.usage, { connection: redis, prefix });
    writer = new UsageBatchWriter({
      db: db as unknown as UsageDb,
      logger,
      batchSize: 200,
      flushMs: 50,
      onWritten: async (hours) => {
        await redis.sadd(DIRTY_HOURS_KEY, ...hours);
      },
    });
    worker = new Worker(QUEUES.usage, (job) => writer.add(job.data as UsageEvent), {
      connection: redis,
      prefix,
      concurrency: 100,
    });
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.del(DIRTY_HOURS_KEY);
    redis.disconnect();
    await db.$disconnect();
  });

  it('writes each event once even when it is sent twice', async () => {
    const hour = new Date();
    hour.setUTCMinutes(10, 0, 0);
    const events = Array.from({ length: 300 }, (_, i) =>
      event(
        i,
        new Date(hour.getTime() + i * 1000).toISOString(),
        i % 10 === 0 ? 'error' : 'success',
      ),
    );
    const jobs = (list: UsageEvent[]) =>
      list.map((data) => ({ name: 'usage', data, opts: { jobId: data.idempotencyKey } }));
    await queue.addBulk(jobs(events));
    await queue.addBulk(jobs(events.slice(0, 50))); // duplicate in the queue
    for (let i = 0; i < 100; i++) {
      if ((await db.requestLog.count()) >= 300) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // a duplicate after job completion (e.g. a late outbox replay) also does not create a new record.
    await Promise.all(events.slice(0, 20).map((e) => writer.add(e)));
    expect(await db.requestLog.count()).toBe(300);
    expect(await db.usageLedger.count()).toBe(300);
  });

  it('rolls the hour and the day up exactly once, however often it runs', async () => {
    await rollup(db, redis, logger);
    await rollup(db, redis, logger);
    const hourly = await db.usageHourly.findMany({ where: { organizationId: ORG } });
    const totalRequests = hourly.reduce((n, r) => n + r.requests, 0);
    const totalErrors = hourly.reduce((n, r) => n + r.errors, 0);
    expect(totalRequests).toBe(300);
    expect(totalErrors).toBe(30);
    expect(hourly.reduce((n, r) => n + Number(r.inputTokens), 0)).toBe(30_000);
    const hist = hourly[0]?.latencyHist ?? [];
    expect(hist).toHaveLength(10);
    const daily = await db.usageDaily.findMany({ where: { organizationId: ORG } });
    expect(daily.reduce((n, r) => n + r.requests, 0)).toBe(300);
    expect(daily.reduce((n, r) => n + Number(r.costUsd), 0)).toBeCloseTo(300 * 0.00012345, 8);
    expect(await redis.scard(DIRTY_HOURS_KEY)).toBe(0);
  });

  it('creates the coming months and drops expired partitions', async () => {
    await ensurePartitions(db, 3);
    const names = async () =>
      (
        await db.$queryRawUnsafe<{ name: string }[]>(
          `SELECT c.relname::text AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'public.request_log'::regclass`,
        )
      ).map((r) => r.name);
    const month = (offset: number) => {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + offset);
      return `request_log_${String(d.getUTCFullYear())}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    expect(await names()).toEqual(expect.arrayContaining([month(0), month(1), month(2), month(3)]));

    await db.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS partitions.request_log_2020_01 PARTITION OF request_log
       FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')`,
    );
    expect(await dropOldPartitions(db as unknown as MaintenanceDb, 3)).toBeGreaterThanOrEqual(1);
    expect(await names()).not.toContain('request_log_2020_01');
    expect(await names()).toContain(month(0));
  });
});
