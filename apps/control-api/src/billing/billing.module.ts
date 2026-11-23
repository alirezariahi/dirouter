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
import { InvoicesAdminController, InvoicesController } from './invoices.controller.js';
import { InvoicesService } from './invoices.service.js';
import { PlatformGuard } from './platform.guard.js';
import { PricingAdminController, SubscriptionController } from './pricing.controller.js';
import { PricingService } from './pricing.service.js';
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
    PricingAdminController,
    SubscriptionController,
    InvoicesController,
    InvoicesAdminController,
  ],
  providers: [
    WalletsService,
    PaymentsService,
    GiftCodesService,
    PricingService,
    InvoicesService,
    OrgGuard,
    PlatformGuard,
  ],
  exports: [WalletsService, PaymentsService],
})
export class BillingModule {}
