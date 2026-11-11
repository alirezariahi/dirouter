/**
 * Sends usage events to a BullMQ queue with a local outbox (card 6.4).
 *
 * - The request path only calls `emit` (synchronous, no I/O); batch sending runs in the background.
 * - If Valkey is unavailable, the batch is written to an append-only file in `<dataDir>/outbox`
 *   and resent in order once Valkey is back.
 * - jobId is the same as idempotencyKey; duplicate sends collapse into one in the queue, and the worker also
 *   does not create duplicate records with ON CONFLICT DO NOTHING.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { QUEUES, type UsageEvent } from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export interface UsageQueue {
  addBulk(jobs: { name: string; data: UsageEvent; opts: UsageJobOptions }[]): Promise<unknown>;
  close(): Promise<void>;
}

export interface UsageSinkOptions {
  logger: Logger;
  dataDir: string;
  /** Ready queue (for tests); otherwise it is built from valkeyUrl. */
  queue?: UsageQueue;
  valkeyUrl?: string;
  flushIntervalMs?: number;
  /** Max size of each batch in addBulk. */
  batchSize?: number;
  /** Pause between claiming a file and reading it, so another replica's in-progress append can finish. */
  claimGraceMs?: number;
}

export interface UsageSinkStats {
  emitted: number;
  enqueued: number;
  spooled: number;
  replayed: number;
  pending: number;
}

export interface UsageJobOptions {
  jobId: string;
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
  removeOnComplete: { count: number };
  removeOnFail: { count: number };
}

/**
 * 8 attempts with exponential backoff (about 4 minutes total) before dead-letter. Completed jobs
 * are kept up to 10,000 entries so a recent duplicate jobId still collapses in the queue.
 */
const JOB_OPTIONS: Omit<UsageJobOptions, 'jobId'> = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 10_000 },
  removeOnFail: { count: 10_000 },
};

const OUTBOX_RE = /^usage-.*\.ndjson$/;
const CLAIMED_RE = /^(usage-.*\.ndjson)\.replaying-(.+)$/;
/** A file claimed by another replica that stays untouched this long means that replica is dead. */
const STALE_CLAIM_MS = 60_000;

export class UsageSink {
  readonly #logger: Logger;
  readonly #dir: string;
  readonly #queue: UsageQueue;
  readonly #redis: Redis | undefined;
  readonly #batchSize: number;
  readonly #claimGraceMs: number;
  readonly #timer: NodeJS.Timeout;
  readonly #owner = `${hostname()}-${String(process.pid)}-${randomUUID()}`;
  #pending: UsageEvent[] = [];
  #chain: Promise<void> = Promise.resolve();
  #outboxFile: string | undefined;
  #hasOutbox = true; // At startup a file may be left over from a previous run.
  readonly stats: UsageSinkStats = { emitted: 0, enqueued: 0, spooled: 0, replayed: 0, pending: 0 };

