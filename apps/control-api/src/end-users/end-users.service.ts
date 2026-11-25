/**
 * End users (card 33.2): the users of an organization's own product, as the requests name them
 * (`user` field or `x-dirouter-end-user` header). The worker records each one on first sight; this
 * service lists them with their spend, blocks or unblocks them, and shows one with its limits and
 * daily usage. Their limits and budgets are written through the limits API (scope `end_user`,
 * `*` for the defaults every end user gets).
 */
import { budgetPeriodRange, normalizeEndUser } from '@dirouter/contracts';
import { Prisma } from '@dirouter/db';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import { LimitsService } from '../limits/limits.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const usd = (v: unknown) =>
  v === null || v === undefined
    ? '0'
    : new Prisma.Decimal(v as string).toFixed(8).replace(/\.?0+$/, '') || '0';

export interface EndUserQuery {
  search?: string | undefined;
  blocked?: boolean | undefined;
  limit: number;
  offset: number;
}

@Injectable()
export class EndUsersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LimitsService) private readonly limits: LimitsService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  /** An id as the gateway would attribute it, or 404. */
  #id(endUser: string): string {
    const id = normalizeEndUser(endUser);
    if (id !== endUser) throw new DiRouterError('not_found', { message: 'end user not found' });
    return id;
  }

  /** This month's requests and cost per end user, from the daily dimension rollup. */
  async #monthUsage(ctx: OrgContext, ids: string[]) {
    if (ids.length === 0) return new Map<string, { requests: number; costUsd: string }>();
    const month = budgetPeriodRange('monthly').start;
    const rows = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT value, sum(requests) AS requests, sum(cost_usd)::text AS cost_usd
      FROM usage_dimension_daily
      WHERE organization_id = ${ctx.organizationId} AND dimension = 'end_user'
        AND bucket >= ${month}::date AND value IN (${Prisma.join(ids)})
      GROUP BY value`;
    return new Map(
      rows.map((r) => [String(r.value), { requests: num(r.requests), costUsd: usd(r.cost_usd) }]),
    );
  }

  async list(ctx: OrgContext, q: EndUserQuery) {
    const where = {
      organizationId: ctx.organizationId,
      ...(q.search ? { externalId: { contains: q.search, mode: 'insensitive' as const } } : {}),
      ...(q.blocked !== undefined ? { blocked: q.blocked } : {}),
    };
    const [rows, total, limited] = await Promise.all([
      this.db.endUser.findMany({
        where,
        orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { externalId: 'asc' }],
        take: q.limit,
        skip: q.offset,
      }),
      this.db.endUser.count({ where }),
      this.limits.list(ctx),
    ]);
    const usage = await this.#monthUsage(
      ctx,
      rows.map((r) => r.externalId),
    );
    const withLimits = new Set(limited.filter((l) => l.scope === 'end_user').map((l) => l.scopeId));
    return {
      total,
      items: rows.map((r) => ({
        id: r.externalId,
        blocked: r.blocked,
        firstSeenAt: r.firstSeenAt?.toISOString() ?? null,
        lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
        hasLimits: withLimits.has(r.externalId),
        month: usage.get(r.externalId) ?? { requests: 0, costUsd: '0' },
      })),
    };
  }

  async get(ctx: OrgContext, endUser: string, now = new Date()) {
    const id = this.#id(endUser);
    const row = await this.db.endUser.findUnique({
      where: { organizationId_externalId: { organizationId: ctx.organizationId, externalId: id } },
    });
    if (!row) throw new DiRouterError('not_found', { message: 'end user not found' });
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const [limits, days, month] = await Promise.all([
      this.limits.get(ctx, 'end_user', id),
      this.db.$queryRaw<Record<string, unknown>[]>`
        SELECT bucket, sum(requests) AS requests, sum(errors) AS errors,
               sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
               sum(cost_usd)::text AS cost_usd
        FROM usage_dimension_daily
        WHERE organization_id = ${ctx.organizationId} AND dimension = 'end_user'
          AND value = ${id} AND bucket >= ${since}::date
        GROUP BY bucket ORDER BY bucket`,
      this.#monthUsage(ctx, [id]),
    ]);
    return {
      id,
      blocked: row.blocked,
      firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      month: month.get(id) ?? { requests: 0, costUsd: '0' },
      limits,
      days: days.map((d) => ({
        day: (d.bucket as Date).toISOString().slice(0, 10),
        requests: num(d.requests),
        errors: num(d.errors),
        tokens: num(d.input_tokens) + num(d.output_tokens),
        costUsd: usd(d.cost_usd),
      })),
    };
  }

  /** Blocks or unblocks an end user; one that was never seen can be blocked in advance. */
  async setBlocked(ctx: OrgContext, endUser: string, blocked: boolean) {
    const id = this.#id(endUser);
    await this.db.$transaction(async (tx) => {
      await tx.endUser.upsert({
        where: {
          organizationId_externalId: { organizationId: ctx.organizationId, externalId: id },
        },
        update: { blocked },
        create: {
          id: prefixedId('eu'),
          organizationId: ctx.organizationId,
          externalId: id,
          blocked,
        },
      });
      await tx.auditLog.create({
        data: {
          id: prefixedId('aud'),
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          ...(ctx.ip ? { ip: ctx.ip } : {}),
          action: blocked ? 'end_user.blocked' : 'end_user.unblocked',
          targetType: 'end_user',
          targetId: id,
          diff: { blocked },
        },
      });
    });
    return this.get(ctx, id);
  }
}
