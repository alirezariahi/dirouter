import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { RoutingPoliciesController } from './routing-policies.controller.js';
import { RoutingPoliciesService } from './routing-policies.service.js';

/** Routing policies per organization, project and key (cards 32.1, 32.5 and 32.7). */
@Module({
  controllers: [RoutingPoliciesController],
  providers: [RoutingPoliciesService, OrgGuard],
})
export class RoutingPoliciesModule {}
