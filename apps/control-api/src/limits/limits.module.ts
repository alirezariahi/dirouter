import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { LimitsController } from './limits.controller.js';
import { LimitsService } from './limits.service.js';

@Module({
  controllers: [LimitsController],
  providers: [LimitsService, OrgGuard],
})
export class LimitsModule {}
