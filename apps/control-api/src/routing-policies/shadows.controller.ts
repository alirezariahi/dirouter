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
import { range, RangeQuery } from './rules.controller.js';
import { ShadowPoliciesService } from './shadows.service.js';

const ShadowBody = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
  match: z.string().min(1).max(200).describe('the name clients ask for, or * for every request'),
  target: z.string().min(1).max(200).describe("one of the organization's own models"),
  sampleRate: z.number().min(0).max(1),
  dailyBudgetUsd: z.string().max(20).describe('the shadow traffic stops for the day at this spend'),
  projectId: z.string().nullable().optional(),
  timeoutMs: z.int().min(1_000).max(300_000).optional(),
});
const ShadowPatch = ShadowBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  'at least one field is required',
);
const Shadow = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  match: z.string(),
  target: z.string(),
  sampleRate: z.number(),
  dailyBudgetUsd: z.string(),
  projectId: z.string().nullable(),
  timeoutMs: z.int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const Side = z.object({
  errors: z.int(),
  avgLatencyMs: z.int().nullable(),
  p95LatencyMs: z.int().nullable(),
  costUsd: z.string(),
});
const Report = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  requests: z.int(),
  shadow: Side.extend({ model: z.string(), errorRate: z.number() }),
  primary: Side,
  today: z.object({ spentUsd: z.string(), dailyBudgetUsd: z.string(), capped: z.boolean() }),
});

/** Shadow traffic policies (card 32.4). */
@ApiTags('routing policies')
@ApiBearerAuth()
@Controller('orgs/:orgId/routing/shadows')
@UseGuards(AccessGuard, OrgGuard)
export class ShadowPoliciesController {
  constructor(@Inject(ShadowPoliciesService) private readonly service: ShadowPoliciesService) {}

  @Get()
  @RequirePermission('models:read')
  @ApiZodOk(z.array(Shadow))
  list(@Org() org: OrgContext) {
    return this.service.list(org);
  }

  @Post()
  @RequirePermission('models:write')
  @ApiZodBody(ShadowBody)
  @ApiZodOk(Shadow)
  create(@Org() org: OrgContext, @Body(new ZodPipe(ShadowBody)) body: z.infer<typeof ShadowBody>) {
    return this.service.create(org, body);
  }

  @Patch(':id')
  @RequirePermission('models:write')
  @ApiZodBody(ShadowPatch)
  @ApiZodOk(Shadow)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ShadowPatch)) body: z.infer<typeof ShadowPatch>,
  ) {
    return this.service.update(org, id, body);
  }

  /** Shadow versus primary: errors, latency and cost (default: last 24 hours), and today's spend. */
  @Get(':id/report')
  @RequirePermission('usage:read')
  @ApiZodQuery(RangeQuery)
  @ApiZodOk(Report)
  report(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>,
  ) {
    const { from, to } = range(q);
    return this.service.report(org, id, from, to);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('models:write')
  @ApiNoContentResponse()
  async remove(@Org() org: OrgContext, @Param('id') id: string) {
    await this.service.remove(org, id);
  }
}
