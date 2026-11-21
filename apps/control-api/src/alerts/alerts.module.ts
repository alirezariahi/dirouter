import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';

@Module({
  controllers: [AlertsController],
  providers: [AlertsService, OrgGuard],
  exports: [AlertsService],
})
export class AlertsModule {}
