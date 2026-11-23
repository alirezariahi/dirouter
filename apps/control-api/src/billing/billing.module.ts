import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import {
  BillingPaymentsAdminController,
  PaymentCallbacksController,
  WalletPaymentsController,
} from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { GiftBatchesController, RedeemController } from './gift-codes.controller.js';
import { GiftCodesService } from './gift-codes.service.js';
import { PlatformGuard } from './platform.guard.js';
import { BillingAdminController, WalletController } from './wallets.controller.js';
import { WalletsService } from './wallets.service.js';

@Module({
  controllers: [
    WalletController,
    WalletPaymentsController,
    PaymentCallbacksController,
    BillingAdminController,
    BillingPaymentsAdminController,
    GiftBatchesController,
    RedeemController,
  ],
  providers: [WalletsService, PaymentsService, GiftCodesService, OrgGuard, PlatformGuard],
  exports: [WalletsService, PaymentsService],
})
export class BillingModule {}
