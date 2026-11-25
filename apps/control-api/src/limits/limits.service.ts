/**
 * Team and project limits (card 25.5): requests, tokens and concurrency per minute plus daily and
 * monthly budgets for a whole team or project. The gateway already enforces them from the snapshot
 * (`limits`, card 6.3); this service is what writes them.
 *
 * Rate limits live in `rate_limit_policies` and budgets in `budgets`, both keyed by scope and scope
 * id. A budget keeps its id when its amount changes (upsert by scope, scope id and period), so the
 * gateway keeps counting the current period on the same Valkey counter instead of starting from
 * zero until the worker reconciles it with the ledger.
 */
import { budgetPeriodRange } from '@dirouter/contracts';
import { Prisma } from '@dirouter/db';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

export type LimitScope = 'team' | 'project';
const DB_SCOPE = { team: 'TEAM', project: 'PROJECT' } as const;

export interface LimitBudgetInput {
  period: 'daily' | 'monthly';
  limitUsd?: string | undefined;
  limitTokens?: number | undefined;
  alertThresholds?: number[] | undefined;
}
export interface LimitInput {
  rpm?: number | null | undefined;
  tpm?: number | null | undefined;
  maxConcurrency?: number | null | undefined;
  /** Replaces every budget of the scope; absent keeps them. */
  budgets?: LimitBudgetInput[] | undefined;
}

type BudgetRow = Awaited<ReturnType<PrismaService['client']['budget']['findMany']>>[number];

const decimal = (value: Prisma.Decimal | null) =>
  value === null ? null : value.toFixed(8).replace(/\.?0+$/, '') || '0';
const text = (value: unknown) =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '0';

function budgetView(b: BudgetRow) {
  return {
    id: b.id,
    period: b.period === 'DAILY' ? ('daily' as const) : ('monthly' as const),
    limitUsd: decimal(b.limitUsd),
    limitTokens: b.limitTokens === null ? null : Number(b.limitTokens),
    alertThresholds: b.alertThresholds,
  };
}

