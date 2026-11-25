import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { ProviderSpendController } from './provider-spend.controller.js';
import { ProviderSpendService } from './provider-spend.service.js';
import { ProvidersController } from './providers.controller.js';
import { ProvidersService } from './providers.service.js';

@Module({
  controllers: [ProvidersController, ProviderSpendController],
  providers: [ProvidersService, ProviderSpendService, OrgGuard],
  exports: [ProvidersService, ProviderSpendService],
})
export class ProvidersModule {}
