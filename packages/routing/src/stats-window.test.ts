/** The one-minute request window (card 22.4): bucketed, constant cost per request. */
import { describe, expect, it } from 'vitest';

import { RouterStats } from './stats.js';

describe('recent requests window', () => {
  it('counts the last minute and forgets older requests', () => {
    let now = 1_000_000;
    const stats = new RouterStats({ now: () => now });
    for (let i = 0; i < 5; i++) stats.recordRequest('m');
    now += 30_000;
    stats.recordRequest('m');
    expect(stats.recentRequests('m')).toBe(6);
    now += 31_000; // the first five are now older than a minute
    expect(stats.recentRequests('m')).toBe(1);
    now += 60_000;
    expect(stats.recentRequests('m')).toBe(0);
    expect(stats.recentRequests('other')).toBe(0);
  });

  it('costs the same at any volume', () => {
    let now = 0;
    const stats = new RouterStats({ now: () => now });
    const time = (n: number) => {
      const started = performance.now();
      for (let i = 0; i < n; i++) {
        now += 1;
        stats.recordRequest('busy');
      }
      return (performance.now() - started) / n;
    };
    time(10_000);
    // 60 000 requests inside one minute: the old list scan made each call ~6x slower here.
    const perCall = time(60_000);
    expect(stats.recentRequests('busy')).toBeGreaterThan(55_000);
    expect(perCall).toBeLessThan(0.01);
  });
});
