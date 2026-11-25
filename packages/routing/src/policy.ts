/**
 * Effective routing policy of a key (cards 32.1, 32.5 and 32.7): the rules an administrator set on
 * the key's organization, project and the key itself, combined.
 */
import type { ProviderPreferences, RoutingPolicyRule, VirtualKeyConfig } from '@dirouter/contracts';

export interface EffectivePolicy {
  /** Administrator's provider preferences; a more specific scope overrides a field. */
  provider?: ProviderPreferences;
  /** Some scope locked the preferences against the client. */
  lockProvider: boolean;
  /** The rules that applied, broadest first (for the simulator). */
  sources: { scope: RoutingPolicyRule['scope']; scopeId: string }[];
}

/** The rules of the key's organization, project and key, broadest first. */
export function rulesFor(
  rules: readonly RoutingPolicyRule[],
  key: Pick<VirtualKeyConfig, 'id' | 'organizationId' | 'projectId'>,
): RoutingPolicyRule[] {
  const of = (scope: RoutingPolicyRule['scope'], scopeId: string) =>
    rules.find(
      (r) => r.organizationId === key.organizationId && r.scope === scope && r.scopeId === scopeId,
    );
  return [
    of('organization', key.organizationId),
    key.projectId ? of('project', key.projectId) : undefined,
    of('key', key.id),
  ].filter((r): r is RoutingPolicyRule => r !== undefined);
}

export function effectivePolicy(
  rules: readonly RoutingPolicyRule[],
  key: Pick<VirtualKeyConfig, 'id' | 'organizationId' | 'projectId'>,
): EffectivePolicy {
  const applied = rulesFor(rules, key);
  let provider: ProviderPreferences | undefined;
  for (const rule of applied) if (rule.provider) provider = { ...provider, ...rule.provider };
  return {
    ...(provider && Object.keys(provider).length > 0 ? { provider } : {}),
    lockProvider: applied.some((r) => r.lockProvider === true),
    sources: applied.map((r) => ({ scope: r.scope, scopeId: r.scopeId })),
  };
}

/**
 * The preferences a request runs with: the administrator's, overridden field by field by the
 * client's unless the policy is locked (then the client's are ignored).
 */
export function mergePreferences(
  policy: EffectivePolicy,
  client: ProviderPreferences | undefined,
): { preferences?: ProviderPreferences; clientIgnored: boolean } {
  const clientIgnored =
    policy.lockProvider && client !== undefined && Object.keys(client).length > 0;
  const merged = policy.lockProvider ? policy.provider : { ...policy.provider, ...client };
  return {
    ...(merged && Object.keys(merged).length > 0 ? { preferences: merged } : {}),
    clientIgnored,
  };
}
