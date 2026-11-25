/**
 * Live view feed (card 24.4): one PUBLISH per finished request on the organization's Valkey
 * channel. Fire and forget: nobody listening costs one round trip, and a Valkey outage drops the
 * event (the Live page then falls back to polling the request log, which the usage pipeline fills).
 */
import { liveChannel, toLiveEvent, type UsageEvent } from '@dirouter/contracts';
import { connectValkey } from '@dirouter/shared';
import { Redis } from 'ioredis';

export interface LivePublisherClient {
  readonly status: string;
  publish(channel: string, message: string): Promise<number>;
}

export class LivePublisher {
  readonly #redis: LivePublisherClient;
  readonly stats = { published: 0, dropped: 0 };

  constructor(redis: LivePublisherClient | string) {
    if (typeof redis === 'string') {
      const client = connectValkey(Redis, redis, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (n: number) => Math.min(n * 200, 2_000),
      });
      client.on('error', () => undefined);
      this.#redis = client;
    } else this.#redis = redis;
  }

  publish(event: UsageEvent): void {
    // Requests refused before authentication belong to no organization.
    if (!event.organizationId || this.#redis.status !== 'ready') {
      this.stats.dropped++;
      return;
    }
    this.#redis
      .publish(liveChannel(event.organizationId), JSON.stringify(toLiveEvent(event)))
      .then(() => {
        this.stats.published++;
      })
      .catch(() => {
        this.stats.dropped++;
      });
  }

  close(): void {
    if (this.#redis instanceof Redis) this.#redis.disconnect();
  }
}
