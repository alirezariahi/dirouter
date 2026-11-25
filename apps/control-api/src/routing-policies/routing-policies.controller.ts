import { RoutingPolicy } from '@dirouter/contracts';
import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { RoutingPoliciesService, RoutingPolicyBody } from './routing-policies.service.js';

const Policies = z.object({
  policies: z.array(
    z.object({
      scope: z.string(),
      scopeId: z.string(),
      policy: RoutingPolicy,
      updatedAt: z.string(),
    }),
  ),
});
const PolicySet = RoutingPolicyBody.extend({ configVersion: z.int() });

@ApiTags('models & routing')
@ApiBearerAuth()
@Controller('orgs/:orgId')
@UseGuards(AccessGuard, OrgGuard)
export class RoutingPoliciesController {
  constructor(@Inject(RoutingPoliciesService) private readonly service: RoutingPoliciesService) {}

  /** Routing policies of the organization, its projects and keys (cards 32.1, 32.5, 32.7). */
  @Get('routing-policies')
  @RequirePermission('config:read')
  @ApiZodOk(Policies)
  list(@Org() org: OrgContext) {
    return this.service.list(org);
  }

  /** Sets (or with `policy: null` removes) the policy of one scope. */
  @Put('routing-policies')
  @RequirePermission('config:write')
  @ApiZodBody(RoutingPolicyBody)
  @ApiZodOk(PolicySet, 'the policy applies once the gateway loads the new snapshot')
  set(
    @Org() org: OrgContext,
    @Body(new ZodPipe(RoutingPolicyBody)) body: z.infer<typeof RoutingPolicyBody>,
  ) {
    return this.service.set(org, body);
  }
}
