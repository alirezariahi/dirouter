import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { SecurityController } from './security.controller.js';
import { SecurityService } from './security.service.js';
import { SsoAdminController, SsoPublicController } from './sso.controller.js';
import { SsoService } from './sso.service.js';

@Module({
  controllers: [SecurityController, SsoAdminController, SsoPublicController],
  providers: [SecurityService, SsoService, OrgGuard],
  exports: [SecurityService, SsoService],
})
export class SecurityModule {}
