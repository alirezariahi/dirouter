/** Canary and percentage traffic splits (card 32.3). */
import type { TrafficSplitConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { applySplit, chooseBranch, SplitHealth, SplitIndex, splitBucket } from './split.js';

const split = (over: Partial<TrafficSplitConfig> = {}): TrafficSplitConfig => ({
  id: 'spl_1',
  organizationId: 'org',
  name: 'gpt canary',
  enabled: true,
  version: 1,
  match: 'gpt',
  stable: 'gpt-old',
  canary: 'gpt-new',
  canaryPercent: 10,
  stickiness: 'key',
  autoRollback: { enabled: true, errorRate: 0.2, minRequests: 20, windowSeconds: 60 },
  state: 'active',
  ...over,
});

describe('traffic split', () => {
  it.each([1, 5, 10, 25, 50, 90, 12.5])(
    'sends %s%% of 10,000 keys to the canary within ±1%%',
    (percent) => {
      const s = split({ canaryPercent: percent });
      let canary = 0;
      for (let i = 0; i < 10_000; i++)
        if (chooseBranch(s, `vk_${String(i)}`) === 'canary') canary++;
      expect(Math.abs(canary / 100 - percent)).toBeLessThanOrEqual(1);
    },
  );

  it('keeps 10,000 requests per request within ±1% too', () => {
    let seed = 42;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    let canary = 0;
    for (let i = 0; i < 10_000; i++)
      if (chooseBranch(split(), undefined, random) === 'canary') canary++;
    expect(Math.abs(canary / 100 - 10)).toBeLessThanOrEqual(1);
  });

  it('is sticky, and raising the percentage only moves stable identities to the canary', () => {
    const ids = Array.from({ length: 2_000 }, (_, i) => `session-${String(i)}`);
    const at10 = ids.map((id) => chooseBranch(split({ canaryPercent: 10 }), id));
    expect(ids.map((id) => chooseBranch(split({ canaryPercent: 10 }), id))).toEqual(at10);
    const at30 = ids.map((id) => chooseBranch(split({ canaryPercent: 30 }), id));
    at10.forEach((branch, i) => {
      if (branch === 'canary') expect(at30[i]).toBe('canary');
    });
    expect(chooseBranch(split({ canaryPercent: 0 }), 'x')).toBe('stable');
    expect(chooseBranch(split({ canaryPercent: 100 }), 'x')).toBe('canary');
    expect(splitBucket('a', 'b')).not.toBe(splitBucket('b', 'a'));
  });

  it('finds splits by organization and name and honours stickiness', () => {
    const health = new SplitHealth();
    const index = new SplitIndex([
      split(),
      split({ id: 'spl_s', match: 'sess', stickiness: 'session', canaryPercent: 50 }),
      split({ id: 'spl_off', match: 'off', enabled: false }),
    ]);
    expect(index.size).toBe(2);
    expect(applySplit(index, health, 'org-2', 'gpt', { key: 'k' })).toBeUndefined();
    expect(applySplit(index, health, 'org', 'off', { key: 'k' })).toBeUndefined();
    const d = applySplit(index, health, 'org', 'gpt', { key: 'k' });
    expect(d?.target).toBe(d?.branch === 'canary' ? 'gpt-new' : 'gpt-old');
    // Session stickiness: different sessions of one key spread over both branches.
    const branches = new Set(
      Array.from(
        { length: 50 },
        (_, i) =>
          applySplit(index, health, 'org', 'sess', { key: 'k', session: `s${String(i)}` })?.branch,
      ),
    );
    expect(branches).toEqual(new Set(['stable', 'canary']));
    const rolled = new SplitIndex([split({ canaryPercent: 100, state: 'rolled_back' })]);
    expect(applySplit(rolled, health, 'org', 'gpt', { key: 'k' })?.branch).toBe('stable');
  });

  it('rolls a canary back once its error rate crosses the threshold', () => {
    let now = 1_000_000;
    const trips: unknown[] = [];
    const health = new SplitHealth({ now: () => now, onTrip: (t) => trips.push(t) });
    const s = split({ canaryPercent: 100 });
    const index = new SplitIndex([s]);
    // Below minRequests nothing is decided, even at 100% errors.
    for (let i = 0; i < 19; i++) expect(health.record(s, false)).toBe(false);
    expect(health.record(s, false)).toBe(true);
    expect(trips).toHaveLength(1);
    expect(health.rolledBack(s)).toBe(true);
    expect(applySplit(index, health, 'org', 'gpt', { key: 'k' })?.branch).toBe('stable');
    // A new version starts with a clean window.
    const v2 = split({ canaryPercent: 100, version: 2 });
    expect(health.rolledBack(v2)).toBe(false);
    // Healthy canary traffic, and errors that age out of the window, do not roll back.
    for (let i = 0; i < 100; i++) health.record(v2, i % 10 !== 0);
    expect(health.rolledBack(v2)).toBe(false);
    const v3 = split({ canaryPercent: 100, version: 3 });
    for (let i = 0; i < 15; i++) health.record(v3, false);
    now += 61_000;
    for (let i = 0; i < 30; i++) health.record(v3, true);
    expect(health.rolledBack(v3)).toBe(false);
    // Disabled auto rollback never trips; another replica's report does.
    const manual = split({
      version: 4,
      autoRollback: { enabled: false, errorRate: 0.1, minRequests: 1, windowSeconds: 60 },
    });
    expect(health.record(manual, false)).toBe(false);
    health.markRolledBack(manual);
    expect(health.rolledBack(manual)).toBe(true);
  });
});
