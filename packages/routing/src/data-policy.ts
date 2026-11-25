/**
 * Routing by data policy and region (card 32.5): candidates whose provider does not meet the
 * effective policy are removed before anything else, so neither preferences, fallback nor hedging
 * can ever reach them. A provider without metadata fails every requirement it does not prove.
 */
import type { DataPolicy, ProviderConfig } from '@dirouter/contracts';

import type { Candidate, ResolvedRoute } from './router.js';

export type DataPolicyError = {
  error: 'no_provider_matches_data_policy';
  skipped: ResolvedRoute['skipped'];
};

export function isDataPolicyEmpty(policy: DataPolicy | undefined): boolean {
  return (
    !policy ||
    (policy.allowedRegions === undefined &&
      policy.allowedCountries === undefined &&
      policy.requireZdr !== true &&
      policy.denyTraining !== true)
  );
}

/** Why a provider fails the policy, or undefined when it meets it. */
export function dataPolicyViolation(
  provider: ProviderConfig,
  policy: DataPolicy,
): string | undefined {
  const meta = provider.dataPolicy;
  if (policy.requireZdr && meta?.zdr !== true) return 'not_zdr';
  if (policy.denyTraining && meta?.trainsOnData !== false) return 'may_train_on_data';
  if (policy.allowedRegions && !(meta?.region && policy.allowedRegions.includes(meta.region)))
    return 'region_not_allowed';
  if (policy.allowedCountries && !(meta?.country && policy.allowedCountries.includes(meta.country)))
    return 'country_not_allowed';
  return undefined;
}

export function applyDataPolicy(
  route: ResolvedRoute,
  policy: DataPolicy,
): ResolvedRoute | DataPolicyError {
  if (isDataPolicyEmpty(policy)) return route;
  const skipped = [...route.skipped];
  const candidates = route.candidates.filter((c: Candidate) => {
    const reason = dataPolicyViolation(c.provider, policy);
    if (reason) skipped.push({ modelId: c.model.id, credentialId: c.credential.id, reason });
    return reason === undefined;
  });
  if (candidates.length === 0) return { error: 'no_provider_matches_data_policy', skipped };
  return { ...route, candidates, skipped };
}
