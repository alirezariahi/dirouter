import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { StatsController } from './stats.controller.js';
import { StatsService } from './stats.service.js';

@Module({ controllers: [StatsController], providers: [StatsService, OrgGuard] })
export class StatsModule {}
