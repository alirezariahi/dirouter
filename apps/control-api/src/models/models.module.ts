import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { ModelsController } from './models.controller.js';
import { ModelsService } from './models.service.js';

@Module({
  controllers: [ModelsController],
  providers: [ModelsService, OrgGuard],
  exports: [ModelsService],
})
export class ModelsModule {}
