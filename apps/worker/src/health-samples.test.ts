/** Worker side of the uptime history (card 12.3). */
import { createLogger } from '@dirouter/shared';
import { describe, expect, it } from 'vitest';

import {
  drainHealthSamples,
  HEALTH_SAMPLES_KEY,
  type HealthSampleDb,
  type SampleQueue,
} from './health-samples.js';

const logger = createLogger({ service: 'test', level: 'silent' });

function fakeQueue(items: string[]): SampleQueue & { items: string[] } {
  return {
    items,
    rpop(key, count) {
      expect(key).toBe(HEALTH_SAMPLES_KEY);
      const taken = items.splice(Math.max(0, items.length - count), count).reverse();
      return Promise.resolve(taken.length ? taken : null);
    },
    rpush(_key, ...values) {
      items.push(...values);
      return Promise.resolve(items.length);
    },
  };
}

function fakeDb(fail = false) {
  const rows: Record<string, unknown>[] = [];
  const pruneBefore: Date[] = [];
  const db: HealthSampleDb = {
    providerHealthSample: {
      createMany({ data }) {
        if (fail) return Promise.reject(new Error('db down'));
        rows.push(...data);
        return Promise.resolve({ count: data.length });
      },
      deleteMany({ where }) {
        pruneBefore.push(where.checkedAt.lt);
        return Promise.resolve({ count: 3 });
      },
    },
  };
  return { db, rows, pruneBefore };
}

const sample = (credentialId: string, ok = true) =>
  JSON.stringify({
    providerId: 'p1',
    credentialId,
    ok,
    ...(ok ? { status: 200 } : { status: 401, errorClass: 'auth' }),
    latencyMs: 20,
    checkedAt: '2026-11-20T10:00:00.000Z',
  });

describe('drainHealthSamples', () => {
  it('writes queued samples and prunes rows past retention', async () => {
    // The gateway uses LPUSH, so the oldest sample sits at the tail.
    const queue = fakeQueue([sample('c2', false), sample('c1')]);
    const { db, rows, pruneBefore } = fakeDb();
    const now = Date.parse('2026-11-20T12:00:00.000Z');
    const result = await drainHealthSamples(db, queue, logger, {
      retentionDays: 7,
      now: () => now,
    });
    expect(result).toEqual({ written: 2, invalid: 0, pruned: 3 });
    expect(rows.map((r) => [r.credentialId, r.ok, r.errorClass])).toEqual([
      ['c1', true, null],
      ['c2', false, 'auth'],
    ]);
    expect(pruneBefore[0]?.toISOString()).toBe('2026-11-13T12:00:00.000Z');
    expect(queue.items).toEqual([]);
  });

  it('drops malformed entries without failing the batch', async () => {
    const queue = fakeQueue(['{not json', JSON.stringify({ providerId: 'p1' }), sample('c1')]);
    const { db, rows } = fakeDb();
    const result = await drainHealthSamples(db, queue, logger);
    expect(result.written).toBe(1);
    expect(result.invalid).toBe(2);
    expect(rows).toHaveLength(1);
  });

  it('requeues the batch when the insert fails', async () => {
    const original = [sample('c2'), sample('c1')];
    const queue = fakeQueue([...original]);
    const { db } = fakeDb(true);
    await expect(drainHealthSamples(db, queue, logger)).rejects.toThrow('db down');
    expect(queue.items).toEqual(original);
  });

  it('reads in batches until the list is empty', async () => {
    const queue = fakeQueue(Array.from({ length: 5 }, (_, i) => sample(`c${String(i)}`)));
    const { db, rows } = fakeDb();
    const result = await drainHealthSamples(db, queue, logger, { batchSize: 2 });
    expect(result.written).toBe(5);
    expect(rows).toHaveLength(5);
  });
});
