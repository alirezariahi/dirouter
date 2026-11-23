import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { PlatformGuard } from './platform.guard.js';
import { BillingAdminController, WalletController } from './wallets.controller.js';
import { WalletsService } from './wallets.service.js';

@Module({
  controllers: [WalletController, BillingAdminController],
  providers: [WalletsService, OrgGuard, PlatformGuard],
  exports: [WalletsService],
})
export class BillingModule {}
