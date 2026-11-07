/**
 * همگام‌سازی breaker بین replicaها و رفتار در قطعی Valkey (کارت ۵.۵). روی Valkey واقعی هم
 * با INTEGRATION_VALKEY_URL اجرا می‌شود.
 */
import { EventEmitter } from 'node:events';

import type { ClassifiedError } from '@dirouter/providers';
import { HealthRegistry } from '@dirouter/routing';
import { createLogger } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { HEALTH_CHANNEL, HealthSync, type Publisher, type Subscriber } from './health-sync.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const target = { providerId: 'p1', modelId: 'm1', credentialId: 'c1' };
const serverError: ClassifiedError = {
  class: 'server',
  retryable: true,
  fallbackAllowed: true,
  message: '503',
};

/** کانال pub/sub ساختگی بین چند نود، با امکان قطع. */
class Bus {
  down = false;
  readonly subs: (EventEmitter & Subscriber)[] = [];
  publisher(): Publisher {
    return {
      publish: (channel, message) => {
        if (this.down) return Promise.reject(new Error('Connection is closed.'));
        for (const s of this.subs) s.emit('message', channel, message);
        return Promise.resolve(this.subs.length);
      },
    };
  }
  subscriber(): Subscriber {
    const s = Object.assign(new EventEmitter(), {
      subscribe: () => Promise.resolve(1),
    }) as EventEmitter & Subscriber;
    this.subs.push(s);
    return s;
  }
}

function node(bus: Bus, name: string) {
  const sync = new HealthSync({
    instance: name,
    logger,
    publisher: bus.publisher(),
    subscriber: bus.subscriber(),
  });
  const registry = new HealthRegistry({
    onChange: (c) => {
      sync.publish(c);
    },
  });
  return { registry, sync };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const fail = (registry: HealthRegistry, n: number) => {
  for (let i = 0; i < n; i++) registry.recordFailure(target, serverError);
};

describe('health sync between gateway replicas', () => {
  it('a breaker opened on one node opens on the others', async () => {
    const bus = new Bus();
    const a = node(bus, 'a');
    const b = node(bus, 'b');
    await a.sync.start(a.registry);
    await b.sync.start(b.registry);
    fail(a.registry, 10);
    await tick();
    expect(a.registry.providerBreaker('p1').state).toBe('open');
    expect(b.registry.providerBreaker('p1').state).toBe('open');
    expect(b.registry.modelBreaker('m1').state).toBe('open');
    expect(b.sync.applied).toBeGreaterThan(0);
    // پیام خود نود دوباره اعمال نمی‌شود.
    expect(a.sync.applied).toBe(0);
  });

  it('cooldowns propagate too', async () => {
    const bus = new Bus();
    const a = node(bus, 'a');
    const b = node(bus, 'b');
    await b.sync.start(b.registry);
    a.registry.recordFailure(target, {
      class: 'rate_limit',
      retryable: false,
      fallbackAllowed: true,
      message: 'Rate limit reached',
      retryAfterMs: 30_000,
    });
    await tick();
    expect(b.registry.credentialAvailable('c1', 'm1')).toBe(false);
  });

  it('a Valkey outage does not disable the breaker: each node keeps protecting itself', async () => {
    const bus = new Bus();
    bus.down = true;
    const a = node(bus, 'a');
    const b = node(bus, 'b');
    await a.sync.start(a.registry);
    await b.sync.start(b.registry);
    expect(() => {
      fail(a.registry, 10);
    }).not.toThrow();
    await tick();
    expect(a.registry.providerBreaker('p1').state).toBe('open');
    expect(a.sync.dropped).toBeGreaterThan(0);
    // b خبر ندارد ولی با خطاهای خودش مستقل باز می‌شود.
    expect(b.registry.providerBreaker('p1').state).toBe('closed');
    fail(b.registry, 10);
    expect(b.registry.providerBreaker('p1').state).toBe('open');
  });

  it('ignores malformed and unknown messages', async () => {
    const bus = new Bus();
    const b = node(bus, 'b');
    await b.sync.start(b.registry);
    for (const raw of ['not json', '{}', '{"from":"x","change":{"kind":"drop_table"}}']) {
      bus.subs[0]?.emit('message', HEALTH_CHANNEL, raw);
    }
    expect(b.sync.applied).toBe(0);
  });
});

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
describe.skipIf(!VALKEY_URL)('health sync on real Valkey', () => {
  it('propagates a breaker between two nodes', async () => {
    const conns: Redis[] = [];
    const make = (name: string) => {
      const pub = new Redis(VALKEY_URL ?? '');
      const sub = new Redis(VALKEY_URL ?? '');
      conns.push(pub, sub);
      const sync = new HealthSync({ instance: name, logger, publisher: pub, subscriber: sub });
      const registry = new HealthRegistry({
        onChange: (c) => {
          sync.publish(c);
        },
      });
      return { registry, sync };
    };
    const a = make('it-a');
    const b = make('it-b');
    await a.sync.start(a.registry);
    await b.sync.start(b.registry);
    fail(a.registry, 10);
    for (let i = 0; i < 50 && b.registry.providerBreaker('p1').state !== 'open'; i++) await tick();
    expect(b.registry.providerBreaker('p1').state).toBe('open');
    for (const c of conns) c.disconnect();
  });
});
