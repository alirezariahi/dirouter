/**
 * Health state sync between gateway replicas over Valkey pub/sub (cards 5.5 and 5.6).
 *
 * Every local change (breaker opening or closing, cooldown, lockout, credential disabling) is published
 * and the other nodes apply it with `applyRemote`. So when one node sees a provider is broken,
 * the others immediately avoid it too.
 *
 * Valkey is only for syncing, not the source of state: if it is down, publishing is silently skipped and each
 * node continues with its own local breaker; after reconnecting, the subscription is restored automatically.
 */
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

const KINDS = new Set(['breaker', 'cooldown', 'lockout', 'credential_disabled', 'reset']);

export class HealthSync {
  published = 0;
  dropped = 0;
  applied = 0;

  constructor(
    private readonly opts: {
      instance: string;
      logger: Logger;
      publisher: Publisher;
      subscriber?: Subscriber;
    },
  ) {}

  /** Called from the registry's onChange; synchronous and never throws. */
  publish(change: HealthChange): void {
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
