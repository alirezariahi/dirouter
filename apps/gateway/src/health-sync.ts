/**
 * Health state sync between gateway replicas over Valkey pub/sub (cards 5.5 and 5.6).
 *
 * Every local change (breaker opening or closing, cooldown, lockout, credential disabling) is published
 * and the other nodes apply it with `applyRemote`. So when one node sees a provider is broken,
 * the others immediately avoid it too.
 *
 * Valkey is only for syncing, not the source of state: if it is down, publishing is silently skipped and each
 * node continues with its own local breaker; after reconnecting, the subscription is restored automatically.
 *
 * Breaker transitions are also written to the `BREAKER_STATE_KEY` hash (card 24.2) so the worker can
 * evaluate `breaker_open` alert rules: open and half-open breakers are stored, a closed or reset one is
 * removed. That write is best effort too.
 */
import { BREAKER_STATE_KEY, type BreakerStateEntry, breakerStateField } from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';
import type { HealthChange, HealthRegistry } from '@dirouter/routing';

export const HEALTH_CHANNEL = 'dirouter:health';

export interface Publisher {
  publish(channel: string, message: string): Promise<number>;
}
export interface Subscriber {
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
}
/** Where breaker state is written for the worker (an ioredis client fits). */
export interface BreakerStore {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, field: string): Promise<unknown>;
}

const KINDS = new Set(['breaker', 'cooldown', 'lockout', 'credential_disabled', 'reset']);

export class HealthSync {
  published = 0;
  dropped = 0;
  applied = 0;
  /** Breaker state writes that failed (Valkey unavailable). */
  storeFailures = 0;

  constructor(
    private readonly opts: {
      instance: string;
      logger: Logger;
      publisher: Publisher;
      subscriber?: Subscriber;
      store?: BreakerStore;
      clock?: () => number;
    },
  ) {}

  /** Mirrors a breaker transition into the shared hash; never throws. */
  #store(change: HealthChange): void {
    const store = this.opts.store;
    if (!store) return;
    let write: Promise<unknown> | undefined;
    if (change.kind === 'breaker') {
      const field = breakerStateField(change.scope, change.id);
      if (change.state === 'closed') write = store.hdel(BREAKER_STATE_KEY, field);
      else {
        const entry: BreakerStateEntry = {
          state: change.state,
          at: (this.opts.clock ?? Date.now)(),
          ...(change.reopensAt ? { reopensAt: change.reopensAt } : {}),
        };
        write = store.hset(BREAKER_STATE_KEY, field, JSON.stringify(entry));
      }
    } else if (change.kind === 'reset' && change.scope !== 'credential')
      write = store.hdel(BREAKER_STATE_KEY, breakerStateField(change.scope, change.id));
    write?.catch(() => {
      this.storeFailures++;
    });
  }

  /** Called from the registry's onChange; synchronous and never throws. */
  publish(change: HealthChange): void {
    this.#store(change);
    this.opts.publisher
      .publish(HEALTH_CHANNEL, JSON.stringify({ from: this.opts.instance, change }))
      .then(() => {
        this.published++;
      })
      .catch(() => {
        // Valkey is unavailable; the local breaker does its own job.
        this.dropped++;
      });
  }

  async start(registry: HealthRegistry): Promise<void> {
    const sub = this.opts.subscriber;
    if (!sub) return;
    sub.on('message', (channel, raw) => {
      if (channel !== HEALTH_CHANNEL) return;
      try {
        const msg = JSON.parse(raw) as { from?: unknown; change?: { kind?: unknown } };
        if (msg.from === this.opts.instance) return;
        if (!msg.change || typeof msg.change.kind !== 'string' || !KINDS.has(msg.change.kind))
          return;
        registry.applyRemote(msg.change as HealthChange);
        this.applied++;
      } catch (error) {
        this.opts.logger.debug({ err: error }, 'ignoring malformed health message');
      }
    });
    try {
      await sub.subscribe(HEALTH_CHANNEL);
    } catch (error) {
      // ioredis re-establishes the subscription itself after reconnecting.
      this.opts.logger.warn({ err: error }, 'health sync subscribe failed; continuing locally');
    }
  }
}
