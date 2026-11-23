/**
 * Sale pricing administration (card 19.4): customer groups and their multipliers, monthly plans,
 * and customer subscriptions. Prices reach the gateway through the config snapshot, so every
 * change applies within seconds and without a deploy (the snapshot rebuild runs after each
 * successful change under /orgs/…). Model multipliers live on the platform's models themselves
 * (`PATCH /orgs/:orgId/models/:id` with `sale` and `isPublic`).
 */
import { fromUnits, leftOf, startSubscriptionPeriod } from '@dirouter/db';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { WalletsService } from './wallets.service.js';

const dec = (d: { toFixed(n: number): string }) => d.toFixed(8);

@Injectable()
export class PricingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletsService) private readonly wallets: WalletsService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  async #audit(
    ctx: OrgContext,
    action: string,
    targetType: string,
    targetId: string,
    diff?: object,
  ) {
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        action,
        targetType,
        targetId,
        ...(diff ? { diff } : {}),
      },
    });
  }

  // ───────────── Customer groups ─────────────

  async groups() {
    const rows = await this.db.customerGroup.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { organizations: true } } },
    });
    return rows.map((g) => ({
      id: g.id,
      name: g.name,
      multiplier: dec(g.multiplier),
      description: g.description,
      organizations: g._count.organizations,
    }));
  }

  async createGroup(
    ctx: OrgContext,
    input: { name: string; multiplier: string; description?: string | undefined },
  ) {
    const id = prefixedId('cgr');
    await this.#unique(() =>
      this.db.customerGroup.create({
        data: {
          id,
          name: input.name,
          multiplier: input.multiplier,
          description: input.description ?? null,
        },
      }),
    );
    await this.#audit(ctx, 'billing.group_created', 'customer_group', id, input);
    return (await this.groups()).find((g) => g.id === id);
  }

  async updateGroup(
    ctx: OrgContext,
    id: string,
    input: {
      name?: string | undefined;
      multiplier?: string | undefined;
      description?: string | null | undefined;
    },
  ) {
    await this.#group(id);
    await this.#unique(() =>
      this.db.customerGroup.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.multiplier !== undefined ? { multiplier: input.multiplier } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      }),
    );
    await this.#audit(ctx, 'billing.group_updated', 'customer_group', id, input);
    return (await this.groups()).find((g) => g.id === id);
  }

  async deleteGroup(ctx: OrgContext, id: string) {
    await this.#group(id);
    // Members fall back to list price (the foreign key sets their group to null).
    await this.db.customerGroup.delete({ where: { id } });
    await this.#audit(ctx, 'billing.group_deleted', 'customer_group', id);
  }

  async setOrganizationGroup(ctx: OrgContext, organizationId: string, groupId: string | null) {
    if (groupId) await this.#group(groupId);
    const updated = await this.db.organization.updateMany({
      where: { id: organizationId, deletedAt: null, isPlatform: false },
      data: { customerGroupId: groupId },
    });
    if (updated.count === 0)
      throw new DiRouterError('not_found', { message: 'Organization not found' });
    await this.#audit(ctx, 'billing.group_assigned', 'organization', organizationId, { groupId });
    return { organizationId, customerGroupId: groupId };
  }

  async #group(id: string) {
    const g = await this.db.customerGroup.findUnique({ where: { id } });
    if (!g) throw new DiRouterError('not_found', { message: 'Customer group not found' });
    return g;
  }

  async #unique<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        throw new DiRouterError('conflict', { message: 'The name is already in use' });
      throw error;
    }
  }

  // ───────────── Plans ─────────────

  async plans(onlyActive = false) {
    const rows = await this.db.plan.findMany({
      where: onlyActive ? { active: true } : {},
      orderBy: { priceUsd: 'asc' },
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      priceUsd: dec(p.priceUsd),
      includedUsd: dec(p.includedUsd),
      active: p.active,
    }));
  }

  async createPlan(
    ctx: OrgContext,
    input: { name: string; priceUsd: string; includedUsd: string; active?: boolean | undefined },
  ) {
    const id = prefixedId('pln');
    await this.#unique(() =>
      this.db.plan.create({
        data: {
          id,
          name: input.name,
          priceUsd: input.priceUsd,
          includedUsd: input.includedUsd,
          active: input.active ?? true,
        },
      }),
    );
    await this.#audit(ctx, 'billing.plan_created', 'plan', id, input);
    return (await this.plans()).find((p) => p.id === id);
  }

  /** Price changes apply from each subscriber's next period. */
  async updatePlan(
    ctx: OrgContext,
    id: string,
    input: {
      name?: string | undefined;
      priceUsd?: string | undefined;
      includedUsd?: string | undefined;
      active?: boolean | undefined;
    },
  ) {
    const found = await this.db.plan.findUnique({ where: { id } });
    if (!found) throw new DiRouterError('not_found', { message: 'Plan not found' });
    await this.#unique(() =>
      this.db.plan.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.priceUsd !== undefined ? { priceUsd: input.priceUsd } : {}),
          ...(input.includedUsd !== undefined ? { includedUsd: input.includedUsd } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      }),
    );
    await this.#audit(ctx, 'billing.plan_updated', 'plan', id, input);
    return (await this.plans()).find((p) => p.id === id);
  }

  // ───────────── Customer subscription ─────────────

  async subscription(organizationId: string) {
    const s = await this.db.subscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });
    if (!s) return null;
    return {
      id: s.id,
      plan: { id: s.plan.id, name: s.plan.name, priceUsd: dec(s.plan.priceUsd) },
      status: s.status.toLowerCase(),
      periodStart: s.periodStart.toISOString(),
      periodEnd: s.periodEnd.toISOString(),
      includedUsd: dec(s.plan.includedUsd),
      usedUsd: dec(s.usedUsd),
      remainingUsd: fromUnits(
        s.status === 'ACTIVE'
          ? leftOf({
              id: s.id,
              period_start: s.periodStart,
              used: dec(s.usedUsd),
              included: dec(s.plan.includedUsd),
            })
          : 0n,
      ),
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    };
  }

  /**
   * Subscribes (or switches plan): the first period starts now and its fee is paid from the wallet
   * at once. Requires a prepaid wallet with enough credit.
   */
  async subscribe(ctx: OrgContext, planId: string) {
    const plan = await this.db.plan.findFirst({ where: { id: planId, active: true } });
    if (!plan) throw new DiRouterError('not_found', { message: 'Plan not found' });
    const org = await this.db.organization.findFirst({
      where: { id: ctx.organizationId, deletedAt: null, isPlatform: false },
      select: { id: true, prepaid: true },
    });
    if (!org?.prepaid)
      throw new DiRouterError('validation_failed', {
        message: 'Plans need a prepaid wallet; ask the operator to enable prepaid billing',
      });
    await this.wallets.ensure(org.id);
    const now = new Date();
    const existing = await this.db.subscription.findUnique({ where: { organizationId: org.id } });
    if (existing?.status === 'ACTIVE' && existing.planId === planId && !existing.cancelAtPeriodEnd)
      throw new DiRouterError('conflict', { message: 'Already subscribed to this plan' });
    const id = existing?.id ?? prefixedId('sub');
    await this.db.subscription.upsert({
      where: { organizationId: org.id },
      create: {
        id,
        organizationId: org.id,
        planId,
        periodStart: now,
        periodEnd: new Date(now.getTime() + 1),
      },
      update: { planId, cancelAtPeriodEnd: false, status: 'ACTIVE' },
    });
    const result = await startSubscriptionPeriod(this.db, id, now);
    if (result.wallet) await this.wallets.mirror([result.wallet]);
    if (result.status !== 'active') {
      // Nothing was charged; leave no half-started subscription behind.
      if (!existing) await this.db.subscription.delete({ where: { id } });
      else
        await this.db.subscription.update({
          where: { id },
          data: { planId: existing.planId, status: existing.status },
        });
      throw new DiRouterError('insufficient_credit', {
        message: `The plan costs USD ${dec(plan.priceUsd)}; top up the wallet first`,
      });
    }
    await this.#audit(ctx, 'billing.subscribed', 'subscription', id, { planId });
    return this.subscription(org.id);
  }

  /** Ends the subscription when the current (already paid) period ends. */
  async cancel(ctx: OrgContext) {
    const updated = await this.db.subscription.updateMany({
      where: { organizationId: ctx.organizationId, status: { not: 'CANCELLED' } },
      data: { cancelAtPeriodEnd: true },
    });
    if (updated.count === 0) throw new DiRouterError('not_found', { message: 'No subscription' });
    await this.#audit(ctx, 'billing.subscription_cancelled', 'organization', ctx.organizationId);
    return this.subscription(ctx.organizationId);
  }
}
