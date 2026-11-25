/**
 * The job store (cards 30.1 and 30.6) behaves the same in memory and in Valkey. The Valkey part
 * runs with INTEGRATION_VALKEY_URL.
 */
import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { type JobStore, MemoryJobStore, RedisJobStore } from './store.js';

function contract(name: string, make: () => JobStore) {
  describe(name, () => {
    it('keeps records per organization, newest first, with cursor pages', async () => {
      const store = make();
      const org = `org-${randomUUID()}`;
      for (let i = 0; i < 5; i++)
        await store.put(
          'batch',
          `${org}-b${String(i)}`,
          { n: i },
          { ttlSeconds: 60, organizationId: org, createdAt: 1_000 + i },
        );
      await store.put(
        'batch',
        `x-${randomUUID()}`,
        { n: 99 },
        { ttlSeconds: 60, organizationId: `${org}-other` },
      );
      const first = await store.list<{ n: number }>('batch', org, { limit: 2 });
      expect(first.data.map((d) => d.n)).toEqual([4, 3]);
      expect(first.hasMore).toBe(true);
      const next = await store.list<{ n: number }>('batch', org, { after: `${org}-b3`, limit: 10 });
      expect(next.data.map((d) => d.n)).toEqual([2, 1, 0]);
      expect(next.hasMore).toBe(false);
      await store.delete('batch', `${org}-b4`, org);
      expect(await store.get('batch', `${org}-b4`)).toBeUndefined();
      expect((await store.list('batch', org, { limit: 10 })).data).toHaveLength(4);
    });

    it('hands out due items and locks them one at a time', async () => {
      const store = make();
      const id = randomUUID();
      await store.schedule('task', id, Date.now() - 10);
      await store.schedule('task', `${id}-later`, Date.now() + 60_000);
      const due = await store.due(Date.now(), 1_000);
      expect(due).toContainEqual({ kind: 'task', id });
      expect(due).not.toContainEqual({ kind: 'task', id: `${id}-later` });
      expect(await store.lock('task', id, 5_000)).toBe(true);
      expect(await store.lock('task', id, 5_000)).toBe(false);
      await store.unlock('task', id);
      expect(await store.lock('task', id, 5_000)).toBe(true);
      await store.unschedule('task', id);
      expect(await store.due(Date.now(), 1_000)).not.toContainEqual({ kind: 'task', id });
    });
  });
}

contract('memory job store', () => new MemoryJobStore());

describe('memory job store expiry', () => {
  it('drops records after their TTL', async () => {
    let now = 0;
    const store = new MemoryJobStore(() => now);
    await store.put('file', 'f', { a: 1 }, { ttlSeconds: 10, organizationId: 'o' });
    now = 11_000;
    expect(await store.get('file', 'f')).toBeUndefined();
    expect((await store.list('file', 'o', { limit: 10 })).data).toEqual([]);
  });
});

const valkeyUrl = process.env.INTEGRATION_VALKEY_URL;
describe.skipIf(!valkeyUrl)('valkey job store', () => {
  const redis = valkeyUrl ? new Redis(valkeyUrl) : undefined;
  afterAll(async () => {
    await redis?.quit();
  });
  contract('valkey', () => new RedisJobStore(redis as Redis));
});
