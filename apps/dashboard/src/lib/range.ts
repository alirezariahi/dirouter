/**
 * Global dashboard time range (card 7.3): persisted in localStorage and read by all pages
 * (Overview and Request Log) read from it.
 */
import { useSyncExternalStore } from 'react';

export const RANGES = ['24h', '7d', '30d'] as const;
export type RangeKey = (typeof RANGES)[number];

const HOUR = 3_600_000;
const SPAN: Record<RangeKey, number> = {
  '24h': 24 * HOUR,
  '7d': 7 * 24 * HOUR,
  '30d': 30 * 24 * HOUR,
};

const listeners = new Set<() => void>();
let current: RangeKey = (() => {
  try {
    const v = localStorage.getItem('dirouter.range');
    return RANGES.includes(v as RangeKey) ? (v as RangeKey) : '24h';
  } catch {
    return '24h';
  }
})();

export function setRange(r: RangeKey): void {
  current = r;
  try {
    localStorage.setItem('dirouter.range', r);
  } catch {
    // only for this session
  }
  for (const l of listeners) l();
}

export function useRange(): RangeKey {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export interface Bounds {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  granularity: 'hour' | 'day';
  /** Length of each chart bucket in ms */
  bucketMs: number;
}

/** Bounds rounded to the hour so the cache key stays stable (auto-refresh does not change the key until the next hour). */
export function rangeBounds(range: RangeKey, now = Date.now()): Bounds {
  const span = SPAN[range];
  const to = Math.ceil(now / HOUR) * HOUR;
  const from = to - span;
  const granularity = range === '30d' ? 'day' : 'hour';
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    prevFrom: new Date(from - span).toISOString(),
    prevTo: new Date(from).toISOString(),
    granularity,
    bucketMs: granularity === 'day' ? 24 * HOUR : HOUR,
  };
}
