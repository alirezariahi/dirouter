/**
 * Pure rules for OIDC single sign-on (card 14.2): which roles a connection may hand out, which email
 * domains it serves, which issuer URLs the server is willing to contact, and where the provider may
 * send the browser back. Kept free of I/O (except the DNS lookup helper) so the rules are unit tested.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { DiRouterError } from '@dirouter/shared';

import { ROLE_RANK, type Role } from '../rbac/permissions.js';

const isRole = (value: unknown): value is Role =>
  value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER' || value === 'VIEWER';

/** Role given to users whose stored default is unusable (a legacy OWNER default). */
const SAFE_DEFAULT_ROLE: Role = 'MEMBER';

/**
 * Role for an SSO login. OWNER is never assigned through SSO, whatever the stored configuration
 * says: ownership is only granted by an existing owner on the Members page. `matched` tells whether
 * a group mapping (rather than the default role) produced the result.
 */
export function resolveSsoRole(
  groupRoleMap: Record<string, unknown>,
  groups: readonly string[],
  fallback: Role,
): { role: Role; matched: boolean } {
  let best: Role | undefined;
  for (const group of groups) {
    const role = Object.hasOwn(groupRoleMap, group) ? groupRoleMap[group] : undefined;
    if (!isRole(role) || role === 'OWNER') continue;
    if (!best || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  if (best) return { role: best, matched: true };
  return { role: fallback === 'OWNER' ? SAFE_DEFAULT_ROLE : fallback, matched: false };
}

export function mapGroupsToRole(
  groupRoleMap: Record<string, unknown>,
  groups: readonly string[],
  fallback: Role,
): Role {
  return resolveSsoRole(groupRoleMap, groups, fallback).role;
}

/**
 * Role for an existing member after an SSO login: only an explicit group mapping can raise it (the
 * default role never does), it is never lowered, and it never becomes OWNER.
 */
export function ssoRoleForExistingMember(
  current: Role,
  resolved: { role: Role; matched: boolean },
): Role {
  if (!resolved.matched || resolved.role === 'OWNER') return current;
  return ROLE_RANK[resolved.role] > ROLE_RANK[current] ? resolved.role : current;
}

/**
 * Validation of the roles in a connection: never OWNER, and never above the editor's own role, so
 * `security:write` cannot be turned into a higher role through an identity provider the editor controls.
 */
export function assertSsoRolesAllowed(
  actorRole: Role,
  roles: { defaultRole?: Role | undefined; groupRoleMap?: Record<string, Role> | undefined },
): void {
  const named: [string, Role][] = [
    ...(roles.defaultRole ? ([['defaultRole', roles.defaultRole]] as [string, Role][]) : []),
    ...Object.entries(roles.groupRoleMap ?? {}).map(
      ([group, role]) => [`groupRoleMap.${group}`, role] as [string, Role],
    ),
  ];
  for (const [where, role] of named) {
    if (!isRole(role))
      throw new DiRouterError('validation_failed', { message: `${where}: unknown role` });
    if (role === 'OWNER')
      throw new DiRouterError('validation_failed', {
        message: `${where}: the OWNER role cannot be assigned through SSO`,
      });
    if (ROLE_RANK[role] > ROLE_RANK[actorRole])
      throw new DiRouterError('forbidden', {
        message: `${where}: cannot map a role above your own`,
      });
  }
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * A connection must name the email domains it serves. Without the list any address the provider
 * asserts would be accepted, including addresses of people outside the organization.
 */
export function normalizeAllowedDomains(domains: readonly string[] | undefined): string[] {
  const unique = [...new Set((domains ?? []).map((domain) => domain.trim().toLowerCase()))];
  if (unique.length === 0)
    throw new DiRouterError('validation_failed', {
      message: 'allowedDomains must list at least one email domain',
    });
  const invalid = unique.filter((domain) => !DOMAIN.test(domain));
  if (invalid.length > 0)
    throw new DiRouterError('validation_failed', {
      message: `Invalid email domains: ${invalid.join(', ')}`,
    });
  return unique;
}

/** Callback-time check; an empty list (a connection saved before the rule) allows nothing. */
export function emailDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  return allowedDomains.includes(email.slice(at + 1).toLowerCase());
}

// Addresses a server-side fetch must never reach on behalf of a tenant: loopback, private ranges,
// link-local (cloud metadata lives there), carrier-grade NAT, multicast and other reserved space.
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 127], // unspecified and loopback
  ['64:ff9b::', 96], // NAT64
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  BLOCKED.addSubnet(network, prefix, 'ipv6');

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return BLOCKED.check(mapped[1], 'ipv4');
  return BLOCKED.check(address, 'ipv6');
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

/**
 * Syntax and scheme of a URL the server will fetch for a tenant (issuer, discovery endpoints).
 * https is required; plain http is accepted outside production for a local development provider.
 */
export function parseOutboundUrl(value: string, production: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DiRouterError('validation_failed', { message: 'SSO URL is not a valid URL' });
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production))
    throw new DiRouterError('validation_failed', { message: 'SSO URLs must use https' });
  if (url.username || url.password)
    throw new DiRouterError('validation_failed', {
      message: 'SSO URLs must not contain credentials',
    });
  return url;
}

/**
 * Full check before a server-side request. In production every address the host resolves to must
 * be public; development keeps private addresses so a local Keycloak works.
 */
export async function assertOutboundUrlAllowed(
  value: string,
  production: boolean,
  resolve: Resolver = systemResolver,
): Promise<URL> {
  const url = parseOutboundUrl(value, production);
  if (!production) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host) !== 0) addresses = [host];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      addresses = [];
    }
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress))
    throw new DiRouterError('validation_failed', {
      message: 'SSO URL must resolve to a public address',
    });
  return url;
}

/**
 * The redirect URI is derived from server configuration, never from the caller. A value sent by the
 * client is only accepted when it is that same URI; outside production the scheme may differ, since
 * the development dashboard is also served over plain http.
 */
export function resolveRedirectUri(
  publicDashboardUrl: string,
  requested: string | undefined,
  production: boolean,
): string {
  const configured = `${publicDashboardUrl.replace(/\/+$/, '')}/login`;
  if (requested === undefined || requested === configured) return configured;
  const withoutScheme = (value: string) => value.replace(/^https?:/i, '');
  if (!production && withoutScheme(requested) === withoutScheme(configured)) return requested;
  throw new DiRouterError('validation_failed', {
    message: 'redirectUri does not match the configured dashboard URL',
  });
}
