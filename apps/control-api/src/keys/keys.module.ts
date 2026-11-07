import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { KeysController } from './keys.controller.js';
import { KeysService } from './keys.service.js';

@Module({
  controllers: [KeysController],
  providers: [KeysService, OrgGuard],
  exports: [KeysService],
})
export class KeysModule {}
