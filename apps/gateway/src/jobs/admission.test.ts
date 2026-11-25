/**
 * Job admission (cards 30.1 and 30.6) uses the chat path's guard: the candidates' provider,
 * account and credential budgets and quota windows, the end user's block, and candidates whose
 * budget is used up are taken out.
 */
import type { VirtualKeyConfig } from '@dirouter/contracts';
import type { Candidate } from '@dirouter/routing';
import { describe, expect, it } from 'vitest';

import type { BudgetCheck, QuotaRef, ScopedBudget } from '../budget-guard.js';
import type { LoadedConfig } from '../config-store.js';
import { admitJob } from './admission.js';
import type { JobsDeps } from './context.js';

const budget = { id: 'b-acct', period: 'monthly', limitUsd: '1' };
const key = {
  id: 'vk',
  organizationId: 'org',
  projectId: 'prj',
  teamId: null,
  budgets: [],
} as unknown as VirtualKeyConfig;
const candidate = (providerId: string, withBudget: boolean): Candidate =>
  ({
    model: { id: `m-${providerId}`, slug: 'model' },
    provider: {
      id: providerId,
      organizationId: 'org',
      ...(withBudget ? { budgets: [budget] } : {}),
    },
    credential: {
      id: `${providerId}-k`,
      quotaWindows: [{ id: 'w', kind: 'rolling', hours: 5, limitTokens: 100 }],
    },
  }) as unknown as Candidate;
const config = (limits: unknown[] = []) =>
  ({ snapshot: { limits, virtualKeys: [key] } }) as unknown as LoadedConfig;

function depsWith(check: (budgets: ScopedBudget[], quotas: QuotaRef[]) => BudgetCheck) {
  const seen: { budgets: ScopedBudget[]; quotas: QuotaRef[] }[] = [];
  const deps = {
    budgets: {
      check: (budgets: ScopedBudget[], quotas: QuotaRef[]) => {
        seen.push({ budgets, quotas });
        return Promise.resolve(check(budgets, quotas));
      },
      record: () => undefined,
    },
  } as unknown as JobsDeps;
  return { deps, seen };
}

const input = { id: 'job-1', what: 'batch', worstUsd: '0', holdMs: 1_000, requested: 'model' };

describe('job admission', () => {
  it("checks the candidates' account budgets and quota windows", async () => {
    const { deps, seen } = depsWith(() => ({ ok: true }));
    const left = await admitJob(deps, config(), key, {
      ...input,
      candidates: [candidate('a', true), candidate('b', false)],
    });
    expect(left.map((c) => c.provider.id)).toEqual(['a', 'b']);
    expect(seen[0]?.budgets).toContainEqual(
      expect.objectContaining({ scope: 'provider_account', scopeId: 'a', budget }),
    );
    expect(seen[0]?.quotas.map((q) => q.credentialId)).toEqual(['a-k', 'b-k']);
  });

  it('takes out a candidate whose budget is used up, refuses when none is left', async () => {
    const exhausted = (budgets: ScopedBudget[]): BudgetCheck => ({
      ok: true,
      exhausted: budgets
        .filter((b) => b.scope === 'provider_account')
        .map((b) => ({ budget: b, resetAt: new Date(Date.now() + 60_000) })),
    });
    const { deps } = depsWith(exhausted);
    const left = await admitJob(deps, config(), key, {
      ...input,
      candidates: [candidate('a', true), candidate('b', false)],
    });
    expect(left.map((c) => c.provider.id)).toEqual(['b']);
    await expect(
      admitJob(deps, config(), key, { ...input, candidates: [candidate('a', true)] }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it("refuses a blocked end user and counts the end user's budgets", async () => {
    const limits = [
      { organizationId: 'org', scope: 'end_user', scopeId: 'mallory', budgets: [], blocked: true },
      { organizationId: 'org', scope: 'end_user', scopeId: 'alice', budgets: [budget] },
    ];
    const { deps, seen } = depsWith(() => ({ ok: true }));
    await expect(
      admitJob(deps, config(limits), key, { ...input, attribution: { endUser: 'mallory' } }),
    ).rejects.toMatchObject({ code: 'end_user_blocked' });
    await admitJob(deps, config(limits), key, { ...input, attribution: { endUser: 'alice' } });
    expect(seen.at(-1)?.budgets).toContainEqual(
      expect.objectContaining({ scope: 'end_user', scopeId: 'alice' }),
    );
  });

  it('keeps the old call shape (no candidates) working', async () => {
    const { deps } = depsWith(() => ({ ok: true }));
    await expect(admitJob(deps, config(), key, input)).resolves.toEqual([]);
  });
});
