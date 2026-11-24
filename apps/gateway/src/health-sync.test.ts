/**
 * Breaker sync between replicas and behavior during a Valkey outage (card 5.5). Also runs against a real Valkey
 * with INTEGRATION_VALKEY_URL.
 */
import { EventEmitter } from 'node:events';

import { BREAKER_STATE_KEY, BreakerStateEntry } from '@dirouter/contracts';
import type { ClassifiedError } from '@dirouter/providers';
import { HealthRegistry } from '@dirouter/routing';
import { createLogger } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import {
  type BreakerStore,
  HEALTH_CHANNEL,
  HealthSync,
  type Publisher,
  type Subscriber,
} from './health-sync.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const target = { providerId: 'p1', modelId: 'm1', credentialId: 'c1' };
const serverError: ClassifiedError = {
  class: 'server',
  retryable: true,
  fallbackAllowed: true,
  message: '503',
};

/** Fake pub/sub channel between several nodes, with the ability to disconnect. */
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
    // a node's own message is not applied again.
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
    // b does not know, but opens independently on its own errors.
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
    const healthy = node(bus, 'healthy');
    await healthy.sync.start(healthy.registry);
    const publisher = bus.publisher();
    bus.down = true;
    await expect(publisher.publish(HEALTH_CHANNEL, 'broken')).rejects.toThrow();
  });
});

describe('breaker state for alert rules (24.2)', () => {
  /** In-memory stand-in for the Valkey hash. */
  function fakeStore(down = false) {
    const hash = new Map<string, string>();
    const store: BreakerStore = {
      hset: (key, field, value) => {
        if (down) return Promise.reject(new Error('Connection is closed.'));
        expect(key).toBe(BREAKER_STATE_KEY);
        hash.set(field, value);
        return Promise.resolve(1);
      },
      hdel: (key, field) => {
        if (down) return Promise.reject(new Error('Connection is closed.'));
        expect(key).toBe(BREAKER_STATE_KEY);
        return Promise.resolve(hash.delete(field) ? 1 : 0);
      },
    };
    return { hash, store };
  }

  it('writes an opened breaker with its time and removes it when it closes', async () => {
    let now = 1_000_000;
    const clock = () => now;
    const { hash, store } = fakeStore();
    const sync = new HealthSync({
      instance: 'a',
      logger,
      publisher: new Bus().publisher(),
      store,
      clock,
    });
    const registry = new HealthRegistry({
      clock,
      onChange: (c) => {
        sync.publish(c);
      },
    });
    fail(registry, 10);
    await tick();
    const provider = BreakerStateEntry.parse(JSON.parse(hash.get('provider:p1') ?? '{}'));
    expect(provider).toMatchObject({ state: 'open', at: 1_000_000 });
    expect(provider.reopensAt).toBeGreaterThan(now);
    expect(hash.has('model:m1')).toBe(true);

    // After the open period the probes succeed and the breaker closes: the entry goes away.
    now += 600_000;
    for (let i = 0; i < 3; i++) registry.recordSuccess(target);
    await tick();
    expect(registry.providerBreaker('p1').state).toBe('closed');
    expect(hash.has('provider:p1')).toBe(false);

    // A reset published by this node removes the field too.
    hash.set('model:m9', '{}');
    sync.publish({ kind: 'reset', scope: 'model', id: 'm9' });
    await tick();
    expect(hash.has('model:m9')).toBe(false);
  });

  it('a failing store never breaks the breaker', async () => {
    const { store } = fakeStore(true);
    const sync = new HealthSync({ instance: 'a', logger, publisher: new Bus().publisher(), store });
    const registry = new HealthRegistry({
      onChange: (c) => {
        sync.publish(c);
      },
    });
    fail(registry, 10);
    await tick();
    expect(registry.providerBreaker('p1').state).toBe('open');
    expect(sync.storeFailures).toBeGreaterThan(0);
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
