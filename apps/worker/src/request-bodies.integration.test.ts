/**
 * Request bodies against real Postgres and Valkey (card 24.1): the queue is written once per
 * request, day partitions are created ahead, and body retention runs on its own clock without
 * touching request_log. Runs only with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL set.
 */
import { REQUEST_BODIES_QUEUE, type RequestBodyRecordInput } from '@dirouter/contracts';
import { createPrismaClient } from '@dirouter/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MaintenanceDb } from './maintenance.js';
import {
  type BodyDb,
  dropOldBodyPartitions,
  ensureBodyPartitions,
  writeRequestBody,
} from './request-bodies.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const RUN = Date.now().toString(36);
const DAY = 86_400_000;

const record = (id: string, createdAt: Date): RequestBodyRecordInput => ({
  requestId: `req_${RUN}_${id}`,
  createdAt: createdAt.toISOString(),
  organizationId: 'org_bodies',
  projectId: 'prj_bodies',
  apiKeyId: 'vk_bodies',
  inboundApi: 'openai.chat',
  level: 'full',
  metadata: {
    model: 'm',
    parameters: [],
    messages: 1,
    roles: { user: 1 },
    tools: [],
    requestBytes: 20,
    responseBytes: 30,
  },
  request: '{"messages":[{"role":"user","content":"[REDACTED]"}]}',
  response: '{"choices":[]}',
  redactions: 1,
  replay: { history: [], prompt: '[REDACTED]', lossy: false },
});

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('request bodies on real services', () => {
  const db = createPrismaClient({ databaseUrl: DATABASE_URL ?? '', maxConnections: 4 });
  const redis = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: null });
  const prefix = `it-bodies-${RUN}`;
  const mdb = db as unknown as MaintenanceDb;
  let queue: Queue;
  let worker: Worker;

  beforeAll(async () => {
    await db.$executeRawUnsafe('TRUNCATE request_bodies');
    queue = new Queue(REQUEST_BODIES_QUEUE, { connection: redis, prefix });
    worker = new Worker(REQUEST_BODIES_QUEUE, (job) => writeRequestBody(db, job.data), {
      connection: redis,
      prefix,
      concurrency: 4,
    });
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    redis.disconnect();
    await db.$disconnect();
  });

  it('writes a queued body once, even when sent twice', async () => {
    const body = record('once', new Date());
    await queue.add('body', body, { jobId: body.requestId });
    // A second send after the first was written: the row is skipped as a duplicate.
    for (let i = 0; i < 100; i++) {
      if ((await db.requestBody.count({ where: { requestId: body.requestId } })) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await writeRequestBody(db as unknown as BodyDb, body)).toBe(false);
    const rows = await db.requestBody.findMany({ where: { requestId: body.requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'full', redactions: 1, requestTruncated: false });
    expect(rows[0]?.replay).toEqual({ history: [], prompt: '[REDACTED]', lossy: false });
  });

  it('rejects a malformed record instead of writing it', async () => {
    await expect(writeRequestBody(db as unknown as BodyDb, { requestId: 'x' })).rejects.toThrow();
  });

  it('creates day partitions ahead and keeps bodies for their own retention only', async () => {
    await ensureBodyPartitions(mdb, 3);
    const parts = await db.$queryRawUnsafe<{ name: string }[]>(
      `SELECT c.relname::text AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'public.request_bodies'::regclass ORDER BY 1`,
    );
    const today = new Date().toISOString().slice(0, 10).replaceAll('-', '_');
    expect(parts.map((p) => p.name)).toContain(`request_bodies_${today}`);

    // Old bodies land in the default partition (no day partition exists for them); recent ones in
    // their own day. A request_log row of the same age must survive body retention.
    const old = record('old', new Date(Date.now() - 10 * DAY));
    const recent = record('recent', new Date(Date.now() - DAY));
    await writeRequestBody(db, old);
    await writeRequestBody(db, recent);
    await db.$executeRawUnsafe(`SELECT dirouter_ensure_request_log_partitions(3)`);
    await db.$executeRawUnsafe(
      `INSERT INTO request_log (id, created_at, organization_id, project_id, api_key_id, inbound_api,
         requested_model, stream, status, http_status, input_tokens, output_tokens, cost_usd,
         latency_ms, config_version, gateway_instance)
       VALUES ($1, $2, 'org_bodies', 'prj_bodies', 'vk_bodies', 'openai.chat', 'm', false,
         'success', 200, 1, 1, 0, 1, 1, 'gw') ON CONFLICT DO NOTHING`,
      old.requestId,
      new Date(old.createdAt),
    );

    await dropOldBodyPartitions(mdb, 7);
    const left = await db.requestBody.findMany({
      where: { requestId: { in: [old.requestId, recent.requestId] } },
      select: { requestId: true },
    });
    expect(left.map((r) => r.requestId)).toEqual([recent.requestId]);
    expect(await db.requestLog.count({ where: { id: old.requestId } })).toBe(1);
    await db.$executeRawUnsafe(`DELETE FROM request_log WHERE id = $1`, old.requestId);
  });

  it('drops whole day partitions past the retention', async () => {
    // A partition for a day 20 days back, created by hand, goes on the next retention run.
    const day = new Date(Date.now() - 20 * DAY);
    const name = `request_bodies_${day.toISOString().slice(0, 10).replaceAll('-', '_')}`;
    const from = day.toISOString().slice(0, 10);
    const to = new Date(day.getTime() + DAY).toISOString().slice(0, 10);
    await db.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS partitions.${name} PARTITION OF request_bodies
       FOR VALUES FROM ('${from} 00:00:00+00') TO ('${to} 00:00:00+00')`,
    );
    expect(await dropOldBodyPartitions(mdb, 7)).toBeGreaterThanOrEqual(1);
    const exists = await db.$queryRawUnsafe<{ r: string | null }[]>(
      `SELECT to_regclass('partitions.${name}')::text AS r`,
    );
    expect(exists[0]?.r).toBeNull();
  });
});
