/**
 * Admission of a long-running job (a batch, card 30.1, or an async task, card 30.6): the key's
 * rate limit counts one request, its budgets must have room and a prepaid wallet holds the job's
 * worst case until the job ends. Throws the client error when the job may not start.
 */
import type { VirtualKeyConfig } from '@dirouter/contracts';
import { DiRouterError } from '@dirouter/shared';

import type { LoadedConfig } from '../config-store.js';
import { budgetScopes, limitScopes } from '../proxy.js';
import type { JobsDeps } from './context.js';

export async function admitJob(
  deps: JobsDeps,
  config: LoadedConfig,
  key: VirtualKeyConfig,
  input: { id: string; what: string; worstUsd: string; holdMs: number },
): Promise<void> {
  const admission = deps.limiter
    ? await deps.limiter.acquire(limitScopes(config, key), 0, input.id)
    : undefined;
  if (admission && !admission.ok) {
    deps.metrics?.reject('rate_limit', admission.unavailable ? 'unavailable' : admission.kind);
    throw new DiRouterError('rate_limited', {
      message: admission.unavailable
        ? 'Rate limiter unavailable (fail-closed), retry shortly'
        : `Rate limit exceeded for ${admission.scope.split(':')[0] ?? 'key'} (${admission.kind})`,
      status: 429,
    });
  }
  admission?.settle(0);
  admission?.release();

  const budgetCheck = deps.budgets
    ? await deps.budgets.check(budgetScopes(config, key))
    : { ok: true as const };
  if (!budgetCheck.ok) {
    deps.metrics?.reject('budget', budgetCheck.unavailable ? 'unavailable' : budgetCheck.kind);
    throw new DiRouterError('budget_exceeded', {
      message: budgetCheck.unavailable
        ? 'Budget check unavailable (fail-closed), retry shortly'
        : `${budgetCheck.period === 'daily' ? 'Daily' : 'Monthly'} ${budgetCheck.scope} budget exceeded`,
    });
  }

  if (key.walletId && deps.wallets) {
    const hold = await deps.wallets.reserve(key.walletId, input.id, input.worstUsd, input.holdMs);
    if (!hold.ok) {
      deps.metrics?.reject('wallet', hold.unavailable ? 'unavailable' : 'insufficient');
      throw new DiRouterError('insufficient_credit', {
        message: hold.unavailable
          ? 'Wallet check unavailable (fail-closed), retry shortly'
          : `Insufficient credit: this ${input.what} may cost up to USD ${hold.neededUsd}, available USD ${hold.availableUsd}`,
      });
    }
  }
}

/** Gives back the wallet hold of a job that could not start. */
export function releaseJob(deps: JobsDeps, key: VirtualKeyConfig, id: string): void {
  if (key.walletId) deps.wallets?.settle(key.walletId, id, '0');
}
