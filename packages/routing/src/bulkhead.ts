/**
 * Bulkhead (card 5.7): concurrency cap with a short queue and timeout.
 *
 * Each provider and each virtual key has its own semaphore so that one slow provider or one
 * heavy key cannot take all connections and memory of the gateway. When the cap is full, a request
 * waits in the short queue for up to `queueTimeoutMs`. If the queue is full or time has passed, it is
 * rejected immediately (the gateway returns 429 or moves to the next candidate). Counting is local and per node.
 */

export interface BulkheadOptions {
  limit: number;
  /** Maximum number of waiting requests; 0 means no queue. */
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

  /** Update the cap with new config; if the cap was raised, waiting requests are started. */
  configure(options: BulkheadOptions): void {
    this.#options = { ...options };
    this.#drain();
  }

  /**
   * Acquire a free slot. `undefined` means rejected (queue full, timeout, or abort).
   * release takes effect only once.
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

/** Collection of bulkheads keyed by string (`provider:<id>`, `key:<id>`). */
export class BulkheadRegistry {
  readonly #items = new Map<string, Bulkhead>();

  constructor(private readonly defaults: Omit<BulkheadOptions, 'limit'>) {}

  /** The bulkhead with this name and the given cap; no cap means unlimited (undefined). */
  get(
    name: string,
    limit: number | undefined,
    overrides?: Partial<BulkheadOptions>,
  ): Bulkhead | undefined {
    if (limit === undefined) {
      const existing = this.#items.get(name);
      // Cap removed: waiters are released, and the bulkhead is dropped once it is empty.
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

  /** Current state for health and metrics. */
  snapshot(): { name: string; active: number; queued: number; limit: number }[] {
    return [...this.#items].map(([name, b]) => ({
      name,
      active: b.active,
      queued: b.queued,
      limit: b.limit,
    }));
  }
}
