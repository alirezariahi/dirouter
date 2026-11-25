/**
 * Controls of automatic routing (card 32.8): the organization's policy (cost tier, allowed and
 * denied models, lock, reasoning effort), each key's own policy, and a preview of which models
 * every tier holds. While the organization's policy is locked, a key policy that would widen it
 * is refused (the gateway also only lets it narrow).
 */
import type { AutoCostTier } from '@dirouter/contracts';
import { costTierOf, DEFAULT_COST_TIERS, matchesModel } from '@dirouter/routing';
import { prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';
import { invalid, notFound } from './targets.js';

export interface AutoPolicyInput {
  costTier?: AutoCostTier | null | undefined;
  allowedModels?: string[] | undefined;
  deniedModels?: string[] | undefined;
  locked?: boolean | undefined;
  reasoningEffort?: 'auto' | 'off' | undefined;
}

type Row = NonNullable<
  Awaited<ReturnType<PrismaService['client']['autoRoutingPolicy']['findFirst']>>
>;
const ORDER: Record<AutoCostTier, number> = { low: 0, medium: 1, high: 2 };

export function viewAutoPolicy(row: Row) {
  return {
    scope: row.scope as 'organization' | 'key',
    scopeId: row.scopeId,
    costTier: (row.costTier ?? null) as AutoCostTier | null,
    allowedModels: row.allowedModels,
    deniedModels: row.deniedModels,
    locked: row.locked,
    reasoningEffort: row.reasoningEffort as 'auto' | 'off',
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class AutoRoutingPoliciesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  /** Both levels, the tier ceilings and the tier of every model the organization can use. */
  async get(org: OrgContext) {
    const [rows, settings, platform] = await Promise.all([
      this.db.autoRoutingPolicy.findMany({
        where: { organizationId: org.organizationId },
        orderBy: { scopeId: 'asc' },
      }),
      this.snapshots.gatewaySettings(),
      this.db.organization.findFirst({ where: { isPlatform: true }, select: { id: true } }),
    ]);
    const tiers = {
      ...DEFAULT_COST_TIERS,
      ...((settings as { autoRouting?: { costTiers?: Partial<typeof DEFAULT_COST_TIERS> } })
        .autoRouting?.costTiers ?? {}),
    };
    const models = await this.db.model.findMany({
      where: {
        deletedAt: null,
        enabled: true,
        OR: [
          { organizationId: org.organizationId },
          ...(platform && platform.id !== org.organizationId
            ? [{ organizationId: platform.id, isPublic: true }]
            : []),
        ],
      },
      select: { slug: true, inputPrice: true, outputPrice: true },
      orderBy: { slug: 'asc' },
    });
    const organization = rows.find((r) => r.scope === 'organization');
    return {
      organization: organization ? viewAutoPolicy(organization) : null,
      keys: rows.filter((r) => r.scope === 'key').map(viewAutoPolicy),
      tiers,
      models: models.map((m) => {
        const pricing = {
          inputPerMTok: m.inputPrice.toString(),
          outputPerMTok: m.outputPrice.toString(),
        };
        return {
          slug: m.slug,
          blendedPerMTok: (Number(pricing.inputPerMTok) * 3 + Number(pricing.outputPerMTok)) / 4,
          tier: costTierOf({ pricing }, tiers),
        };
      }),
    };
  }

  #check(input: AutoPolicyInput) {
    for (const p of [...(input.allowedModels ?? []), ...(input.deniedModels ?? [])])
      if (!/^[A-Za-z0-9._:/@*-]{1,200}$/.test(p))
        throw invalid(`'${p}' is not a model name or a pattern with *`);
  }

  async putOrganization(org: OrgContext, input: AutoPolicyInput) {
    this.#check(input);
    const row = await this.#upsert(org, 'organization', org.organizationId, input);
    await this.#audit(org, 'auto_policy.organization_set', org.organizationId, {
      costTier: row.costTier,
      locked: row.locked,
    });
    return viewAutoPolicy(row);
  }

  async putKey(org: OrgContext, keyId: string, input: AutoPolicyInput) {
    this.#check(input);
    const key = await this.db.apiKey.findFirst({
      where: { id: keyId, organizationId: org.organizationId },
      select: { id: true },
    });
    if (!key) throw notFound('key');
    if ('locked' in input && input.locked) throw invalid('locked: only the organization policy');
    const parent = await this.db.autoRoutingPolicy.findUnique({
      where: {
        organizationId_scope_scopeId: {
          organizationId: org.organizationId,
          scope: 'organization',
          scopeId: org.organizationId,
        },
      },
    });
    if (parent?.locked) {
      // An administrator's ceiling: the key may only narrow it.
      const tier = input.costTier ?? null;
      if (parent.costTier && (!tier || ORDER[tier] > ORDER[parent.costTier as AutoCostTier]))
        throw invalid(
          `locked by an administrator: the cost tier cannot be above ${parent.costTier}`,
        );
      if (parent.reasoningEffort === 'off' && input.reasoningEffort === 'auto')
        throw invalid('locked by an administrator: reasoning effort is off');
      // A key entry must be one of the organization's entries, or a model slug one of them covers.
      const outside = (input.allowedModels ?? []).filter(
        (p) =>
          parent.allowedModels.length > 0 &&
          !parent.allowedModels.includes(p) &&
          (p.includes('*') || !matchesModel(parent.allowedModels, p)),
      );
      if (outside.length > 0)
        throw invalid(
          `locked by an administrator: ${outside.join(', ')} is outside the organization's allowed models`,
        );
    }
    const row = await this.#upsert(org, 'key', keyId, { ...input, locked: false });
    await this.#audit(org, 'auto_policy.key_set', keyId, { costTier: row.costTier });
    return viewAutoPolicy(row);
  }

  async remove(org: OrgContext, scope: 'organization' | 'key', scopeId: string) {
    const deleted = await this.db.autoRoutingPolicy.deleteMany({
      where: { organizationId: org.organizationId, scope, scopeId },
    });
    if (deleted.count === 0) throw notFound('automatic routing policy');
    await this.#audit(org, `auto_policy.${scope}_deleted`, scopeId);
    this.snapshots.schedule('auto routing policy deleted', 0);
  }

  async #upsert(
    org: OrgContext,
    scope: 'organization' | 'key',
    scopeId: string,
    input: AutoPolicyInput,
  ) {
    const data = {
      costTier: input.costTier ?? null,
      allowedModels: input.allowedModels ?? [],
      deniedModels: input.deniedModels ?? [],
      locked: input.locked ?? false,
      reasoningEffort: input.reasoningEffort ?? 'auto',
    };
    const row = await this.db.autoRoutingPolicy.upsert({
      where: {
        organizationId_scope_scopeId: { organizationId: org.organizationId, scope, scopeId },
      },
      create: {
        id: prefixedId('arp'),
        organizationId: org.organizationId,
        scope,
        scopeId,
        ...data,
      },
      update: data,
    });
    this.snapshots.schedule('auto routing policy set', 0);
    return row;
  }

  async #audit(org: OrgContext, action: string, targetId: string, diff?: object) {
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org.organizationId,
        actorUserId: org.userId,
        ...(org.ip ? { ip: org.ip } : {}),
        action,
        targetType: 'routing_policy',
        targetId,
        ...(diff ? { diff } : {}),
      },
    });
  }
}
