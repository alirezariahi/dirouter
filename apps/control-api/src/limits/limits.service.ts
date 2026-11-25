/**
 * Shared limits (card 25.5, widened by card 33.1): requests, tokens and concurrency per minute plus
 * daily, weekly, monthly and yearly budgets for a whole team, project or organization, for all keys
 * of one member, and for one model or provider of the organization. The gateway enforces them from
 * the snapshot (`limits`); this service is what writes them.
 *
 * Rate limits live in `rate_limit_policies` and budgets in `budgets`, both keyed by scope and scope
 * id. A budget keeps its id when its amount changes (upsert by scope, scope id and period), so the
 * gateway keeps counting the current period on the same Valkey counter instead of starting from
 * zero until the worker reconciles it with the ledger.
 */
import {
  budgetPeriodRange,
  END_USER_DEFAULT,
  normalizeEndUser,
  TAG_PATTERN,
} from '@dirouter/contracts';
import { Prisma } from '@dirouter/db';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { type BudgetPeriod, fromDbPeriod, periodRank, toDbPeriod } from './periods.js';

export const LIMIT_SCOPES = [
  'organization',
  'team',
  'project',
  'user',
  'model',
  'provider',
  'end_user',
  'tag',
  'cost_center',
] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];
const DB_SCOPE = {
  organization: 'ORGANIZATION',
  team: 'TEAM',
  project: 'PROJECT',
  user: 'USER',
  model: 'MODEL',
  provider: 'PROVIDER',
  end_user: 'END_USER',
  tag: 'TAG',
  cost_center: 'COST_CENTER',
} as const satisfies Record<LimitScope, string>;

/** Display name of the end-user defaults (scope id `*`, card 33.2). */
export const END_USER_DEFAULT_NAME = 'Every end user';
const FROM_DB = Object.fromEntries(Object.entries(DB_SCOPE).map(([k, v]) => [v, k])) as Record<
  string,
  LimitScope | undefined
>;

export interface LimitBudgetInput {
  period: BudgetPeriod;
  limitUsd?: string | undefined;
  limitTokens?: number | undefined;
  alertThresholds?: number[] | undefined;
}
export interface LimitInput {
  rpm?: number | null | undefined;
  tpm?: number | null | undefined;
  inputTpm?: number | null | undefined;
  outputTpm?: number | null | undefined;
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
    period: fromDbPeriod(b.period),
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

  /** The organization, team, project, member, model or provider behind a scope, or 404. */
  async target(ctx: OrgContext, scope: LimitScope, scopeId: string): Promise<{ name: string }> {
    const org = ctx.organizationId;
    const where = { id: scopeId, organizationId: org, deletedAt: null };
    let row: { name: string } | null = null;
    switch (scope) {
      case 'organization':
        row =
          scopeId === org
            ? await this.db.organization.findUnique({ where: { id: org }, select: { name: true } })
            : null;
        break;
      case 'team':
        row = await this.db.team.findFirst({ where, select: { name: true } });
        break;
      case 'project':
        row = await this.db.project.findFirst({ where, select: { name: true } });
        break;
      case 'user': {
        const m = await this.db.membership.findFirst({
          where: { userId: scopeId, organizationId: org },
          select: { user: { select: { name: true, email: true } } },
        });
        row = m ? { name: m.user.name || m.user.email } : null;
        break;
      }
      case 'model': {
        // The organization's own models and the platform's public models it can call.
        const m = await this.db.model.findFirst({
          where: {
            id: scopeId,
            deletedAt: null,
            OR: [{ organizationId: org }, { isPublic: true, organization: { isPlatform: true } }],
          },
          select: { slug: true },
        });
        row = m ? { name: m.slug } : null;
        break;
      }
      case 'provider':
        row = await this.db.provider.findFirst({ where, select: { name: true } });
        break;
      case 'end_user':
        // End users are the organization's own ids (card 33.2): any valid id, or `*` for the
        // defaults; one that was never seen can be limited in advance.
        row =
          scopeId === END_USER_DEFAULT
            ? { name: END_USER_DEFAULT_NAME }
            : normalizeEndUser(scopeId) === scopeId
              ? { name: scopeId }
              : null;
        break;
      case 'tag':
      case 'cost_center':
        // Tags and cost centers are the organization's own names (card 33.4).
        row = TAG_PATTERN.test(scopeId) ? { name: scopeId } : null;
        break;
    }
    if (!row) throw new DiRouterError('not_found', { message: `${scope} not found` });
    return row;
  }

