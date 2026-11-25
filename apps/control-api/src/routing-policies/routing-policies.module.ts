import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { RoutingPoliciesController } from './routing-policies.controller.js';
import { RoutingPoliciesService } from './routing-policies.service.js';
import { RoutingRulesController } from './rules.controller.js';
import { RoutingRulesService } from './rules.service.js';
import { TrafficSplitsController } from './splits.controller.js';
import { TrafficSplitsService } from './splits.service.js';
import { ShadowPoliciesController } from './shadows.controller.js';
import { ShadowPoliciesService } from './shadows.service.js';

/**
 * Routing policies per organization, project and key (cards 32.1, 32.5 and 32.7) and the rules
 * that run before candidate selection (cards 32.2–32.4, 32.8).
 */
@Module({
  controllers: [
    RoutingPoliciesController,
    RoutingRulesController,
    TrafficSplitsController,
    ShadowPoliciesController,
  ],
  providers: [
    RoutingPoliciesService,
    RoutingRulesService,
    TrafficSplitsService,
    ShadowPoliciesService,
    OrgGuard,
  ],
})
export class RoutingPoliciesModule {}
