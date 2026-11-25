/**
 * Routing policies (cards 32.1, 32.5 and 32.7): what an administrator sets on the organization, a
 * project or a key, e.g. default provider preferences and the lock that stops a key's client from
 * overriding them. The gateway reads them from the snapshot, so every change is followed by a
 * rebuild.
 */
import { RoutingPolicy, RoutingPolicyScope } from '@dirouter/contracts';
import { Prisma } from '@dirouter/db';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

export const RoutingPolicyBody = z.object({
  scope: RoutingPolicyScope,
  /** The organization's own id for `organization`, otherwise a project or key id. */
  scopeId: z.string().min(1).max(100),
  /** `null` removes the scope's policy (it then inherits from the broader scopes). */
  policy: RoutingPolicy.nullable(),
});
export type RoutingPolicyBody = z.infer<typeof RoutingPolicyBody>;

@Injectable()
export class RoutingPoliciesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
  ) {}

  get #db() {
    return this.prisma.client;
  }

  async list(org: OrgContext) {
    const rows = await this.#db.routingPolicySetting.findMany({
      where: { organizationId: org.organizationId },
      orderBy: [{ scope: 'asc' }, { scopeId: 'asc' }],
    });
    return {
      policies: rows.map((r) => ({
        scope: r.scope,
        scopeId: r.scopeId,
        policy: RoutingPolicy.parse(r.policy),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  async set(org: OrgContext, body: RoutingPolicyBody) {
    await this.#ownScope(org, body.scope, body.scopeId);
    const id = { organizationId: org.organizationId, scope: body.scope, scopeId: body.scopeId };
    const empty = !body.policy || Object.keys(body.policy).length === 0;
    if (empty) {
      await this.#db.routingPolicySetting.deleteMany({ where: id });
    } else {
      const policy = body.policy as Prisma.InputJsonValue;
      await this.#db.routingPolicySetting.upsert({
        where: { organizationId_scope_scopeId: id },
        create: { ...id, policy, updatedById: org.userId },
        update: { policy, updatedById: org.userId },
      });
    }
    await this.#db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org.organizationId,
        actorUserId: org.userId,
        ...(org.ip ? { ip: org.ip } : {}),
        action: 'routing_policy.updated',
        targetType: body.scope,
        targetId: body.scopeId,
        diff: { policy: empty ? null : (body.policy as Prisma.InputJsonValue) },
      },
    });
    const version = await this.snapshots.rebuild('routing policy changed');
    return {
      scope: body.scope,
      scopeId: body.scopeId,
      policy: empty ? null : body.policy,
      configVersion: version,
    };
  }

  /** The scope must exist inside this organization; anything else reads as not found. */
  async #ownScope(org: OrgContext, scope: RoutingPolicyBody['scope'], scopeId: string) {
    const found =
      scope === 'organization'
        ? scopeId === org.organizationId
        : scope === 'project'
          ? (await this.#db.project.count({
              where: { id: scopeId, organizationId: org.organizationId, deletedAt: null },
            })) > 0
          : (await this.#db.apiKey.count({
              where: { id: scopeId, organizationId: org.organizationId },
            })) > 0;
    if (!found) throw new DiRouterError('not_found', { message: `${scope} not found` });
  }
}
