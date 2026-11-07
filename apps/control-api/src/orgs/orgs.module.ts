import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { OrgsController } from './orgs.controller.js';
import { OrgsService } from './orgs.service.js';

@Module({
  controllers: [OrgsController],
  providers: [OrgsService, OrgGuard],
  exports: [OrgsService, OrgGuard],
})
export class OrgsModule {}
