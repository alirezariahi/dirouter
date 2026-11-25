import { Module } from '@nestjs/common';

import { LimitsService } from '../limits/limits.service.js';
import { OrgGuard } from '../rbac/org.guard.js';
import { EndUsersController } from './end-users.controller.js';
import { EndUsersService } from './end-users.service.js';

@Module({
  controllers: [EndUsersController],
  providers: [EndUsersService, LimitsService, OrgGuard],
})
export class EndUsersModule {}
