import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { SecurityModule } from '../security/security.module.js';
import { PortalController } from './portal.controller.js';
import { PortalService } from './portal.service.js';

@Module({
  imports: [AuthModule, BillingModule, SecurityModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
