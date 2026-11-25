import { RoutingRuleAction } from '@dirouter/contracts';
import { expressionProblem, RULE_VARIABLES } from '@dirouter/routing';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ApiZodQuery, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { RoutingRulesService } from './rules.service.js';

const RuleBody = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
  priority: z.int().min(0).max(1_000_000).optional(),
  teamId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  condition: z.string().min(1).max(2_000).describe('CEL-subset condition, e.g. budget.team > 80'),
  action: RoutingRuleAction,
});
const RulePatch = RuleBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  'at least one field is required',
);
const Rule = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  priority: z.int(),
  teamId: z.string().nullable(),
  projectId: z.string().nullable(),
  condition: z.string(),
  action: RoutingRuleAction,
  createdAt: z.string(),
  updatedAt: z.string(),
});
const ValidateBody = z.object({ condition: z.string().max(4_000) });
const Validation = z.object({
  valid: z.boolean(),
  problem: z.string().optional(),
  variables: z.record(z.string(), z.record(z.string(), z.string())),
});
export const RangeQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export const range = (q: z.infer<typeof RangeQuery>, defaultMs = 86_400_000) => {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - defaultMs);
  return { from, to };
};
const Traffic = z.object({
  from: z.string(),
  to: z.string(),
  totalRequests: z.int(),
  rules: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      matched: z.int(),
      decided: z.int(),
      share: z.number(),
    }),
  ),
});

/** Conditional routing rules of an organization (card 32.2). */
@ApiTags('routing policies')
@ApiBearerAuth()
@Controller('orgs/:orgId/routing/rules')
@UseGuards(AccessGuard, OrgGuard)
export class RoutingRulesController {
  constructor(@Inject(RoutingRulesService) private readonly service: RoutingRulesService) {}

  @Get()
  @RequirePermission('models:read')
  @ApiZodOk(z.array(Rule))
  list(@Org() org: OrgContext) {
    return this.service.list(org);
  }

  @Post()
  @RequirePermission('models:write')
  @ApiZodBody(RuleBody)
  @ApiZodOk(Rule)
  create(@Org() org: OrgContext, @Body(new ZodPipe(RuleBody)) body: z.infer<typeof RuleBody>) {
    return this.service.create(org, body);
  }

  /** Checks a condition without saving it (the editor calls this as you type). */
  @Post('validate')
  @HttpCode(200)
  @RequirePermission('models:read')
  @ApiZodBody(ValidateBody)
  @ApiZodOk(Validation)
  validate(@Body(new ZodPipe(ValidateBody)) body: z.infer<typeof ValidateBody>) {
    const problem = expressionProblem(body.condition);
    return { valid: !problem, ...(problem ? { problem } : {}), variables: RULE_VARIABLES };
  }

  /** Share of the organization's requests each rule matched in the range (default: last 24 hours). */
  @Get('traffic')
  @RequirePermission('usage:read')
  @ApiZodQuery(RangeQuery)
  @ApiZodOk(Traffic)
  traffic(@Org() org: OrgContext, @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    const { from, to } = range(q);
    return this.service.traffic(org, from, to);
  }

  @Patch(':id')
  @RequirePermission('models:write')
  @ApiZodBody(RulePatch)
  @ApiZodOk(Rule)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(RulePatch)) body: z.infer<typeof RulePatch>,
  ) {
    return this.service.update(org, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('models:write')
  @ApiNoContentResponse()
  async remove(@Org() org: OrgContext, @Param('id') id: string) {
    await this.service.remove(org, id);
  }
}
