/**
 * Admission of a long-running job (a batch, card 30.1, or an async task, card 30.6), with the same
 * guard as a chat request (spend-guard.ts `admitRequest`): a blocked end user is refused, every
 * budget that covers the request must have room (key, project, team, organization, member, end
 * user, tags, cost center, and the model, provider, upstream account and credential budgets and
 * quota windows of the candidates, which take used-up candidates out), the rate limits count one
 * request, and a prepaid wallet holds the job's worst case until the job ends. Throws the client
 * error when the job may not start.
 */
import type { VirtualKeyConfig } from '@dirouter/contracts';
import type { Candidate } from '@dirouter/routing';
import { DiRouterError } from '@dirouter/shared';

import type { Attribution } from '../attribution.js';
import type { LoadedConfig } from '../config-store.js';
import { admitRequest } from '../spend-guard.js';
import type { JobsDeps } from './context.js';

export interface JobAdmission {
  id: string;
  what: string;
  /** The most the job may cost; a function gets the candidates left after the budgets. */
  worstUsd: string | ((candidates: Candidate[]) => string);
  holdMs: number;
  /** The routed candidates; their model, provider and credential budgets and quotas apply. */
  candidates?: readonly Candidate[];
  /** End user, tags and cost center of the request (card 33.2 and 33.4). */
  attribution?: Attribution;
  /** The model name the client asked for. */
  requested?: string;
}

/**
 * Admits the job and returns the candidates it may run on (those of `input.candidates` whose
 * budgets and quota windows have room, in reset-aware order); `[]` when no candidates were given.
 */
export async function admitJob(
  deps: JobsDeps,
  config: LoadedConfig,
  key: VirtualKeyConfig,
  input: JobAdmission,
): Promise<Candidate[]> {
  const admission = await admitRequest(deps, {
    config,
    key,
    candidates: input.candidates ?? [],
    requested: input.requested ?? '',
    estimatedTokens: 0,
    requestId: input.id,
    ...(input.attribution ? { attribution: input.attribution } : {}),
  });
  if (!admission.ok) {
    deps.metrics?.reject(admission.metric.guard, admission.metric.reason);
    throw admission.error;
  }
  // The job is one request in the rate windows; its spend is counted when it settles.
  admission.cancel();
  const candidates = admission.candidates;

  const worstUsd =
    typeof input.worstUsd === 'function' ? input.worstUsd(candidates) : input.worstUsd;
  if (key.walletId && deps.wallets) {
    const hold = await deps.wallets.reserve(key.walletId, input.id, worstUsd, input.holdMs);
    if (!hold.ok) {
      deps.metrics?.reject('wallet', hold.unavailable ? 'unavailable' : 'insufficient');
      throw new DiRouterError('insufficient_credit', {
        message: hold.unavailable
          ? 'Wallet check unavailable (fail-closed), retry shortly'
          : `Insufficient credit: this ${input.what} may cost up to USD ${hold.neededUsd}, available USD ${hold.availableUsd}`,
      });
    }
  }
  return candidates;
}

/** Gives back the wallet hold of a job that could not start. */
export function releaseJob(deps: JobsDeps, key: VirtualKeyConfig, id: string): void {
  if (key.walletId) deps.wallets?.settle(key.walletId, id, '0');
}
