import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { USAGE_EVENT_SCHEMA_VERSION, type UsageEvent } from '@dirouter/contracts';
import { createLogger } from '@dirouter/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { outboxFiles, type UsageQueue, UsageSink } from './usage-sink.js';

const logger = createLogger({ service: 'test', level: 'silent' });

const event = (n: number): UsageEvent => ({
  schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
  eventId: `01JABCDEFGHJKMNPQRSTVW${String(n).padStart(4, '0')}`,
  idempotencyKey: `req_${String(n)}`,
  requestId: `req_${String(n)}`,
  occurredAt: new Date(1_800_000_000_000 + n).toISOString(),
  gatewayInstance: 'gw',
  configVersion: 1,
  organizationId: 'org',
  teamId: null,
  projectId: 'prj',
  virtualKeyId: 'vk',
  inboundApi: 'openai.chat',
  requestedModel: 'm',
  resolvedModelId: 'm',
  providerId: 'p',
  credentialId: 'c',
  stream: false,
  status: 'success',
  httpStatus: 200,
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
  costUsd: '0.00000100',
  usageEstimated: false,
  latencyMs: 1,
  attempts: [],
});

/** صف ساختگی با رفتار jobId یکتای BullMQ و قابلیت قطع. */
class FakeQueue implements UsageQueue {
  up = true;
  jobs = new Map<string, UsageEvent>();
  order: string[] = [];
  addBulk(jobs: { data: UsageEvent; opts: { jobId: string } }[]) {
    if (!this.up) return Promise.reject(new Error('Connection is closed.'));
    for (const j of jobs) {
      if (this.jobs.has(j.opts.jobId)) continue;
      this.jobs.set(j.opts.jobId, j.data);
      this.order.push(j.opts.jobId);
    }
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-sink-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('usage sink', () => {
  it('batches events into the queue with the idempotency key as job id', async () => {
    const queue = new FakeQueue();
    const sink = new UsageSink({ logger, dataDir: dir, queue, flushIntervalMs: 60_000 });
    for (let i = 0; i < 5; i++) sink.emit(event(i));
    sink.emit(event(2)); // تکراری
    await sink.flush();
    expect(queue.order).toEqual(['req_0', 'req_1', 'req_2', 'req_3', 'req_4']);
    expect(sink.stats).toMatchObject({ emitted: 6, enqueued: 6, spooled: 0 });
    await sink.close();
  });

  it('spools to the outbox during an outage and replays in order without loss', async () => {
    const queue = new FakeQueue();
    const sink = new UsageSink({
      logger,
      dataDir: dir,
      queue,
      flushIntervalMs: 60_000,
      batchSize: 7,
    });
    sink.emit(event(0));
    await sink.flush();

    queue.up = false;
    for (let i = 1; i <= 100; i++) {
      sink.emit(event(i));
      if (i % 10 === 0) await sink.flush();
    }
    await sink.flush();
    expect(queue.jobs.size).toBe(1);
    const files = await outboxFiles(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, 'outbox', files[0] ?? ''), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(100);
    expect(await sink.backlogSize()).toBe(100);

    queue.up = true;
    sink.emit(event(101));
    await sink.flush();
    expect(queue.jobs.size).toBe(102);
    expect(queue.order).toEqual(Array.from({ length: 102 }, (_, i) => `req_${String(i)}`));
    expect(await outboxFiles(dir)).toHaveLength(0);
    expect(sink.stats).toMatchObject({ spooled: 100, replayed: 100 });
    expect(await sink.backlogSize()).toBe(0);
    await sink.close();
  });

  it('replays an outbox left by a previous process on start', async () => {
    const down = new FakeQueue();
    down.up = false;
    const first = new UsageSink({ logger, dataDir: dir, queue: down, flushIntervalMs: 60_000 });
    for (let i = 0; i < 3; i++) first.emit(event(i));
    await first.close();
    expect(await outboxFiles(dir)).toHaveLength(1);

    const queue = new FakeQueue();
    const second = new UsageSink({ logger, dataDir: dir, queue, flushIntervalMs: 60_000 });
    await second.flush();
    expect(queue.order).toEqual(['req_0', 'req_1', 'req_2']);
    expect(await outboxFiles(dir)).toHaveLength(0);
    await second.close();
  });

  it('a partial replay is retried and duplicates collapse on job id', async () => {
    const queue = new FakeQueue();
    let calls = 0;
    const flaky: UsageQueue = {
      addBulk: (jobs) => (++calls === 3 ? Promise.reject(new Error('blip')) : queue.addBulk(jobs)),
      close: () => Promise.resolve(),
    };
    queue.up = false;
    const sink = new UsageSink({
      logger,
      dataDir: dir,
      queue: flaky,
      flushIntervalMs: 60_000,
      batchSize: 2,
    });
    for (let i = 0; i < 6; i++) sink.emit(event(i));
    await sink.flush(); // calls 1..3 همه شکست (queue.up=false)
    queue.up = true;
    await sink.flush(); // replay: یک دسته موفق، یک دسته blip → فایل می‌ماند
    await sink.flush(); // replay کامل؛ دستهٔ اول تکراری است
    expect(queue.order).toEqual(['req_0', 'req_1', 'req_2', 'req_3', 'req_4', 'req_5']);
    expect(await outboxFiles(dir)).toHaveLength(0);
    await sink.close();
  });
});

describe('usage sink on a shared outbox volume', () => {
  it('two replicas replay each file exactly once', async () => {
    const down = new FakeQueue();
    down.up = false;
    const writerA = new UsageSink({ logger, dataDir: dir, queue: down, flushIntervalMs: 60_000 });
    for (let i = 0; i < 50; i++) writerA.emit(event(i));
    await writerA.close();

    const queue = new FakeQueue();
    let added = 0;
    const counting: UsageQueue = {
      addBulk: (jobs) => {
        added += jobs.length;
        return queue.addBulk(jobs);
      },
      close: () => Promise.resolve(),
    };
    const opts = {
      logger,
      dataDir: dir,
      queue: counting,
      flushIntervalMs: 60_000,
      claimGraceMs: 20,
    };
    const b = new UsageSink(opts);
    const c = new UsageSink(opts);
    await Promise.all([b.flush(), c.flush()]);
    expect(queue.jobs.size).toBe(50);
    expect(added).toBe(50);
    expect(await outboxFiles(dir)).toHaveLength(0);
    await Promise.all([b.close(), c.close()]);
  });
});
