import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { LiveController } from './live.controller.js';
import { LiveHub } from './live.hub.js';
import { StatsController } from './stats.controller.js';
import { StatsService } from './stats.service.js';

@Module({
  controllers: [StatsController, LiveController],
  providers: [StatsService, LiveHub, OrgGuard],
  exports: [StatsService],
})
export class StatsModule {}
