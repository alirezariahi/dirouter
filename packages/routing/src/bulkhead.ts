/**
 * Bulkhead (کارت ۵.۷): سقف همزمانی با صف کوتاه و timeout.
 *
 * هر provider و هر کلید مجازی semaphore خودش را دارد تا یک provider کند یا یک کلید
 * پرمصرف نتواند همهٔ اتصال‌ها و حافظهٔ گیت‌وی را بگیرد. وقتی سقف پر است، درخواست تا
 * `queueTimeoutMs` در صف کوتاه منتظر می‌ماند. اگر صف پر بود یا زمان گذشت، فوراً رد
 * می‌شود (گیت‌وی 429 می‌دهد یا به کاندیدای بعدی می‌رود). شمارش محلی و به ازای هر node است.
 */

export interface BulkheadOptions {
  limit: number;
  /** حداکثر درخواست منتظر؛ ۰ یعنی بدون صف. */
  queueSize: number;
  queueTimeoutMs: number;
}

export type Release = () => void;

interface Waiter {
  resolve: (release: Release | undefined) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export class Bulkhead {
  #active = 0;
  readonly #queue: Waiter[] = [];
  #options: BulkheadOptions;

  constructor(options: BulkheadOptions) {
    this.#options = { ...options };
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  get limit(): number {
    return this.#options.limit;
  }

  get options(): Readonly<BulkheadOptions> {
    return this.#options;
  }

  /** به‌روزرسانی سقف با config جدید؛ اگر سقف بالا رفت منتظرها راه می‌افتند. */
  configure(options: BulkheadOptions): void {
    this.#options = { ...options };
    this.#drain();
  }

  /**
   * گرفتن یک جای خالی. `undefined` یعنی رد شد (صف پر، timeout یا abort).
   * release فقط یک بار اثر دارد.
   */
  acquire(signal?: AbortSignal): Promise<Release | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    if (this.#active < this.#options.limit && this.#queue.length === 0)
      return Promise.resolve(this.#grant());
    if (this.#queue.length >= this.#options.queueSize || this.#options.queueTimeoutMs <= 0)
      return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.#remove(waiter);
          resolve(undefined);
        }, this.#options.queueTimeoutMs),
        cleanup: () => {
          signal?.removeEventListener('abort', onAbort);
        },
      };
      const onAbort = () => {
        this.#remove(waiter);
        resolve(undefined);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  #grant(): Release {
    this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.#options.limit) {
      const next = this.#queue.shift();
      if (!next) return;
      clearTimeout(next.timer);
      next.cleanup();
      next.resolve(this.#grant());
    }
  }

  #remove(waiter: Waiter): void {
    const at = this.#queue.indexOf(waiter);
    if (at >= 0) this.#queue.splice(at, 1);
    clearTimeout(waiter.timer);
    waiter.cleanup();
  }
}

/** مجموعهٔ bulkheadها با کلید رشته‌ای (`provider:<id>`، `key:<id>`). */
export class BulkheadRegistry {
  readonly #items = new Map<string, Bulkhead>();

  constructor(private readonly defaults: Omit<BulkheadOptions, 'limit'>) {}

  /** bulkhead این نام با سقف داده‌شده؛ بدون سقف یعنی نامحدود (undefined). */
  get(
    name: string,
    limit: number | undefined,
    overrides?: Partial<BulkheadOptions>,
  ): Bulkhead | undefined {
    if (limit === undefined) {
      const existing = this.#items.get(name);
      // سقف برداشته شد: منتظرها آزاد می‌شوند و bulkhead وقتی خالی شد کنار می‌رود.
      if (existing) {
        existing.configure({ ...this.defaults, limit: Number.MAX_SAFE_INTEGER });
        if (existing.active === 0) this.#items.delete(name);
      }
      return undefined;
    }
    const options = { ...this.defaults, ...overrides, limit };
    let bulkhead = this.#items.get(name);
    if (!bulkhead) {
      bulkhead = new Bulkhead(options);
      this.#items.set(name, bulkhead);
    } else {
      const current = bulkhead.options;
      if (
        current.limit !== options.limit ||
        current.queueSize !== options.queueSize ||
        current.queueTimeoutMs !== options.queueTimeoutMs
      )
        bulkhead.configure(options);
    }
    return bulkhead;
  }

  /** وضعیت فعلی برای health و متریک. */
  snapshot(): { name: string; active: number; queued: number; limit: number }[] {
    return [...this.#items].map(([name, b]) => ({
      name,
      active: b.active,
      queued: b.queued,
      limit: b.limit,
    }));
  }
}
