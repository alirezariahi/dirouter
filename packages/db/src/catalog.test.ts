import { describe, expect, it } from 'vitest';

import { approveCatalogProposal } from './catalog.js';

/**
 * An in-memory stand-in for two transactions running side by side under READ COMMITTED: every
 * call yields first, so both approvals read before either writes, while a conditional
 * `updateMany` checks and sets in one step like the row-locked UPDATE in PostgreSQL does.
 */
function fakeDb() {
  const proposal = {
    id: 'cpp_1',
    catalogKey: 'openai/gpt-x',
    status: 'pending' as string,
    proposedPricing: { inputPerMTok: '2', outputPerMTok: '8' },
    decidedById: null as string | null,
    appliedModels: null as number | null,
  };
  const repriced: string[] = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const tx = {
    catalogPriceProposal: {
      findUnique: async () => {
        await tick();
        return { ...proposal };
      },
      findUniqueOrThrow: async () => {
        await tick();
        return { ...proposal };
      },
      update: async ({ data }: { data: Partial<typeof proposal> }) => {
        await tick();
        Object.assign(proposal, data);
        return { ...proposal };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Partial<typeof proposal>;
      }) => {
        await tick();
        if (where.id !== proposal.id || (where.status && where.status !== proposal.status))
          return { count: 0 };
        Object.assign(proposal, data);
        return { count: 1 };
      },
    },
    catalogModel: { update: async () => tick() },
    model: {
      updateMany: async ({ data }: { data: { inputPrice: string } }) => {
        await tick();
        repriced.push(data.inputPrice);
        return { count: 3 };
      },
    },
  };
  const db = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Parameters<typeof approveCatalogProposal>[0];
  return { db, proposal, repriced };
}

describe('approveCatalogProposal (27.5)', () => {
  it('applies a pending proposal once when two admins approve it at the same time', async () => {
    const { db, proposal, repriced } = fakeDb();
    const results = await Promise.all([
      approveCatalogProposal(db, 'cpp_1', 'usr_a'),
      approveCatalogProposal(db, 'cpp_1', 'usr_b'),
    ]);
    expect(results.filter((r) => r !== undefined)).toEqual([
      { catalogKey: 'openai/gpt-x', appliedModels: 3 },
    ]);
    expect(repriced).toEqual(['2']);
    expect(proposal).toMatchObject({ status: 'approved', appliedModels: 3, decidedById: 'usr_a' });
  });

  it('does nothing for a proposal that is no longer pending', async () => {
    const { db, proposal, repriced } = fakeDb();
    proposal.status = 'superseded';
    expect(await approveCatalogProposal(db, 'cpp_1', 'usr_a')).toBeUndefined();
    expect(repriced).toEqual([]);
    expect(proposal.status).toBe('superseded');
  });
});
