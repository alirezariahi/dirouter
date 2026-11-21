import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { PlaygroundController } from './playground.controller.js';
import { PlaygroundService } from './playground.service.js';

@Module({
  controllers: [PlaygroundController],
  providers: [PlaygroundService, OrgGuard],
})
export class PlaygroundModule {}
