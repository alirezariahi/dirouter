/**
 * Operator-only routes (sprint 3 billing): the organization in the path must be the platform
 * organization. Runs after OrgGuard, which has already checked membership and the permission.
 * Any other organization gets 404, the same answer as a route that does not exist.
 */
import { DiRouterError } from '@dirouter/shared';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const org = context.switchToHttp().getRequest<FastifyRequest & { org?: OrgContext }>().org;
    if (!org) throw new DiRouterError('not_found');
    const found = await this.prisma.client.organization.findUnique({
      where: { id: org.organizationId },
      select: { isPlatform: true },
    });
    if (!found?.isPlatform) throw new DiRouterError('not_found');
    return true;
  }
}
