/**
 * Automatic canary rollback across replicas (card 32.3).
 *
 * The replica that sees a canary's error rate cross its threshold stops sending traffic to it at
 * once (`SplitHealth`), sets a Valkey flag for that split version and queues an event that
 * control-api turns into a new, rolled-back version of the split. Every replica reads the flags
 * of the snapshot's active splits every two seconds, so the others follow before the new snapshot
 * arrives. Nothing here runs on the request path.
 */
import {
  SPLIT_ROLLBACKS_KEY,
  type SplitRollbackEvent,
  splitRolledBackKey,
} from '@dirouter/contracts';
import { SplitHealth, type SplitTrip } from '@dirouter/routing';
import type { Logger } from '@dirouter/shared';
import type { Redis } from 'ioredis';

import type { ConfigStore } from './config-store.js';

const FLAG_TTL_SECONDS = 7 * 86_400;

export class SplitSync {
  readonly health: SplitHealth;
  #timer: NodeJS.Timeout | undefined;
  readonly stats = { trips: 0, synced: 0, errors: 0 };

  constructor(
    private readonly options: {
      store: ConfigStore;
      redis?: Redis | undefined;
      logger: Logger;
      intervalMs?: number;
    },
  ) {
    this.health = new SplitHealth({
      onTrip: (trip) => {
        this.#tripped(trip);
      },
    });
  }

  #tripped(trip: SplitTrip): void {
    this.stats.trips++;
    const { split } = trip;
    this.options.logger.warn(
      {
        split: split.id,
        version: split.version,
        errorRate: trip.errorRate,
        requests: trip.requests,
      },
      'canary rolled back: error rate over the threshold',
    );
    const redis = this.options.redis;
    if (!redis) return;
    const event: SplitRollbackEvent = {
      splitId: split.id,
      organizationId: split.organizationId,
      version: split.version,
      errorRate: Math.round(trip.errorRate * 10_000) / 10_000,
      requests: trip.requests,
      at: new Date().toISOString(),
    };
    void redis
      .multi()
      .set(splitRolledBackKey(split.id, split.version), '1', 'EX', FLAG_TTL_SECONDS)
      .lpush(SPLIT_ROLLBACKS_KEY, JSON.stringify(event))
      .exec()
      .catch((error: unknown) => {
        this.stats.errors++;
        this.options.logger.warn({ err: error }, 'canary rollback could not be shared (Valkey)');
      });
  }

  /** Reads the rollback flags of the current snapshot's active splits. */
  async sync(): Promise<void> {
    const redis = this.options.redis;
    const splits = (this.options.store.current?.snapshot.trafficSplits ?? []).filter(
      (s) => s.enabled && s.state === 'active' && s.canaryPercent > 0 && !this.health.rolledBack(s),
    );
    if (!redis || splits.length === 0) return;
    try {
      const flags = await redis.mget(...splits.map((s) => splitRolledBackKey(s.id, s.version)));
      splits.forEach((s, i) => {
        if (flags[i]) this.health.markRolledBack(s);
      });
      this.stats.synced++;
    } catch (error) {
      this.stats.errors++;
      this.options.logger.debug({ err: error }, 'canary rollback flags unavailable');
    }
  }

  start(): void {
    if (!this.options.redis || this.#timer) return;
    this.#timer = setInterval(() => void this.sync(), this.options.intervalMs ?? 2_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
