/**
 * Organization Guard: the authenticated user must be a member of `:orgId`, and their role must grant the route's permission.
 * Not being a member returns 404 (not 403) so the existence of other organizations is not leaked.
 */
import { DiRouterError, ForbiddenError } from '@dirouter/shared';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import type { AccessClaims } from '../auth/crypto.js';
import { PrismaService } from '../infra/prisma.service.js';
import {
  canAny,
  mfaPolicyApplies,
  type Permission,
  type Role,
  secondFactorSatisfied,
} from './permissions.js';

export const PERMISSION_KEY = 'dirouter:permission';
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);

export interface OrgContext {
  organizationId: string;
  userId: string;
  role: Role;
  /** Permissions added by the member's custom role (card 14.3); absent means none. */
  customPermissions?: readonly string[] | undefined;
  /** Client address for the audit trail (card 14.4); undefined in tests and background jobs. */
  ip?: string | undefined;
}

type OrgRequest = FastifyRequest & { user?: AccessClaims; org?: OrgContext };

@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async #totpEnabled(userId: string): Promise<boolean> {
    const totp = await this.prisma.client.userMfa.findUnique({
      where: { userId },
      select: { enabled: true },
    });
    return totp?.enabled === true;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<OrgRequest>();
    const orgId = (req.params as { orgId?: string }).orgId;
    if (!req.user || !orgId) throw new DiRouterError('not_found');
    // An SSO session is vouched for by one organization's identity provider and is valid only there
    // (card 14.2); the user's other organizations look as if they did not exist.
    if (req.user.amr === 'sso' && req.user.org !== orgId) throw new DiRouterError('not_found');
    const membership = await this.prisma.client.membership.findUnique({
      where: { userId_organizationId: { userId: req.user.sub, organizationId: orgId } },
      include: {
        organization: {
          select: {
            deletedAt: true,
            mfaRequiredRoles: true,
            passwordLoginDisabled: true,
            ssoConnections: { where: { enabled: true }, select: { id: true }, take: 1 },
          },
        },
        customRole: { select: { permissions: true } },
      },
    });
    if (!membership || membership.organization.deletedAt) throw new DiRouterError('not_found');
    const permission = this.reflector.get<Permission | undefined>(
      PERMISSION_KEY,
      context.getHandler(),
    );
    // Every route must declare its permission; forgetting it means closed, not open.
    if (!permission || !canAny(membership.role, membership.customRole?.permissions, permission))
      throw new ForbiddenError('forbidden', {
        message: `Requires ${permission ?? 'a declared permission'}`,
      });
    // Mandatory MFA per role (card 14.1): without a second factor the organization stays closed.
    // The user can still sign in and reach /auth/mfa and /auth/webauthn (not organization routes)
    // to enroll, so nobody is locked out by the policy itself. A registered passkey only counts for
    // sessions that were opened with it; password sessions need TOTP, which login enforces.
    const organization = membership.organization;
    if (
      mfaPolicyApplies(membership.role, {
        mfaRequiredRoles: organization.mfaRequiredRoles,
        passwordLoginDisabled: organization.passwordLoginDisabled,
        hasEnabledSso: organization.ssoConnections.length > 0,
      }) &&
      !secondFactorSatisfied(req.user.amr ?? 'pwd', await this.#totpEnabled(req.user.sub))
    )
      throw new DiRouterError('mfa_enrollment_required');
    req.org = {
      organizationId: orgId,
      userId: req.user.sub,
      role: membership.role,
      customPermissions: membership.customRole?.permissions ?? [],
      ip: req.ip,
    };
    return true;
  }
}

export const Org = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const org = context.switchToHttp().getRequest<OrgRequest>().org;
  if (!org) throw new DiRouterError('not_found');
  return org;
});
