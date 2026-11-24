/**
 * Management API tokens of service accounts (card 23.6).
 *
 * - Format: `drm_` and 32 random bytes in base64url. The prefix differs from virtual keys (which the
 *   gateway accepts) and from SCIM tokens, so a leaked token is recognisable and secret scanners
 *   can tell them apart.
 * - Storage: only the SHA-256 of the token (it has 256 bits of entropy, so no slow hash is needed)
 *   and the first 12 characters for display.
 * - Every request looks the token up again: a revoked or expired token, or one of a deleted service
 *   account, is refused on its very next request.
 */
import { createHash, randomBytes } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

import { AuthenticationError, DiRouterError, ForbiddenError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PrismaService } from '../infra/prisma.service.js';
import type { AccessClaims } from './crypto.js';

export const MANAGEMENT_TOKEN_PREFIX = 'drm_';
/** A read is recorded in the audit log at most this often per token (and on a new address). */
export const READ_AUDIT_INTERVAL_MS = 3600_000;
/** `last_used_at` is not rewritten more often than this. */
const LAST_USED_RESOLUTION_MS = 60_000;

export function newManagementToken(): { token: string; hash: string; prefix: string } {
  const token = `${MANAGEMENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashManagementToken(token), prefix: token.slice(0, 12) };
}

export const hashManagementToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export const isManagementToken = (token: string) => token.startsWith(MANAGEMENT_TOKEN_PREFIX);

/** IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is compared as the IPv4 address it carries. */
function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped?.[1] ?? ip;
}

/** An address (`10.0.0.1`, `2001:db8::1`) or a CIDR range (`10.0.0.0/8`, `2001:db8::/32`). */
export function parseIpRule(
  entry: string,
): { address: string; prefix?: number; family: 'ipv4' | 'ipv6' } | undefined {
  const [rawAddress = '', rawPrefix, extra] = entry.trim().split('/');
  if (extra !== undefined) return undefined;
  const address = normalizeIp(rawAddress);
  const version = isIP(address);
  if (version === 0) return undefined;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  if (rawPrefix === undefined) return { address, family };
  if (!/^\d{1,3}$/.test(rawPrefix)) return undefined;
  const prefix = Number(rawPrefix);
  if (prefix > (version === 4 ? 32 : 128)) return undefined;
  return { address, prefix, family };
}

/** Whether `ip` matches one of the rules; an empty list allows every address. */
export function ipAllowed(ip: string | undefined, rules: readonly string[]): boolean {
  if (rules.length === 0) return true;
  if (!ip) return false;
  const address = normalizeIp(ip);
  const version = isIP(address);
  if (version === 0) return false;
  const list = new BlockList();
  for (const entry of rules) {
    const rule = parseIpRule(entry);
    if (!rule) continue;
    if (rule.prefix === undefined) list.addAddress(rule.address, rule.family);
    else list.addSubnet(rule.address, rule.prefix, rule.family);
  }
  return list.check(address, version === 4 ? 'ipv4' : 'ipv6');
}

type TokenRequest = FastifyRequest & { params: unknown };

@Injectable()
export class ManagementTokenAuth {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Validates a management token for this request and records its use. The token only opens routes
   * of its own organization; OrgGuard then checks its scopes against the route's permission.
   */
  async authenticate(token: string, req: TokenRequest): Promise<AccessClaims> {
    const db = this.prisma.client;
    const row = await db.managementToken.findUnique({
      where: { tokenHash: hashManagementToken(token) },
      include: {
        serviceAccount: {
          select: {
            deletedAt: true,
            user: { select: { id: true, email: true, isActive: true, deletedAt: true } },
          },
        },
      },
    });
    const now = Date.now();
    const account = row?.serviceAccount;
    if (
      !row ||
      !account ||
      row.revokedAt ||
      (row.expiresAt && row.expiresAt.getTime() <= now) ||
      account.deletedAt ||
      !account.user.isActive ||
      account.user.deletedAt
    )
      throw new AuthenticationError('unauthenticated', {
        message: 'The management token is invalid, expired or revoked',
      });
    if (!ipAllowed(req.ip, row.allowedIps))
      throw new ForbiddenError('forbidden', {
        message: 'This management token is not allowed from this address',
      });
    const orgId = (req.params as { orgId?: string } | undefined)?.orgId;
    if (!orgId)
      throw new ForbiddenError('forbidden', {
        message: 'Management tokens only work on the routes of their organization',
      });
    // Another organization looks as if it did not exist, like for a non-member.
    if (orgId !== row.organizationId) throw new DiRouterError('not_found');

    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const last = row.lastUsedAt?.getTime();
    const newAddress = row.lastUsedIp !== req.ip;
    if (last === undefined || now - last >= LAST_USED_RESOLUTION_MS || newAddress)
      await db.managementToken.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date(now), lastUsedIp: req.ip },
      });
    // Every change made with a token is in the audit log, and reads at least once an hour and from
    // every new address; the change itself is also audited by its route with the service account
    // as the actor.
    if (mutating || last === undefined || now - last >= READ_AUDIT_INTERVAL_MS || newAddress)
      await db.auditLog.create({
        data: {
          id: prefixedId('aud'),
          organizationId: row.organizationId,
          actorUserId: account.user.id,
          ...(req.ip ? { ip: req.ip } : {}),
          action: 'management_token.used',
          targetType: 'management_token',
          targetId: row.id,
          diff: { method: req.method, route: req.routeOptions.url ?? req.url.split('?')[0] ?? '' },
        },
      });
    return {
      sub: account.user.id,
      email: account.user.email,
      token: {
        id: row.id,
        organizationId: row.organizationId,
        serviceAccountId: row.serviceAccountId,
        scopes: row.scopes,
      },
    };
  }
}
