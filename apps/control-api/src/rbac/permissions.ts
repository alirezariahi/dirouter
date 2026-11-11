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

/** Role power order for "you cannot grant a role higher than your own". */
export const ROLE_RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
