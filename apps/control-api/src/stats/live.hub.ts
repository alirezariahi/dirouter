/**
 * Live view fan-out (card 24.4): one Valkey subscriber connection per control-api process,
 * subscribed to an organization's channel only while at least one dashboard listens to it.
 */
import { liveChannel, LiveRequestEvent } from '@dirouter/contracts';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ValkeyService } from '../infra/valkey.service.js';

export type LiveListener = (event: LiveRequestEvent) => void;

/** Upper bound of open streams per process; more are refused and the page polls instead. */
export const MAX_LIVE_STREAMS = 500;
/** Upper bound of open streams of one user (or management token's service account) per process. */
export const MAX_LIVE_STREAMS_PER_USER = 5;

@Injectable()
export class LiveHub implements OnModuleDestroy {
  #sub: Redis | undefined;
  readonly #listeners = new Map<string, Set<LiveListener>>();
  /** Settles once Valkey confirmed the SUBSCRIBE of a channel (errors included). */
  readonly #subscribed = new Map<string, Promise<void>>();
  #count = 0;
  readonly #perUser = new Map<string, number>();

  constructor(@Inject(ValkeyService) private readonly valkey: ValkeyService) {}

  get size(): number {
    return this.#count;
  }

  #subscriber(): Redis {
    if (this.#sub) return this.#sub;
    const sub = this.valkey.client.duplicate({
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    sub.on('error', () => undefined);
    sub.on('message', (channel: string, message: string) => {
      const listeners = this.#listeners.get(channel);
      if (!listeners?.size) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      // Re-validated so only the documented metadata fields ever reach a browser.
      const event = LiveRequestEvent.safeParse(parsed);
      if (!event.success) return;
      for (const listener of listeners) listener(event.data);
    });
    this.#sub = sub;
    return sub;
  }

  /** Open streams of one user in this process. */
  sizeOf(userId: string): number {
    return this.#perUser.get(userId) ?? 0;
  }

  /**
   * Starts listening. `ready` settles once the channel subscription is confirmed (or failed), so
   * nothing published after it is missed; `off` stops. `full` when the process is full, `user`
   * when this user already has MAX_LIVE_STREAMS_PER_USER streams open.
   */
  subscribe(
    organizationId: string,
    listener: LiveListener,
    userId: string,
  ): { off: () => void; ready: Promise<void> } | 'full' | 'user' {
    if (this.#count >= MAX_LIVE_STREAMS) return 'full';
    const mine = this.sizeOf(userId);
    if (mine >= MAX_LIVE_STREAMS_PER_USER) return 'user';
    this.#perUser.set(userId, mine + 1);
    const channel = liveChannel(organizationId);
    let listeners = this.#listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(channel, listeners);
      this.#subscribed.set(
        channel,
        this.#subscriber()
          .subscribe(channel)
          .then(
            () => undefined,
            () => undefined,
          ),
      );
    }
    listeners.add(listener);
    this.#count++;
    let active = true;
    const off = () => {
      if (!active) return;
      active = false;
      this.#count--;
      const left = this.sizeOf(userId) - 1;
      if (left > 0) this.#perUser.set(userId, left);
      else this.#perUser.delete(userId);
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listeners.delete(channel);
        this.#subscribed.delete(channel);
        void this.#sub?.unsubscribe(channel).catch(() => undefined);
      }
    };
    return { off, ready: this.#subscribed.get(channel) ?? Promise.resolve() };
  }

  onModuleDestroy() {
    this.#sub?.disconnect();
  }
}
