/**
 * The job poller (ADR-0007): a background loop in every gateway replica that runs the due items
 * of the job store (follow a batch or task upstream, retry a webhook, delete an expired file).
 *
 * It runs in the gateway rather than in the worker because only the gateway holds MASTER_KEY and
 * the provider credentials (ADR-0006). Items are locked one by one in Valkey, so replicas share
 * the work without doing anything twice; a replica that dies mid-item frees it when the lock
 * expires.
 */
import type { Logger } from '@dirouter/shared';

import type { JobKind, JobStore } from './store.js';

export type JobHandler = (id: string) => Promise<unknown>;

export class JobPoller {
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;

  constructor(
    private readonly options: {
      store: JobStore;
      handlers: Partial<Record<JobKind, JobHandler>>;
      logger: Logger;
      tickMs?: number;
      batchSize?: number;
    },
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.options.tickMs ?? 1_000);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  /** One pass over the due items; a pass still running is not started twice. */
  tick(): Promise<void> {
    this.#running ??= this.#pass().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #pass(): Promise<void> {
    let due: { kind: JobKind; id: string }[];
    try {
      due = await this.options.store.due(Date.now(), this.options.batchSize ?? 50);
    } catch (error) {
      this.options.logger.warn(
        { error: (error as Error).message },
        'job poller cannot read the queue',
      );
      return;
    }
    await Promise.all(
      due.map(async ({ kind, id }) => {
        const handler = this.options.handlers[kind];
        try {
          if (handler) await handler(id);
          else await this.options.store.unschedule(kind, id);
        } catch (error) {
          this.options.logger.warn(
            { kind, id, error: (error as Error).message },
            'job step failed',
          );
          // Tried again a minute later rather than on every tick.
          await this.options.store.schedule(kind, id, Date.now() + 60_000).catch(() => undefined);
        }
      }),
    );
  }
}
