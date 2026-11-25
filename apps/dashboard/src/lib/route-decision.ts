/** Formatting of routing decisions shared by the simulator and the request log (cards 32.5, 32.7). */
import type { TFunction } from 'i18next';

export interface DataPolicyView {
  allowedRegions?: string[];
  allowedCountries?: string[];
  requireZdr?: boolean;
  denyTraining?: boolean;
}

/** `ZDR only · Allowed regions: eu`; empty when the policy sets nothing. */
export function dataPolicyText(t: TFunction, policy: DataPolicyView | undefined | null): string {
  if (!policy) return '';
  const parts: string[] = [];
  if (policy.requireZdr) parts.push(t('routingRequests.policy.requireZdr'));
  if (policy.denyTraining) parts.push(t('routingRequests.policy.denyTraining'));
  if (policy.allowedRegions)
    parts.push(
      `${t('routingRequests.policy.allowedRegions')}: ${policy.allowedRegions.join(', ')}`,
    );
  if (policy.allowedCountries)
    parts.push(
      `${t('routingRequests.policy.allowedCountries')}: ${policy.allowedCountries.join(', ')}`,
    );
  return parts.join(' · ');
}

/** A skip reason, from the sprint 2 simulator messages or the request-routing ones. */
export function reasonText(t: TFunction, reason: string): string {
  return t(`s2.simulator.reason.${reason}`, {
    defaultValue: t(`routingRequests.reason.${reason}`, { defaultValue: reason }),
  });
}