/** Budgets in a canonical form, to tell whether a request really changes them. */
export function sameBudgets(
  current: {
    period: string;
    limitUsd: string | null;
    limitTokens: number | null;
    alertThresholds: number[];
  }[],
  next: LimitBudgetInput[],
): boolean {
  const norm = (b: {
    period: string;
    limitUsd?: string | null | undefined;
    limitTokens?: number | null | undefined;
    alertThresholds?: number[] | undefined;
  }) =>
    JSON.stringify([
      b.period,
      b.limitUsd ? new Prisma.Decimal(b.limitUsd).toFixed(8) : null,
      b.limitTokens ?? null,
      [...(b.alertThresholds ?? [50, 80, 100])].sort((x, y) => x - y),
    ]);
  const a = current.map(norm).sort();
  const b = next.map(norm).sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

@Injectable()
export class LimitsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  get db() {
    return this.prisma.client;
  }

  /** The team or project of this organization, or 404. */
  async target(ctx: OrgContext, scope: LimitScope, scopeId: string) {
    const where = { id: scopeId, organizationId: ctx.organizationId, deletedAt: null };
    const row =
      scope === 'team'
        ? await this.db.team.findFirst({ where, select: { id: true, name: true } })
        : await this.db.project.findFirst({
            where,
            select: { id: true, name: true, teamId: true },
          });
    if (!row) throw new DiRouterError('not_found', { message: `${scope} not found` });
    return row;
  }

  async list(ctx: OrgContext) {
    const [policies, budgets, teams, projects] = await Promise.all([
      this.db.rateLimitPolicy.findMany({
        where: { organizationId: ctx.organizationId, scope: { in: ['TEAM', 'PROJECT'] } },
      }),
      this.db.budget.findMany({
        where: { organizationId: ctx.organizationId, scope: { in: ['TEAM', 'PROJECT'] } },
        orderBy: { period: 'asc' },
      }),
      this.db.team.findMany({
        where: { organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true, name: true },
      }),
      this.db.project.findMany({
        where: { organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true, name: true },
      }),
    ]);
    const names = new Map<string, string>([
      ...teams.map((t): [string, string] => [`TEAM|${t.id}`, t.name]),
      ...projects.map((p): [string, string] => [`PROJECT|${p.id}`, p.name]),
    ]);
    const keys = new Set([
      ...policies.map((p) => `${p.scope}|${p.scopeId}`),
      ...budgets.map((b) => `${b.scope}|${b.scopeId}`),
    ]);
    return [...keys]
      .filter((key) => names.has(key))
      .map((key) => {
        const [scope = '', scopeId = ''] = key.split('|');
        const policy = policies.find((p) => `${p.scope}|${p.scopeId}` === key);
        return {
          scope: scope === 'TEAM' ? ('team' as const) : ('project' as const),
          scopeId,
          name: names.get(key) ?? scopeId,
          rpm: policy?.rpm ?? null,
          tpm: policy?.tpm ?? null,
          maxConcurrency: policy?.maxConcurrency ?? null,
          budgets: budgets.filter((b) => `${b.scope}|${b.scopeId}` === key).map(budgetView),
        };
      })
      .sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  }

  async get(ctx: OrgContext, scope: LimitScope, scopeId: string) {
    const target = await this.target(ctx, scope, scopeId);
    const [policy, budgets] = await Promise.all([
      this.db.rateLimitPolicy.findUnique({
        where: { scope_scopeId: { scope: DB_SCOPE[scope], scopeId } },
      }),
      this.db.budget.findMany({
        where: { scope: DB_SCOPE[scope], scopeId },
        orderBy: { period: 'asc' },
      }),
    ]);
    return {
      scope,
      scopeId,
      name: target.name,
      rpm: policy?.rpm ?? null,
      tpm: policy?.tpm ?? null,
      maxConcurrency: policy?.maxConcurrency ?? null,
      budgets: budgets.map(budgetView),
    };
  }

  /** Whether `input` changes the budgets of the scope (those changes need approval, card 22.2). */
  async changesBudgets(ctx: OrgContext, scope: LimitScope, scopeId: string, input: LimitInput) {
    if (input.budgets === undefined) return false;
    const current = await this.get(ctx, scope, scopeId);
    return !sameBudgets(current.budgets, input.budgets);
  }

  async set(ctx: OrgContext, scope: LimitScope, scopeId: string, input: LimitInput) {
    await this.target(ctx, scope, scopeId);
    const dbScope = DB_SCOPE[scope];
    if (input.budgets) {
      const periods = new Set(input.budgets.map((b) => b.period));
      if (periods.size !== input.budgets.length)
        throw new DiRouterError('validation_failed', { message: 'one budget per period' });
      for (const b of input.budgets)
        if (b.limitUsd === undefined && b.limitTokens === undefined)
          throw new DiRouterError('validation_failed', {
            message: 'budget needs limitUsd or limitTokens',
          });
    }
    await this.db.$transaction(async (tx) => {
      const current = await tx.rateLimitPolicy.findUnique({
        where: { scope_scopeId: { scope: dbScope, scopeId } },
      });
      const next = {
        rpm: input.rpm !== undefined ? input.rpm : (current?.rpm ?? null),
        tpm: input.tpm !== undefined ? input.tpm : (current?.tpm ?? null),
        maxConcurrency:
          input.maxConcurrency !== undefined
            ? input.maxConcurrency
            : (current?.maxConcurrency ?? null),
      };
      if (next.rpm === null && next.tpm === null && next.maxConcurrency === null) {
        if (current) await tx.rateLimitPolicy.delete({ where: { id: current.id } });
      } else if (current) {
        await tx.rateLimitPolicy.update({ where: { id: current.id }, data: next });
      } else {
        await tx.rateLimitPolicy.create({
          data: {
            id: prefixedId('rlp'),
            organizationId: ctx.organizationId,
            scope: dbScope,
            scopeId,
            ...next,
          },
        });
      }
      if (input.budgets !== undefined) {
        const keep = input.budgets.map((b) => (b.period === 'daily' ? 'DAILY' : 'MONTHLY'));
        await tx.budget.deleteMany({
          where: { scope: dbScope, scopeId, period: { notIn: keep } },
        });
        for (const b of input.budgets) {
          const period = b.period === 'daily' ? 'DAILY' : 'MONTHLY';
          const data = {
            limitUsd: b.limitUsd ?? null,
            limitTokens: b.limitTokens ?? null,
            alertThresholds: b.alertThresholds ?? [50, 80, 100],
          };
          await tx.budget.upsert({
            where: { scope_scopeId_period: { scope: dbScope, scopeId, period } },
            update: data,
            create: {
              id: prefixedId('bud'),
              organizationId: ctx.organizationId,
              scope: dbScope,
              scopeId,
              period,
              ...data,
            },
          });
        }
      }
      await tx.auditLog.create({
        data: {
          id: prefixedId('aud'),
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          ...(ctx.ip ? { ip: ctx.ip } : {}),
          action: 'limit.updated',
          targetType: scope,
          targetId: scopeId,
          diff: JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue,
        },
      });
    });
    return this.get(ctx, scope, scopeId);
  }

  /**
   * Current spend of every team and project (cost page): today and this month (UTC, the periods the
   * gateway counts budgets in), with the limits that apply. Read from the usage ledger, the source
   * of truth the worker reconciles the gateway's counters with.
   */
  async usage(ctx: OrgContext, now = new Date()) {
    const day = budgetPeriodRange('daily', now).start;
    const month = budgetPeriodRange('monthly', now).start;
    const sums = (column: 'project_id' | 'team_id') => Prisma.sql`
      SELECT ${Prisma.raw(`"${column}"`)} AS scope_id,
             coalesce(sum("cost_usd") FILTER (WHERE "occurred_at" >= ${day}), 0)::text AS day_usd,
             coalesce(sum("tokens") FILTER (WHERE "occurred_at" >= ${day}), 0)::bigint::text AS day_tokens,
             coalesce(sum("cost_usd"), 0)::text AS month_usd,
             coalesce(sum("tokens"), 0)::bigint::text AS month_tokens
      FROM "usage_ledger"
      WHERE "organization_id" = ${ctx.organizationId} AND "occurred_at" >= ${month}
        AND ${Prisma.raw(`"${column}"`)} IS NOT NULL
      GROUP BY 1`;
    const [byProject, byTeam, limits, teams, projects] = await Promise.all([
      this.db.$queryRaw<Record<string, unknown>[]>(sums('project_id')),
      this.db.$queryRaw<Record<string, unknown>[]>(sums('team_id')),
      this.list(ctx),
      this.db.team.findMany({
        where: { organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.db.project.findMany({
        where: { organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true, name: true, teamId: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const spend = (rows: Record<string, unknown>[], id: string) => {
      const row = rows.find((r) => r.scope_id === id);
      return {
        today: { usd: text(row?.day_usd), tokens: Number(row?.day_tokens ?? 0) },
        month: { usd: text(row?.month_usd), tokens: Number(row?.month_tokens ?? 0) },
      };
    };
    const entry = (
      scope: LimitScope,
      target: { id: string; name: string; teamId?: string | null },
      rows: Record<string, unknown>[],
    ) => {
      const used = spend(rows, target.id);
      const limit = limits.find((l) => l.scope === scope && l.scopeId === target.id);
      return {
        scope,
        scopeId: target.id,
        name: target.name,
        ...(scope === 'project' ? { teamId: target.teamId ?? null } : {}),
        ...used,
        rateLimit:
          limit && (limit.rpm ?? limit.tpm ?? limit.maxConcurrency) !== null
            ? { rpm: limit.rpm, tpm: limit.tpm, maxConcurrency: limit.maxConcurrency }
            : null,
        budgets: (limit?.budgets ?? []).map((b) => {
          const spent = b.period === 'daily' ? used.today : used.month;
          const ratio =
            b.limitUsd !== null && Number(b.limitUsd) > 0
              ? Number(spent.usd) / Number(b.limitUsd)
              : b.limitTokens !== null && b.limitTokens > 0
                ? spent.tokens / b.limitTokens
                : null;
          return {
            ...b,
            spentUsd: spent.usd,
            spentTokens: spent.tokens,
            usedPercent: ratio === null ? null : Math.round(ratio * 1000) / 10,
          };
        }),
      };
    };
    return {
      dayStart: day.toISOString(),
      monthStart: month.toISOString(),
      scopes: [
        ...teams.map((t) => entry('team', t, byTeam)),
        ...projects.map((p) => entry('project', p, byProject)),
      ],
    };
  }
}
