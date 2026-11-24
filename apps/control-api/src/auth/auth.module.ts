import { Global, Module } from '@nestjs/common';

import { AuthController } from './auth.controller.js';
import { AccessGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { MfaController } from './mfa.controller.js';
import { ManagementTokenAuth } from './management-token.js';
import { MfaService } from './mfa.service.js';
import { SessionsService } from './sessions.service.js';
import { WebAuthnController } from './webauthn.controller.js';

@Global()
@Module({
  controllers: [AuthController, MfaController, WebAuthnController],
  providers: [AuthService, MfaService, SessionsService, ManagementTokenAuth, AccessGuard],
  exports: [AuthService, MfaService, SessionsService, ManagementTokenAuth, AccessGuard],
})
export class AuthModule {}
