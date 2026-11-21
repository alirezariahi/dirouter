import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import {
  SemanticCacheController,
  SemanticCacheInternalController,
} from './semantic-cache.controller.js';
import { SemanticCacheService } from './semantic-cache.service.js';

@Module({
  controllers: [SemanticCacheInternalController, SemanticCacheController],
  providers: [SemanticCacheService, OrgGuard],
  exports: [SemanticCacheService],
})
export class SemanticCacheModule {}
