import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { ProvidersController } from './providers.controller.js';
import { ProvidersService } from './providers.service.js';

@Module({
  controllers: [ProvidersController],
  providers: [ProvidersService, OrgGuard],
  exports: [ProvidersService],
})
export class ProvidersModule {}
