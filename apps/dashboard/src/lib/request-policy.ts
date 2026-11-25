/** Request policy of a model or an alias (sprint 5, epic 31), as the control API takes it. */
export interface RequestPolicy {
  autoCache?: boolean;
  autoCacheTtl?: '5m' | '1h';
}

/** The policy as the API takes it: `null` when nothing is set. */
export function policyBody(policy: RequestPolicy): RequestPolicy | null {
  const clean = Object.fromEntries(
    Object.entries(policy).filter(([, value]) => value !== undefined && value !== false),
  ) as RequestPolicy;
  return Object.keys(clean).length > 0 ? clean : null;
}
