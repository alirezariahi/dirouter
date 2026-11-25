/** Canary and percentage traffic splits on the request path (card 32.3). */
import { randomUUID } from 'node:crypto';

import {
  SPLIT_ROLLBACKS_KEY,
  type SplitRollbackEvent,
  splitRolledBackKey,
  type TrafficSplitConfig,
} from '@dirouter/contracts';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KEYS, policyGateway, type PolicyGateway } from './testing/policy-kit.js';

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

const split = (over: Partial<TrafficSplitConfig>): TrafficSplitConfig => ({
  id: 'spl_1',
  organizationId: 'org',
  name: 'mid canary',
  enabled: true,
  version: 1,
  match: 'mid',
  stable: 'mid',
  canary: 'canary',
  canaryPercent: 10,
  stickiness: 'session',
  state: 'active',
  ...over,
});

/** Runs `count` jobs with at most `parallel` in flight. */
async function pool(count: number, parallel: number, job: (i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < count) await job(next++);
    }),
  );
}

describe('traffic split', () => {
  let env: PolicyGateway;

  beforeAll(async () => {
    env = await policyGateway({ trafficSplits: [split({})] });
  });
  afterAll(async () => {
    await env.close();
  });

  // The ±1% criterion over 10,000 identities is proven on the hash itself (routing's split.test.ts)
  // and over 10,000 real requests end to end (scripts/e2e/sprint-5/32.3.mjs); here 2,000 requests
  // through the gateway show the stage is wired, at a size that keeps the suite light.
  it('sends the configured share of real requests to the canary', async () => {
    const start = env.usage.length;
    await pool(2_000, 16, async (i) => {
      const res = await fetch(`${env.base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${KEYS.teamA}`,
          'content-type': 'application/json',
          'x-dirouter-session': `session-${String(i)}`,
        },
        body: JSON.stringify({ model: 'mid', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    });
    const events = env.usage.slice(start);
    expect(events).toHaveLength(2_000);
    const canary = events.filter((e) => e.policy?.split?.branch === 'canary');
    // Binomial standard deviation at 2,000 requests is 0.67 points; 2 points is three of them.
    expect(Math.abs(canary.length / 20 - 10)).toBeLessThanOrEqual(2);
    // The branch decided the model, and the event says which split version chose it.
    expect(canary.every((e) => e.resolvedModelId === 'org-canary')).toBe(true);
    expect(
      events
        .filter((e) => e.policy?.split?.branch === 'stable')
        .every((e) => e.resolvedModelId === 'org-mid'),
    ).toBe(true);
    expect(canary[0]?.policy?.split).toEqual({ id: 'spl_1', version: 1, branch: 'canary' });
  }, 60_000);

  it('keeps a session on its branch and says which branch answered', async () => {
    const seen = new Set<string | null>();
    for (let i = 0; i < 5; i++) {
      const res = await env.chat(KEYS.teamA, 'mid', { headers: { 'x-dirouter-session': 'fixed' } });
      seen.add(res.headers.get('x-dirouter-split'));
      expect(res.body.model).toBe('mid');
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toMatch(/^spl_1; v=1; branch=(stable|canary)$/);
  });

  it('sends everything to stable once a version is rolled back in the snapshot', async () => {
    await env.publish({
      trafficSplits: [split({ version: 2, canaryPercent: 100, state: 'rolled_back' })],
    });
    const res = await env.chat(KEYS.teamA, 'mid');
    expect(res.headers.get('x-dirouter-model')).toBe('mid');
    expect(res.headers.get('x-dirouter-split')).toBe('spl_1; v=2; branch=stable');
  });

  it("never splits another organization's traffic", async () => {
    await env.publish({
      trafficSplits: [split({ match: 'big', canary: 'cheap', canaryPercent: 100 })],
    });
    const res = await env.chat(KEYS.other, 'big');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-split')).toBeNull();
  });
});

describe('automatic canary rollback', () => {
  const redis = VALKEY_URL ? new Redis(VALKEY_URL, { enableOfflineQueue: true }) : undefined;
  const id = `spl_${randomUUID().slice(0, 8)}`;
  const failing = split({
    id,
    canary: 'canary-broken',
    canaryPercent: 50,
    stickiness: 'request',
    autoRollback: { enabled: true, errorRate: 0.5, minRequests: 10, windowSeconds: 60 },
  });
  let env: PolicyGateway;
  let replica: PolicyGateway;

  beforeAll(async () => {
    if (redis) await redis.del(SPLIT_ROLLBACKS_KEY);
    env = await policyGateway({ trafficSplits: [failing] }, redis ? { redis } : {});
    replica = await policyGateway({ trafficSplits: [failing] }, redis ? { redis } : {});
  });
  afterAll(async () => {
    await env.close();
    await replica.close();
    if (redis) {
      await redis.del(SPLIT_ROLLBACKS_KEY, splitRolledBackKey(id, 1));
      redis.disconnect();
    }
  });

  it('rolls the canary back when its injected errors cross the threshold', async () => {
    const start = env.usage.length;
    const statuses: number[] = [];
    for (let i = 0; i < 80; i++) statuses.push((await env.chat(KEYS.teamA, 'mid')).status);
    expect(env.gw.splits.health.rolledBack(failing)).toBe(true);
    expect(env.gw.splits.stats.trips).toBe(1);
    // Every failure came from the canary, and none after the rollback: the tail is all stable.
    const events = env.usage.slice(start);
    const firstStableRun = events.findIndex((_, i) =>
      events.slice(i).every((e) => e.policy?.split?.branch === 'stable'),
    );
    expect(firstStableRun).toBeLessThan(60);
    expect(statuses.slice(-20).every((s) => s === 200)).toBe(true);
    expect(
      events.filter((e) => e.status === 'error').every((e) => e.policy?.split?.branch === 'canary'),
    ).toBe(true);
  });

  it.skipIf(!redis)('shares the rollback with other replicas and the control plane', async () => {
    expect(replica.gw.splits.health.rolledBack(failing)).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(await redis?.get(splitRolledBackKey(id, 1))).toBe('1');
    const queued = (await redis?.lrange(SPLIT_ROLLBACKS_KEY, 0, -1)) ?? [];
    const event = queued
      .map((e) => JSON.parse(e) as SplitRollbackEvent)
      .find((e) => e.splitId === id);
    expect(event).toMatchObject({ organizationId: 'org', version: 1, splitId: id });
    expect(event?.errorRate).toBeGreaterThanOrEqual(0.5);
    await replica.gw.splits.sync();
    expect(replica.gw.splits.health.rolledBack(failing)).toBe(true);
    const res = await replica.chat(KEYS.teamA, 'mid');
    expect(res.headers.get('x-dirouter-split')).toBe(`${id}; v=1; branch=stable`);
  });
});
