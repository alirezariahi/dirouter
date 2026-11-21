import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { ConfigController } from './config.controller.js';
import { ConfigService } from './config.service.js';

@Module({
  controllers: [ConfigController],
  providers: [ConfigService, OrgGuard],
  exports: [ConfigService],
})
export class ConfigModule {}
