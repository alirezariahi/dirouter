import { Body, Controller, Delete, Get, Inject, Param, Put, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ChangeRequestsService } from '../change-requests/change-requests.service.js';
import { sendGated } from '../change-requests/gated.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { LIMIT_SCOPES, type LimitInput, type LimitScope, LimitsService } from './limits.service.js';
import { BUDGET_PERIODS } from './periods.js';

const Scope = z
  .enum(LIMIT_SCOPES)
  .describe(
    'organization (scope id = the organization id), team, project, user, model or provider',
  );
const Period = z.enum(BUDGET_PERIODS).describe('UTC; weeks start on Monday');
const Budget = z.object({
  period: Period,
  limitUsd: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,8})?$/)
    .optional(),
  limitTokens: z.int().positive().optional(),
  alertThresholds: z.array(z.int().min(1).max(100)).max(10).optional(),
});
export const LimitBody = z.object({
  rpm: z.int().positive().nullable().optional(),
  tpm: z.int().positive().nullable().optional(),
  /** Input and output tokens per minute apart (card 33.3). */
  inputTpm: z.int().positive().nullable().optional(),
  outputTpm: z.int().positive().nullable().optional(),
  maxConcurrency: z.int().positive().nullable().optional(),
  /** Replaces every budget of the scope (at most one per period); absent keeps them. */
  budgets: z.array(Budget).max(4).optional(),
});
const BudgetView = z.object({
  id: z.string(),
  period: Period,
  limitUsd: z.string().nullable(),
  limitTokens: z.int().nullable(),
  alertThresholds: z.array(z.int()),
});
const LimitView = z.object({
  scope: Scope,
  scopeId: z.string(),
  name: z.string(),
  rpm: z.int().nullable(),
  tpm: z.int().nullable(),
  inputTpm: z.int().nullable(),
  outputTpm: z.int().nullable(),
  maxConcurrency: z.int().nullable(),
  budgets: z.array(BudgetView),
});
const Spend = z.object({ usd: z.string(), tokens: z.int() });
const UsageView = z.object({
  dayStart: z.string(),
  weekStart: z.string(),
  monthStart: z.string(),
  yearStart: z.string(),
  scopes: z.array(
    z.object({
      scope: Scope,
      scopeId: z.string(),
      name: z.string(),
      teamId: z.string().nullable().optional(),
      today: Spend,
      week: Spend,
      month: Spend,
      year: Spend,
      rateLimit: z
        .object({
          rpm: z.int().nullable(),
          tpm: z.int().nullable(),
          inputTpm: z.int().nullable(),
          outputTpm: z.int().nullable(),
          maxConcurrency: z.int().nullable(),
        })
        .nullable(),
      budgets: z.array(
        BudgetView.extend({
          spentUsd: z.string(),
          spentTokens: z.int(),
          usedPercent: z.number().nullable(),
        }),
      ),
    }),
  ),
});
const ScopeParam = new ZodPipe(Scope);
const CLEAR: LimitInput = {
  rpm: null,
  tpm: null,
  inputTpm: null,
  outputTpm: null,
  maxConcurrency: null,
  budgets: [],
};

interface Payload {
  scope: LimitScope;
  scopeId: string;
  patch: LimitInput;
}

@ApiTags('limits')
@ApiBearerAuth()
@Controller('orgs/:orgId/limits')
@UseGuards(AccessGuard, OrgGuard)
export class LimitsController {
  constructor(
    @Inject(LimitsService) private readonly limits: LimitsService,
    @Inject(ChangeRequestsService) private readonly changes: ChangeRequestsService,
  ) {
    // Budget changes are sensitive (card 22.2), as for keys: the whole change waits for approval.
    changes.register<Payload>('limit.budgets', {
      permission: 'org:write',
      targetId: (p) => p.scopeId,
      describe: async (ctx, p) =>
        `Change the budgets of ${p.scope} ${(await this.limits.target(ctx, p.scope, p.scopeId)).name}`,
      apply: (ctx, p) => this.limits.set(ctx, p.scope, p.scopeId, p.patch),
    });
  }

  @Get()
  @RequirePermission('org:read')
  @ApiZodOk(
    z.array(LimitView),
    'The organization, teams, projects, members, models and providers that have a rate limit or a budget',
  )
  list(@Org() org: OrgContext) {
    return this.limits.list(org);
  }

  @Get('usage')
  @RequirePermission('usage:read')
  @ApiZodOk(
    UsageView,
    'Spend of the organization, every team and project and every limited member, model and provider in the current day, week, month and year, with their limits',
  )
  usage(@Org() org: OrgContext) {
    return this.limits.usage(org);
  }

  @Get(':scope/:scopeId')
  @RequirePermission('org:read')
  @ApiZodOk(LimitView)
  get(
    @Org() org: OrgContext,
    @Param('scope', ScopeParam) scope: LimitScope,
    @Param('scopeId') scopeId: string,
  ) {
    return this.limits.get(org, scope, scopeId);
  }

  @Put(':scope/:scopeId')
  @RequirePermission('org:write')
  @ApiZodBody(LimitBody)
  @ApiZodOk(LimitView, '202 with the change request when a budget change waits for approval')
  async set(
    @Org() org: OrgContext,
    @Param('scope', ScopeParam) scope: LimitScope,
    @Param('scopeId') scopeId: string,
    @Body(new ZodPipe(LimitBody)) body: z.infer<typeof LimitBody>,
    @Res() reply: FastifyReply,
  ) {
    const gate = (await this.limits.changesBudgets(org, scope, scopeId, body))
      ? await this.changes.gate(org, 'limit.budgets', { scope, scopeId, patch: body })
      : {};
    return sendGated(reply, gate, () => this.limits.set(org, scope, scopeId, body));
  }

  @Delete(':scope/:scopeId')
  @RequirePermission('org:write')
  @ApiZodOk(LimitView, 'All limits removed; 202 when removing budgets waits for approval')
  async remove(
    @Org() org: OrgContext,
    @Param('scope', ScopeParam) scope: LimitScope,
    @Param('scopeId') scopeId: string,
    @Res() reply: FastifyReply,
  ) {
    const gate = (await this.limits.changesBudgets(org, scope, scopeId, CLEAR))
      ? await this.changes.gate(org, 'limit.budgets', { scope, scopeId, patch: CLEAR })
      : {};
    return sendGated(reply, gate, () => this.limits.set(org, scope, scopeId, CLEAR));
  }
}
