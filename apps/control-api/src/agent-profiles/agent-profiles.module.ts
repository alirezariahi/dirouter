import { Module } from '@nestjs/common';

import { KeysModule } from '../keys/keys.module.js';
import { OrgGuard } from '../rbac/org.guard.js';
import { AgentProfilesController } from './agent-profiles.controller.js';
import { AgentProfilesService } from './agent-profiles.service.js';

@Module({
  imports: [KeysModule],
  controllers: [AgentProfilesController],
  providers: [AgentProfilesService, OrgGuard],
})
export class AgentProfilesModule {}