  constructor(opts: UsageSinkOptions) {
    this.#logger = opts.logger;
    this.#dir = join(opts.dataDir, 'outbox');
    this.#batchSize = opts.batchSize ?? 500;
    this.#claimGraceMs = opts.claimGraceMs ?? 1_000;
    if (opts.queue) {
      this.#queue = opts.queue;
    } else {
      if (!opts.valkeyUrl) throw new Error('valkeyUrl or queue is required');
      // No offline queue: when Valkey is down, commands fail immediately and we fall back to the outbox.
      this.#redis = new Redis(opts.valkeyUrl, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (n) => Math.min(n * 200, 2_000),
      });
      this.#redis.on('error', (error: Error) => {
        this.#logger.debug({ err: error }, 'usage queue connection error');
      });
      const queue = new Queue(QUEUES.usage, { connection: this.#redis });
      queue.on('error', (error: Error) => {
        this.#logger.debug({ err: error }, 'usage queue error');
      });
      this.#queue = queue;
    }
    this.#timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 250);
    this.#timer.unref();
  }

  /** Synchronous, no I/O; never throws. */
  emit(event: UsageEvent): void {
    this.stats.emitted++;
    this.#pending.push(event);
    this.stats.pending = this.#pending.length;
    if (this.#pending.length >= this.#batchSize) void this.flush();
  }

  /** Sends the buffer and (if possible) the outbox; calls run one after another. */
  flush(): Promise<void> {
    this.#chain = this.#chain
      .then(() => this.#flushOnce())
      .catch((error: unknown) => {
        this.#logger.error({ err: error }, 'usage flush failed');
      });
    return this.#chain;
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    await this.flush();
    await this.#queue.close().catch(() => undefined);
    if (this.#redis) this.#redis.disconnect();
  }

  /** Memory buffer events plus remaining NDJSON lines in the outbox; for scraping only. */
  async backlogSize(): Promise<number> {
    let files: string[];
    try {
      files = await readdir(this.#dir);
    } catch {
      return this.#pending.length;
    }
    let persisted = 0;
    for (const name of files) {
      if (!OUTBOX_RE.test(name) && !CLAIMED_RE.test(name)) continue;
      try {
        persisted += (await readFile(join(this.#dir, name), 'utf8'))
          .split('\n')
          .filter(Boolean).length;
      } catch {
        // The file may be claimed/replayed concurrently; the scrape then reads the fresh value.
      }
    }
    return this.#pending.length + persisted;
  }

  async #flushOnce(): Promise<void> {
    const ready = !this.#redis || this.#redis.status === 'ready';
    if (ready && this.#hasOutbox) await this.#replayOutbox();
    while (this.#pending.length > 0) {
      const batch = this.#pending.splice(0, this.#batchSize);
      this.stats.pending = this.#pending.length;
      // Until the outbox is empty, new events also go to the outbox to preserve order.
      if (ready && !this.#hasOutbox && (await this.#enqueue(batch))) {
        this.stats.enqueued += batch.length;
      } else {
        await this.#spool(batch);
      }
    }
  }

  async #enqueue(batch: UsageEvent[]): Promise<boolean> {
    try {
      await this.#queue.addBulk(
        batch.map((data) => ({
          name: 'usage',
          data,
          opts: { ...JOB_OPTIONS, jobId: data.idempotencyKey },
        })),
      );
      return true;
    } catch (error) {
      this.#logger.warn({ err: error, events: batch.length }, 'usage queue unavailable, spooling');
      return false;
    }
  }

  async #spool(batch: UsageEvent[]): Promise<void> {
    if (!this.#outboxFile) {
      await mkdir(this.#dir, { recursive: true });
      this.#outboxFile = join(this.#dir, `usage-${String(Date.now())}-${this.#owner}.ndjson`);
    }
    await appendFile(this.#outboxFile, batch.map((e) => JSON.stringify(e)).join('\n') + '\n');
    this.#hasOutbox = true;
    this.stats.spooled += batch.length;
  }

  /**
   * Replicas may share a volume. Each file is first claimed with an atomic rename
   * (only one replica succeeds), and its writer's next append creates a fresh file.
   * Our own claimed files (half-finished replay) and stale claims from dead replicas are also picked up.
   */
  async #claimOutbox(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const claimed: { path: string; order: string }[] = [];
    let foreign = false;
    for (const name of names) {
      const path = join(this.#dir, name);
      const prior = CLAIMED_RE.exec(name);
      if (prior) {
        if (prior[2] !== this.#owner) {
          const info = await stat(path).catch(() => undefined);
          if (!info || Date.now() - info.mtimeMs < STALE_CLAIM_MS) continue;
        }
      } else if (!OUTBOX_RE.test(name)) continue;
      const original = prior?.[1] ?? name;
      const target = join(this.#dir, `${original}.replaying-${this.#owner}`);
      try {
        if (path !== target) await rename(path, target);
        claimed.push({ path: target, order: original });
        // Only the writer of our own file uses this serial chain; the append continues.
        if (this.#outboxFile === path) this.#outboxFile = target;
        if (!original.endsWith(`-${this.#owner}.ndjson`)) foreign = true;
      } catch {
        // another replica claimed it first.
      }
    }
    // The writer of our own file uses this serial chain; only another replica's file needs waiting.
    await sleep(0);
    if (foreign && this.#claimGraceMs > 0) await sleep(this.#claimGraceMs);
    return claimed.sort((a, b) => a.order.localeCompare(b.order)).map((c) => c.path);
  }

  async #replayOutbox(): Promise<void> {
    for (const path of await this.#claimOutbox()) {
      const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
      const events: UsageEvent[] = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line) as UsageEvent);
        } catch {
          // A partial line (e.g. a crash mid-write) is not recoverable; log and skip it.
          this.#logger.error({ file: path }, 'dropping corrupt outbox line');
        }
      }
      for (let i = 0; i < events.length; i += this.#batchSize) {
        // Being left half-done is fine: next time the file is sent from the start and the duplicate jobId collapses.
        if (!(await this.#enqueue(events.slice(i, i + this.#batchSize)))) return;
      }
      await unlink(path);
      if (this.#outboxFile === path) this.#outboxFile = undefined;
      this.stats.replayed += events.length;
      this.#logger.info({ file: path, events: events.length }, 'outbox replayed');
    }
    this.#hasOutbox = false;
  }
}

/** For tests and tooling: remaining outbox files (including claimed ones). */
export async function outboxFiles(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(join(dataDir, 'outbox'))).filter(
      (f) => OUTBOX_RE.test(f) || CLAIMED_RE.test(f),
    );
  } catch {
    return [];
  }
}
