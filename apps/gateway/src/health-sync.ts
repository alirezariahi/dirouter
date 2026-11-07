/**
 * همگام‌سازی وضعیت سلامت بین replicaهای گیت‌وی روی Valkey pub/sub (کارت‌های ۵.۵ و ۵.۶).
 *
 * هر تغییر محلی (باز یا بسته شدن breaker، cooldown، lockout، غیرفعال شدن credential) منتشر
 * می‌شود و بقیهٔ نودها با `applyRemote` آن را اعمال می‌کنند. پس وقتی یک نود provider خراب
 * را دید، بقیه هم بی‌درنگ از آن دوری می‌کنند.
 *
 * Valkey فقط برای هم‌خبری است، نه منبع وضعیت: اگر قطع باشد انتشار بی‌صدا رد می‌شود و هر
 * نود با breaker محلی خودش ادامه می‌دهد؛ بعد از وصل شدن دوباره، اشتراک خودکار برقرار می‌شود.
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

  /** از onChange رجیستری صدا زده می‌شود؛ همگام و بدون throw. */
  publish(change: HealthChange): void {
    this.opts.publisher
      .publish(HEALTH_CHANNEL, JSON.stringify({ from: this.opts.instance, change }))
      .then(() => {
        this.published++;
      })
      .catch(() => {
        // Valkey در دسترس نیست؛ breaker محلی کار خودش را می‌کند.
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
      // ioredis بعد از وصل شدن دوباره اشتراک را خودش برقرار می‌کند.
      this.opts.logger.warn({ err: error }, 'health sync subscribe failed; continuing locally');
    }
  }
}
