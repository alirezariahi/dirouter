import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { SnapshotModule } from '../snapshot/snapshot.module.js';
import { ScimController, ScimGuard, ScimTokensController } from './scim.controller.js';
import { ScimService } from './scim.service.js';

@Module({
  imports: [SnapshotModule],
  controllers: [ScimController, ScimTokensController],
  providers: [ScimService, ScimGuard, OrgGuard],
})
export class ScimModule {}
