/**
 * ارسال رویداد مصرف به صف BullMQ با outbox محلی (کارت ۶.۴).
 *
 * - مسیر درخواست فقط `emit` را صدا می‌زند (همگام، بدون I/O)؛ ارسال دسته‌ای در پس‌زمینه است.
 * - اگر Valkey در دسترس نباشد، دسته به فایل append-only در `<dataDir>/outbox` نوشته می‌شود
 *   و پس از برگشت Valkey به ترتیب دوباره فرستاده می‌شود.
 * - jobId همان idempotencyKey است؛ ارسال تکراری در صف یکی می‌شود و worker هم با
 *   ON CONFLICT DO NOTHING رکورد تکراری نمی‌سازد.
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
  /** صف آماده (برای تست)؛ در غیر این صورت از valkeyUrl ساخته می‌شود. */
  queue?: UsageQueue;
  valkeyUrl?: string;
  flushIntervalMs?: number;
  /** سقف هر دسته در addBulk. */
  batchSize?: number;
  /** مکث بین claim فایل و خواندنش، تا append درحال‌اجرای replica دیگر تمام شود. */
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
 * ۸ تلاش با backoff نمایی (حدود ۴ دقیقه در مجموع) قبل از dead-letter. jobهای تمام‌شده
 * تا ۱۰٬۰۰۰ مورد نگه داشته می‌شوند تا jobId تکراریِ اخیر در خود صف یکی شود.
 */
const JOB_OPTIONS: Omit<UsageJobOptions, 'jobId'> = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 10_000 },
  removeOnFail: { count: 10_000 },
};

const OUTBOX_RE = /^usage-.*\.ndjson$/;
const CLAIMED_RE = /^(usage-.*\.ndjson)\.replaying-(.+)$/;
/** فایل claim‌شدهٔ replica دیگری که این‌قدر دست‌نخورده بماند یعنی آن replica مرده است. */
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
  #hasOutbox = true; // در شروع ممکن است از اجرای قبلی فایل مانده باشد.
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
      // بدون offline queue: وقتی Valkey قطع است فرمان فوراً شکست می‌خورد و به outbox می‌رویم.
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

  /** همگام و بدون I/O؛ هرگز throw نمی‌کند. */
  emit(event: UsageEvent): void {
    this.stats.emitted++;
    this.#pending.push(event);
    this.stats.pending = this.#pending.length;
    if (this.#pending.length >= this.#batchSize) void this.flush();
  }

  /** ارسال بافر و (در صورت امکان) outbox؛ فراخوانی‌ها پشت سر هم اجرا می‌شوند. */
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

  /** رویدادهای بافر حافظه + خطوط NDJSON باقی‌مانده در outbox؛ فقط برای scrape. */
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
        // فایل ممکن است هم‌زمان claim/replay شود؛ scrape بعد مقدار تازه را می‌گیرد.
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
      // تا وقتی outbox خالی نشده، رویداد تازه هم به outbox می‌رود تا ترتیب حفظ شود.
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
   * replicaها ممکن است volume مشترک داشته باشند. هر فایل اول با rename اتمیک claim
   * می‌شود (فقط یک replica موفق می‌شود) و append بعدیِ نویسنده‌اش فایل تازه می‌سازد.
   * فایل‌های claim‌شدهٔ خودمان (replay نیمه‌کاره) و claimهای کهنهٔ replicaهای مرده هم برداشته می‌شوند.
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
        // تنها نویسندهٔ فایل خودمان همین زنجیرهٔ سریالی است؛ append ادامه پیدا می‌کند.
        if (this.#outboxFile === path) this.#outboxFile = target;
        if (!original.endsWith(`-${this.#owner}.ndjson`)) foreign = true;
      } catch {
        // replica دیگری زودتر claim کرد.
      }
    }
    // نویسندهٔ فایل خودمان همین زنجیرهٔ سریالی است؛ فقط برای فایل replica دیگر صبر لازم است.
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
          // خط ناقص (مثلاً crash وسط نوشتن) قابل بازیابی نیست؛ لاگ و رد.
          this.#logger.error({ file: path }, 'dropping corrupt outbox line');
        }
      }
      for (let i = 0; i < events.length; i += this.#batchSize) {
        // نیمه‌کاره ماندن مشکلی ندارد: دفعهٔ بعد از اول فایل ارسال می‌شود و jobId تکراری یکی می‌شود.
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

/** برای تست و ابزارها: فایل‌های outbox باقی‌مانده (شامل claim‌شده‌ها). */
export async function outboxFiles(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(join(dataDir, 'outbox'))).filter(
      (f) => OUTBOX_RE.test(f) || CLAIMED_RE.test(f),
    );
  } catch {
    return [];
  }
}
