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
import { can, type Permission, type Role } from './permissions.js';

export const PERMISSION_KEY = 'dirouter:permission';
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);

export interface OrgContext {
  organizationId: string;
  userId: string;
  role: Role;
}

type OrgRequest = FastifyRequest & { user?: AccessClaims; org?: OrgContext };

@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<OrgRequest>();
    const orgId = (req.params as { orgId?: string }).orgId;
    if (!req.user || !orgId) throw new DiRouterError('not_found');
    const membership = await this.prisma.client.membership.findUnique({
      where: { userId_organizationId: { userId: req.user.sub, organizationId: orgId } },
      include: { organization: { select: { deletedAt: true } } },
    });
    if (!membership || membership.organization.deletedAt) throw new DiRouterError('not_found');
    const permission = this.reflector.get<Permission | undefined>(
      PERMISSION_KEY,
      context.getHandler(),
    );
    // Every route must declare its permission; forgetting it means closed, not open.
    if (!permission || !can(membership.role, permission))
      throw new ForbiddenError('forbidden', {
        message: `Requires ${permission ?? 'a declared permission'}`,
      });
    req.org = { organizationId: orgId, userId: req.user.sub, role: membership.role };
    return true;
  }
}

export const Org = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const org = context.switchToHttp().getRequest<OrgRequest>().org;
  if (!org) throw new DiRouterError('not_found');
  return org;
});
