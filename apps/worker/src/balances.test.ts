/** Upstream balance samples from the gateway into credential_balances (card 32.9). */
import { UPSTREAM_BALANCES_KEY } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { type BalanceDb, drainBalances } from './balances.js';

const logger = { warn: () => undefined } as never;

const sample = (credentialId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    providerId: 'p1',
    credentialId,
    kind: 'openrouter',
    ok: true,
    amount: '12.5',
    currency: 'USD',
    checkedAt: '2026-11-25T10:00:00.000Z',
    ...over,
  });

function fake(alive: string[]) {
  const upserts: Parameters<BalanceDb['credentialBalance']['upsert']>[0][] = [];
  const db: BalanceDb = {
    credential: {
      findMany: ({ where }) =>
        Promise.resolve(where.id.in.filter((id) => alive.includes(id)).map((id) => ({ id }))),
    },
    credentialBalance: {
      upsert: (args) => {
        upserts.push(args);
        return Promise.resolve({});
      },
    },
  };
  return { db, upserts };
}

describe('drainBalances', () => {
  it('stores the newest sample per credential and drops malformed and orphaned ones', async () => {
    const { db, upserts } = fake(['c1', 'c2']);
    const items = [
      sample('c1', { amount: '20' }),
      'not json',
      sample('c1', { amount: '0.75', checkedAt: '2026-11-25T11:00:00.000Z' }),
      sample('gone'),
      sample('c2', { ok: false, amount: undefined, currency: undefined, error: 'HTTP 401' }),
    ];
    let popped = false;
    const queue = {
      rpop: (key: string) => {
        expect(key).toBe(UPSTREAM_BALANCES_KEY);
        if (popped) return Promise.resolve(null);
        popped = true;
        return Promise.resolve(items);
      },
    };
    expect(await drainBalances(db, queue, logger)).toEqual({ written: 3, invalid: 1, skipped: 1 });
    expect(upserts.filter((u) => u.where.credentialId === 'c1').at(-1)?.create).toMatchObject({
      amount: '0.75',
      currency: 'USD',
      ok: true,
    });
    // A failed lookup keeps the last known amount: the update does not touch it.
    const failed = upserts.find((u) => u.where.credentialId === 'c2');
    expect(failed?.update).toEqual({
      providerId: 'p1',
      kind: 'openrouter',
      ok: false,
      error: 'HTTP 401',
      checkedAt: new Date('2026-11-25T10:00:00.000Z'),
    });
    expect(failed?.update).not.toHaveProperty('amount');
  });

  it('does nothing on an empty list', async () => {
    const { db, upserts } = fake([]);
    expect(await drainBalances(db, { rpop: () => Promise.resolve(null) }, logger)).toEqual({
      written: 0,
      invalid: 0,
      skipped: 0,
    });
    expect(upserts).toEqual([]);
  });
});
