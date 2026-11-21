/**
 * Organization-level role access matrix (card 3.5). Single source for the Guard, tests, and docs/rbac.md.
 * Permissions for later cards (provider, key, model, usage) are also defined here so the matrix is complete.
 */
export const PERMISSIONS = [
  'org:read',
  'org:write',
  'members:read',
  'members:write',
  'invites:write',
  'teams:read',
  'teams:write',
  'projects:read',
  'projects:write',
  'providers:read',
  'providers:write',
  'keys:read',
  'keys:write',
  'models:read',
  'models:write',
  'usage:read',
  'audit:read',
  /** Guardrail policies (card 15.1), notification alerts (16.2) and config versions (17.1). */
  'guardrails:read',
  'guardrails:write',
  'alerts:read',
  'alerts:write',
  'config:read',
  'config:write',
  /** SSO, custom roles and MASTER_KEY rotation (cards 14.2-14.5). */
  'security:write',
  /** Manual reset of the breaker and cooldown on the Health page (card 7.8); OWNER and ADMIN only. */
  'health:write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

const READ = PERMISSIONS.filter((p) => p.endsWith(':read'));

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  // ADMIN can do everything except what only the owner can do (in the service: only OWNER can grant or revoke the OWNER role).
  ADMIN: new Set(PERMISSIONS),
  // MEMBER can see everything and create their own keys and projects, but not the organization configuration.
  MEMBER: new Set<Permission>([...READ, 'projects:write', 'keys:write']),
  VIEWER: new Set<Permission>(READ),
};

/** Credentials and secrets are never read; provider:read is metadata only. */
export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Effective permission of a membership: the base role plus the optional custom role (card 14.3).
 * Custom roles can only add permissions; they never remove what the base role grants.
 */
export function canAny(
  role: Role,
  customPermissions: readonly string[] | undefined,
  permission: Permission,
): boolean {
  return can(role, permission) || (customPermissions ?? []).includes(permission);
}

/** Role power order for "you cannot grant a role higher than your own". */
export const ROLE_RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

/** Every permission a membership holds: the base role plus its optional custom role. */
export function effectivePermissions(
  role: Role,
  customPermissions?: readonly string[],
): ReadonlySet<string> {
  return new Set<string>([...ROLE_PERMISSIONS[role], ...(customPermissions ?? [])]);
}

/** Permissions in `requested` that the holder of `held` does not have (empty means a subset). */
export function missingPermissions(
  held: ReadonlySet<string>,
  requested: readonly string[],
): string[] {
  return [...new Set(requested)].filter((permission) => !held.has(permission));
}

export interface MemberPower {
  role: Role;
  customPermissions?: readonly string[] | undefined;
}

/**
 * Whether `actor` may modify or remove `target` (card 14.3): the target must not outrank the actor
 * and must not hold any permission the actor lacks. Otherwise a holder of `members:write` could
 * demote or remove somebody more powerful than themselves.
 */
export function canManageMember(actor: MemberPower, target: MemberPower): boolean {
  if (ROLE_RANK[target.role] > ROLE_RANK[actor.role]) return false;
  const held = effectivePermissions(actor.role, actor.customPermissions);
  return (
    missingPermissions(held, [...effectivePermissions(target.role, target.customPermissions)])
      .length === 0
  );
}

/**
 * Whether the organization's MFA policy covers this role. SSO-only organizations delegate the
 * second factor to their identity provider, so the local policy does not apply there. The exemption
 * needs an enabled SSO connection: with password login "disabled" but no usable connection left,
 * password login works again (see AuthService) and so the policy must apply again as well.
 */
export function mfaPolicyApplies(
  role: string,
  organization: {
    mfaRequiredRoles: readonly string[];
    passwordLoginDisabled: boolean;
    hasEnabledSso: boolean;
  },
): boolean {
  const delegated = organization.passwordLoginDisabled && organization.hasEnabledSso;
  return !delegated && organization.mfaRequiredRoles.includes(role);
}

/** How the session was established; carried in the access token (`amr` claim). */
export type AuthMethod = 'pwd' | 'passkey' | 'sso';

/**
 * Whether a session satisfies a mandatory-MFA policy.
 * - passkey: counts only when the session was actually opened with it (user verification is
 *   required there); merely having one registered does not, because password login never asks for it.
 * - sso: the organization's own identity provider authenticated the user and owns the second
 *   factor; such a session is only valid inside that organization (see OrgGuard).
 * - pwd: a confirmed TOTP secret is required, which password login always asks for.
 */
export function secondFactorSatisfied(method: AuthMethod, totpEnabled: boolean): boolean {
  return method === 'passkey' || method === 'sso' || totpEnabled;
}
