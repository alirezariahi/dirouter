import { Global, Module } from '@nestjs/common';

import { AuthController } from './auth.controller.js';
import { AccessGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, AccessGuard],
  exports: [AuthService, AccessGuard],
})
export class AuthModule {}