  /** Display names of the scopes that have limits, keyed `SCOPE|id`. */
  async #names(ctx: OrgContext, ids: { scope: string; scopeId: string }[]) {
    const of = (scope: string) => ids.filter((i) => i.scope === scope).map((i) => i.scopeId);
    const org = ctx.organizationId;
    const [organization, teams, projects, members, models, providers] = await Promise.all([
      this.db.organization.findUnique({ where: { id: org }, select: { id: true, name: true } }),
      this.db.team.findMany({
        where: { organizationId: org, deletedAt: null, id: { in: of('TEAM') } },
        select: { id: true, name: true },
      }),
      this.db.project.findMany({
        where: { organizationId: org, deletedAt: null, id: { in: of('PROJECT') } },
        select: { id: true, name: true },
      }),
      this.db.membership.findMany({
        where: { organizationId: org, userId: { in: of('USER') } },
        select: { userId: true, user: { select: { name: true, email: true } } },
      }),
      this.db.model.findMany({
        where: { deletedAt: null, id: { in: of('MODEL') } },
        select: { id: true, slug: true },
      }),
      this.db.provider.findMany({
        where: { organizationId: org, deletedAt: null, id: { in: of('PROVIDER') } },
        select: { id: true, name: true },
      }),
    ]);
    return new Map<string, string>([
      ...of('TAG').map((id) => [`TAG|${id}`, id] as const),
      ...of('COST_CENTER').map((id) => [`COST_CENTER|${id}`, id] as const),
      ...of('END_USER').map(
        (id) => [`END_USER|${id}`, id === END_USER_DEFAULT ? END_USER_DEFAULT_NAME : id] as const,
      ),
      ...(organization ? [[`ORGANIZATION|${organization.id}`, organization.name] as const] : []),
      ...teams.map((t) => [`TEAM|${t.id}`, t.name] as const),
      ...projects.map((p) => [`PROJECT|${p.id}`, p.name] as const),
      ...members.map((m) => [`USER|${m.userId}`, m.user.name || m.user.email] as const),
      ...models.map((m) => [`MODEL|${m.id}`, m.slug] as const),
      ...providers.map((p) => [`PROVIDER|${p.id}`, p.name] as const),
    ]);
  }

  async list(ctx: OrgContext) {
    const scopes = Object.values(DB_SCOPE);
    const [policies, budgets] = await Promise.all([
      this.db.rateLimitPolicy.findMany({
        where: { organizationId: ctx.organizationId, scope: { in: scopes } },
      }),
      this.db.budget.findMany({
        where: { organizationId: ctx.organizationId, scope: { in: scopes } },
      }),
    ]);
    const names = await this.#names(ctx, [...policies, ...budgets]);
    const keys = new Set([
      ...policies.map((p) => `${p.scope}|${p.scopeId}`),
      ...budgets.map((b) => `${b.scope}|${b.scopeId}`),
    ]);
    return [...keys]
      .filter((key) => names.has(key))
      .map((key) => {
        // End-user ids may contain `|`; the scope never does.
        const scope = key.slice(0, key.indexOf('|'));
        const scopeId = key.slice(key.indexOf('|') + 1);
        const policy = policies.find((p) => `${p.scope}|${p.scopeId}` === key);
        return {
          scope: FROM_DB[scope] ?? 'project',
          scopeId,
          name: names.get(key) ?? scopeId,
          rpm: policy?.rpm ?? null,
          tpm: policy?.tpm ?? null,
          inputTpm: policy?.inputTpm ?? null,
          outputTpm: policy?.outputTpm ?? null,
          maxConcurrency: policy?.maxConcurrency ?? null,
          budgets: budgets
            .filter((b) => `${b.scope}|${b.scopeId}` === key)
            .sort((a, b) => periodRank(a.period) - periodRank(b.period))
            .map(budgetView),
        };
      })
      .sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  }

  async get(ctx: OrgContext, scope: LimitScope, scopeId: string) {
    const target = await this.target(ctx, scope, scopeId);
    const where = { organizationId: ctx.organizationId, scope: DB_SCOPE[scope], scopeId };
    const [policy, budgets] = await Promise.all([
      this.db.rateLimitPolicy.findUnique({ where: { organizationId_scope_scopeId: where } }),
      this.db.budget.findMany({ where }),
    ]);
    return {
      scope,
      scopeId,
      name: target.name,
      rpm: policy?.rpm ?? null,
      tpm: policy?.tpm ?? null,
      inputTpm: policy?.inputTpm ?? null,
      outputTpm: policy?.outputTpm ?? null,
      maxConcurrency: policy?.maxConcurrency ?? null,
      budgets: budgets.sort((a, b) => periodRank(a.period) - periodRank(b.period)).map(budgetView),
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
    const where = { organizationId: ctx.organizationId, scope: dbScope, scopeId };
    await this.db.$transaction(async (tx) => {
      const current = await tx.rateLimitPolicy.findUnique({
        where: { organizationId_scope_scopeId: where },
      });
      const next = {
        rpm: input.rpm !== undefined ? input.rpm : (current?.rpm ?? null),
        tpm: input.tpm !== undefined ? input.tpm : (current?.tpm ?? null),
        inputTpm: input.inputTpm !== undefined ? input.inputTpm : (current?.inputTpm ?? null),
        outputTpm: input.outputTpm !== undefined ? input.outputTpm : (current?.outputTpm ?? null),
        maxConcurrency:
          input.maxConcurrency !== undefined
            ? input.maxConcurrency
            : (current?.maxConcurrency ?? null),
      };
      if (
        next.rpm === null &&
        next.tpm === null &&
        next.inputTpm === null &&
        next.outputTpm === null &&
        next.maxConcurrency === null
      ) {
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
        const keep = input.budgets.map((b) => toDbPeriod(b.period));
        await tx.budget.deleteMany({ where: { ...where, period: { notIn: keep } } });
        for (const b of input.budgets) {
          const period = toDbPeriod(b.period);
          const data = {
            limitUsd: b.limitUsd ?? null,
            limitTokens: b.limitTokens ?? null,
            alertThresholds: b.alertThresholds ?? [50, 80, 100],
          };
          await tx.budget.upsert({
            where: { organizationId_scope_scopeId_period: { ...where, period } },
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
      // An end user limited before it was ever seen shows up in the end-user list (card 33.2).
      if (scope === 'end_user' && scopeId !== END_USER_DEFAULT)
        await tx.endUser.upsert({
          where: {
            organizationId_externalId: { organizationId: ctx.organizationId, externalId: scopeId },
          },
          update: {},
          create: { id: prefixedId('eu'), organizationId: ctx.organizationId, externalId: scopeId },
        });
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
   * Current spend (cost page) of the organization, every team and project, and every member, model
   * and provider with limits: today, this week, this month and this year (UTC, the periods the
   * gateway counts budgets in), with the limits that apply. Read from the usage ledger, the source
   * of truth the worker reconciles the gateway's counters with.
   */
  async usage(ctx: OrgContext, now = new Date()) {
    const starts = {
      daily: budgetPeriodRange('daily', now).start,
      weekly: budgetPeriodRange('weekly', now).start,
      monthly: budgetPeriodRange('monthly', now).start,
      yearly: budgetPeriodRange('yearly', now).start,
    };
    const [limits, teams, projects] = await Promise.all([
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
    // A year of ledger is only read when a yearly budget needs it.
    const from = limits.some((l) => l.budgets.some((b) => b.period === 'yearly'))
      ? starts.yearly
      : new Date(Math.min(starts.monthly.getTime(), starts.weekly.getTime()));
    const column: Record<LimitScope, Prisma.Sql> = {
      organization: Prisma.sql`l."organization_id"`,
      team: Prisma.sql`l."team_id"`,
      project: Prisma.sql`l."project_id"`,
      user: Prisma.sql`(SELECT k."created_by_id" FROM "api_keys" k WHERE k."id" = l."api_key_id")`,
      model: Prisma.sql`l."model_id"`,
      provider: Prisma.sql`l."provider_id"`,
      end_user: Prisma.sql`l."end_user"`,
      // A request with several tags counts for each of them.
      tag: Prisma.sql`t.tag`,
      cost_center: Prisma.sql`l."cost_center"`,
    };
    const sums = (scope: LimitScope) => Prisma.sql`
      SELECT ${column[scope]} AS scope_id,
             coalesce(sum(l."cost_usd") FILTER (WHERE l."occurred_at" >= ${starts.daily}), 0)::text AS d_usd,
             coalesce(sum(l."tokens") FILTER (WHERE l."occurred_at" >= ${starts.daily}), 0)::bigint::text AS d_tokens,
             coalesce(sum(l."cost_usd") FILTER (WHERE l."occurred_at" >= ${starts.weekly}), 0)::text AS w_usd,
             coalesce(sum(l."tokens") FILTER (WHERE l."occurred_at" >= ${starts.weekly}), 0)::bigint::text AS w_tokens,
             coalesce(sum(l."cost_usd") FILTER (WHERE l."occurred_at" >= ${starts.monthly}), 0)::text AS m_usd,
             coalesce(sum(l."tokens") FILTER (WHERE l."occurred_at" >= ${starts.monthly}), 0)::bigint::text AS m_tokens,
             coalesce(sum(l."cost_usd") FILTER (WHERE l."occurred_at" >= ${starts.yearly}), 0)::text AS y_usd,
             coalesce(sum(l."tokens") FILTER (WHERE l."occurred_at" >= ${starts.yearly}), 0)::bigint::text AS y_tokens
      FROM "usage_ledger" l
      ${scope === 'tag' ? Prisma.sql`CROSS JOIN LATERAL unnest(l."tags") AS t(tag)` : Prisma.empty}
      WHERE l."organization_id" = ${ctx.organizationId} AND l."occurred_at" >= ${from}
      GROUP BY 1`;
    const wanted = new Set<LimitScope>(['organization', 'team', 'project']);
    for (const l of limits) wanted.add(l.scope);
    const rows = new Map(
      await Promise.all(
        [...wanted].map(
          async (scope) =>
            [scope, await this.db.$queryRaw<Record<string, unknown>[]>(sums(scope))] as const,
        ),
      ),
    );
    const spend = (scope: LimitScope, id: string) => {
      const row = rows.get(scope)?.find((r) => r.scope_id === id);
      const of = (p: string) => ({
        usd: text(row?.[`${p}_usd`]),
        tokens: Number(row?.[`${p}_tokens`] ?? 0),
      });
      return { today: of('d'), week: of('w'), month: of('m'), year: of('y') };
    };
    const SPENT: Record<BudgetPeriod, 'today' | 'week' | 'month' | 'year'> = {
      daily: 'today',
      weekly: 'week',
      monthly: 'month',
      yearly: 'year',
    };
    const entry = (
      scope: LimitScope,
      target: { id: string; name: string; teamId?: string | null },
    ) => {
      const used = spend(scope, target.id);
      const limit = limits.find((l) => l.scope === scope && l.scopeId === target.id);
      return {
        scope,
        scopeId: target.id,
        name: target.name,
        ...(scope === 'project' ? { teamId: target.teamId ?? null } : {}),
        ...used,
        rateLimit:
          limit &&
          (limit.rpm ?? limit.tpm ?? limit.inputTpm ?? limit.outputTpm ?? limit.maxConcurrency) !==
            null
            ? {
                rpm: limit.rpm,
                tpm: limit.tpm,
                inputTpm: limit.inputTpm,
                outputTpm: limit.outputTpm,
                maxConcurrency: limit.maxConcurrency,
              }
            : null,
        budgets: (limit?.budgets ?? []).map((b) => {
          const spent = used[SPENT[b.period]];
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
    const organization = await this.target(ctx, 'organization', ctx.organizationId);
    return {
      dayStart: starts.daily.toISOString(),
      weekStart: starts.weekly.toISOString(),
      monthStart: starts.monthly.toISOString(),
      yearStart: starts.yearly.toISOString(),
      scopes: [
        entry('organization', { id: ctx.organizationId, name: organization.name }),
        ...teams.map((t) => entry('team', t)),
        ...projects.map((p) => entry('project', p)),
        ...limits
          .filter(
            (l) =>
              l.scope === 'user' ||
              l.scope === 'model' ||
              l.scope === 'provider' ||
              l.scope === 'tag' ||
              l.scope === 'cost_center' ||
              (l.scope === 'end_user' && l.scopeId !== END_USER_DEFAULT),
          )
          .map((l) => entry(l.scope, { id: l.scopeId, name: l.name })),
      ],
    };
  }
}
