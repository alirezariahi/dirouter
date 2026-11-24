import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { ServiceAccountsController } from './service-accounts.controller.js';
import { ServiceAccountsService } from './service-accounts.service.js';

@Module({
  controllers: [ServiceAccountsController],
  providers: [ServiceAccountsService, OrgGuard],
})
export class ServiceAccountsModule {}
