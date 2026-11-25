import { AutoCostTier } from '@dirouter/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { AutoRoutingPoliciesService } from './auto.service.js';

const Patterns = z.array(z.string().min(1).max(200)).max(200);
const PolicyBody = z.object({
  costTier: AutoCostTier.nullable().optional().describe('null or absent: no price ceiling'),
  allowedModels: Patterns.optional().describe('model slugs or globs such as openai/*; empty: all'),
  deniedModels: Patterns.optional(),
  locked: z.boolean().optional().describe('organization only: keys can narrow, never widen'),
  reasoningEffort: z.enum(['auto', 'off']).optional(),
});
const Policy = z.object({
  scope: z.enum(['organization', 'key']),
  scopeId: z.string(),
  costTier: AutoCostTier.nullable(),
  allowedModels: z.array(z.string()),
  deniedModels: z.array(z.string()),
  locked: z.boolean(),
  reasoningEffort: z.enum(['auto', 'off']),
  updatedAt: z.string(),
});
const Overview = z.object({
  organization: Policy.nullable(),
  keys: z.array(Policy),
  tiers: z.object({ lowMaxPerMTok: z.string(), mediumMaxPerMTok: z.string() }),
  models: z.array(z.object({ slug: z.string(), blendedPerMTok: z.number(), tier: AutoCostTier })),
});

/** Controls of automatic routing: cost tier and allowed models (card 32.8). */
@ApiTags('routing policies')
@ApiBearerAuth()
@Controller('orgs/:orgId/routing/auto')
@UseGuards(AccessGuard, OrgGuard)
export class AutoRoutingPoliciesController {
  constructor(
    @Inject(AutoRoutingPoliciesService) private readonly service: AutoRoutingPoliciesService,
  ) {}

  @Get()
  @RequirePermission('models:read')
  @ApiZodOk(Overview)
  get(@Org() org: OrgContext) {
    return this.service.get(org);
  }

  /** The organization's policy; only administrators (models:write) set or lock it. */
  @Put()
  @RequirePermission('models:write')
  @ApiZodBody(PolicyBody)
  @ApiZodOk(Policy)
  put(@Org() org: OrgContext, @Body(new ZodPipe(PolicyBody)) body: z.infer<typeof PolicyBody>) {
    return this.service.putOrganization(org, body);
  }

  @Delete()
  @HttpCode(204)
  @RequirePermission('models:write')
  @ApiNoContentResponse()
  async remove(@Org() org: OrgContext) {
    await this.service.remove(org, 'organization', org.organizationId);
  }

  /** A key's own policy; under a locked organization policy it may only narrow it. */
  @Put('keys/:keyId')
  @RequirePermission('keys:write')
  @ApiZodBody(PolicyBody)
  @ApiZodOk(Policy)
  putKey(
    @Org() org: OrgContext,
    @Param('keyId') keyId: string,
    @Body(new ZodPipe(PolicyBody)) body: z.infer<typeof PolicyBody>,
  ) {
    return this.service.putKey(org, keyId, body);
  }

  @Delete('keys/:keyId')
  @HttpCode(204)
  @RequirePermission('keys:write')
  @ApiNoContentResponse()
  async removeKey(@Org() org: OrgContext, @Param('keyId') keyId: string) {
    await this.service.remove(org, 'key', keyId);
  }
}
