import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { AccessGuard, assertOwnCredentialSession, CurrentUser } from './auth.guard.js';
import type { AccessClaims } from './crypto.js';
import { type MfaActor, MfaService } from './mfa.service.js';

const Code = z.object({ code: z.string().min(6).max(16) });
/** `code` is the current TOTP or backup code; required only when MFA is already enabled. */
const SetupBody = Code.partial().optional();

/** Every change to the second factor needs a session opened with the user's own credentials. */
const actor = (user: AccessClaims, req: FastifyRequest): MfaActor => {
  assertOwnCredentialSession(user);
  return { userId: user.sub, email: user.email, ip: req.ip };
};

const StatusView = z.object({
  enabled: z.boolean(),
  pending: z.boolean(),
  backupCodesRemaining: z.int(),
});

@ApiTags('auth')
@Controller('auth/mfa')
@UseGuards(AccessGuard)
@ApiBearerAuth()
export class MfaController {
  constructor(@Inject(MfaService) private readonly mfa: MfaService) {}

  @Get()
  @ApiZodOk(StatusView, 'وضعیت ورود دومرحله‌ای')
  status(@CurrentUser() user: AccessClaims) {
    return this.mfa.status(user.sub);
  }

  @Post('setup')
  @HttpCode(200)
  @ApiZodBody(SetupBody)
  @ApiZodOk(
    z.object({ secret: z.string(), otpauthUrl: z.string() }),
    'کلید TOTP برای اسکن با اپ Authenticator',
  )
  setup(
    @CurrentUser() user: AccessClaims,
    @Req() req: FastifyRequest,
    @Body(new ZodPipe(SetupBody)) body: z.infer<typeof SetupBody>,
  ) {
    return this.mfa.begin(actor(user, req), body?.code);
  }

  @Post('verify')
  @HttpCode(200)
  @ApiZodBody(Code)
  @ApiZodOk(z.object({ backupCodes: z.array(z.string()) }), 'کدهای پشتیبان؛ فقط یک‌بار نمایش')
  verify(
    @CurrentUser() user: AccessClaims,
    @Req() req: FastifyRequest,
    @Body(new ZodPipe(Code)) body: z.infer<typeof Code>,
  ) {
    return this.mfa.verify(actor(user, req), body.code);
  }

  @Post('disable')
  @HttpCode(204)
  @ApiZodBody(Code)
  @ApiNoContentResponse({ description: 'ورود دومرحله‌ای خاموش شد' })
  async disable(
    @CurrentUser() user: AccessClaims,
    @Req() req: FastifyRequest,
    @Body(new ZodPipe(Code)) body: z.infer<typeof Code>,
  ) {
    await this.mfa.disable(actor(user, req), body.code);
  }
}
