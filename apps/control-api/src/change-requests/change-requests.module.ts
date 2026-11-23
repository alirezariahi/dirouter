import { Global, Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { ChangeRequestsController } from './change-requests.controller.js';
import { ChangeRequestsService } from './change-requests.service.js';

/** Global: sensitive endpoints in other modules register their operations with the service. */
@Global()
@Module({
  controllers: [ChangeRequestsController],
  providers: [ChangeRequestsService, OrgGuard],
  exports: [ChangeRequestsService],
})
export class ChangeRequestsModule {}
