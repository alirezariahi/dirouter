/**
 * Conditional routing rules (card 32.2): CRUD with validation at save time, and the share of the
 * organization's traffic each rule took. The gateway evaluates the rules; this service only makes
 * sure a stored rule compiles and points at something real.
 */
import { RoutingRuleAction } from '@dirouter/contracts';
import { expressionProblem } from '@dirouter/routing';
import { prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';
import { assertRoutableName, assertScope, invalid, notFound } from './targets.js';

export interface RuleInput {
  name: string;
  enabled?: boolean | undefined;
  priority?: number | undefined;
  teamId?: string | null | undefined;
  projectId?: string | null | undefined;
  condition: string;
  action: RoutingRuleAction;
}

type Row = NonNullable<Awaited<ReturnType<PrismaService['client']['routingRule']['findFirst']>>>;

export function viewRule(row: Row) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    teamId: row.teamId,
    projectId: row.projectId,
    condition: row.condition,
    action: row.action as RoutingRuleAction,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The condition compiles exactly as the gateway will compile it; otherwise a 400 with the problem. */
export function assertCondition(condition: string): void {
  const problem = expressionProblem(condition);
  if (problem) throw invalid(`condition: ${problem}`);
}

@Injectable()
export class RoutingRulesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  async list(org: OrgContext) {
    const rows = await this.db.routingRule.findMany({
      where: { organizationId: org.organizationId },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    return rows.map(viewRule);
  }

  async #validate(org: OrgContext, input: Omit<RuleInput, 'name'>) {
    assertCondition(input.condition);
    const action = RoutingRuleAction.safeParse(input.action);
    if (!action.success) throw invalid(`action: ${action.error.issues[0]?.message ?? 'invalid'}`);
    if (action.data.type === 'route')
      await assertRoutableName(this.db, org.organizationId, action.data.target, 'action.target');
    await assertScope(this.db, org.organizationId, input);
    return action.data;
  }

  async create(org: OrgContext, input: RuleInput) {
    const action = await this.#validate(org, input);
    const last = await this.db.routingRule.findFirst({
      where: { organizationId: org.organizationId },
      orderBy: { priority: 'desc' },
      select: { priority: true },
    });
    const row = await this.db.routingRule.create({
      data: {
        id: prefixedId('rrl'),
        organizationId: org.organizationId,
        name: input.name,
        enabled: input.enabled ?? true,
        priority: input.priority ?? (last ? last.priority + 10 : 10),
        teamId: input.teamId ?? null,
        projectId: input.projectId ?? null,
        condition: input.condition,
        action: action,
      },
    });
    await this.#audit(org, 'routing_rule.created', row.id, { name: row.name });
    this.snapshots.schedule('routing rule created', 0);
    return viewRule(row);
  }

  async update(org: OrgContext, id: string, patch: Partial<RuleInput>) {
    const stored = await this.#owned(org, id);
    const merged = {
      condition: patch.condition ?? stored.condition,
      action: (patch.action ?? stored.action) as RoutingRuleAction,
      teamId: patch.teamId === undefined ? stored.teamId : patch.teamId,
      projectId: patch.projectId === undefined ? stored.projectId : patch.projectId,
    };
    const action = await this.#validate(org, merged);
    const row = await this.db.routingRule.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        teamId: merged.teamId ?? null,
        projectId: merged.projectId ?? null,
        condition: merged.condition,
        action: action,
      },
    });
    await this.#audit(org, 'routing_rule.updated', id, { fields: Object.keys(patch) });
    this.snapshots.schedule('routing rule updated', 0);
    return viewRule(row);
  }

  async remove(org: OrgContext, id: string) {
    await this.#owned(org, id);
    await this.db.routingRule.delete({ where: { id } });
    await this.#audit(org, 'routing_rule.deleted', id);
    this.snapshots.schedule('routing rule deleted', 0);
  }

  /**
   * Share of the organization's requests each rule matched in the range, from the request log.
   * `decided` counts the requests the rule routed or rejected; `matched` includes tag rules.
   */
  async traffic(org: OrgContext, from: Date, to: Date) {
    const [totals, rows] = await Promise.all([
      this.db.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM "request_log"
        WHERE "organization_id" = ${org.organizationId}
          AND "created_at" >= ${from} AND "created_at" < ${to}`,
      this.db.$queryRaw<{ rule_id: string; matched: number; decided: number }[]>`
        SELECT m.rule_id,
               count(*)::int AS matched,
               count(*) FILTER (WHERE r."policy"->'rules'->>'decidedBy' = m.rule_id)::int AS decided
        FROM "request_log" r
        CROSS JOIN LATERAL jsonb_array_elements_text(r."policy"->'rules'->'matched') AS m(rule_id)
        WHERE r."organization_id" = ${org.organizationId}
          AND r."created_at" >= ${from} AND r."created_at" < ${to}
          AND r."policy" ? 'rules'
        GROUP BY m.rule_id`,
    ]);
    const total = totals[0]?.total ?? 0;
    const rules = await this.db.routingRule.findMany({
      where: { organizationId: org.organizationId },
      select: { id: true, name: true },
    });
    const byId = new Map(rows.map((r) => [r.rule_id, r]));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalRequests: total,
      rules: rules.map((r) => {
        const hit = byId.get(r.id);
        const matched = hit?.matched ?? 0;
        return {
          id: r.id,
          name: r.name,
          matched,
          decided: hit?.decided ?? 0,
          share: total > 0 ? Math.round((matched / total) * 10_000) / 10_000 : 0,
        };
      }),
    };
  }

  async #owned(org: OrgContext, id: string) {
    const row = await this.db.routingRule.findFirst({
      where: { id, organizationId: org.organizationId },
    });
    if (!row) throw notFound('routing rule');
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
