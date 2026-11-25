import { Module } from '@nestjs/common';

import { PlatformGuard } from '../billing/platform.guard.js';
import { OrgGuard } from '../rbac/org.guard.js';
import { CatalogSyncController } from './catalog-sync.controller.js';
import { CatalogService } from './catalog.service.js';
import { ModelsController } from './models.controller.js';
import { ModelsService } from './models.service.js';

@Module({
  controllers: [ModelsController, CatalogSyncController],
  providers: [ModelsService, CatalogService, OrgGuard, PlatformGuard],
  exports: [ModelsService, CatalogService],
})
export class ModelsModule {}
