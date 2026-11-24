import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ValidationError } from '@dirouter/shared';
import { z } from 'zod';

import { API_PREFIX } from '../bootstrap.js';
import { ENV, type Env } from '../env.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { AccessGuard, CurrentUser } from './auth.guard.js';
import { type ClientInfo, AuthService, type Session } from './auth.service.js';
import { type AccessClaims, REFRESH_TTL_SECONDS } from './crypto.js';
import { SessionsService } from './sessions.service.js';

export const REFRESH_COOKIE = 'dr_refresh';

export const Email = z.email().max(254);
/** At least 10 characters; a maximum to prevent DoS on argon2. */
export const Password = z.string().min(10).max(256);

export const SetupBody = z.object({
  organizationName: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  email: Email,
  password: Password,
});
export const LoginBody = z.object({
  email: Email,
  password: z.string().min(1).max(256),
  /** TOTP or backup code when MFA is enabled (card 14.1). */
  mfaCode: z.string().min(6).max(16).optional(),
});
export const AcceptInviteBody = z.object({
  token: z.string().min(16).max(128),
  name: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(1).max(256),
  /** Required when the invitation is accepted by an existing account that has MFA enabled. */
  mfaCode: z.string().min(6).max(16).optional(),
});
export const PasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: Password,
});

const SessionResponse = z.object({
  accessToken: z.string(),
  expiresIn: z.int(),
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
});
const MeResponse = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  organizations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']),
      permissions: z.array(z.string()),
      /** The operator's organization, where the billing pages live (card 25.1). */
      isPlatform: z.boolean(),
    }),
  ),
});

export const SessionSchema = z.object({
  id: z.string(),
  device: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  expiresAt: z.string(),
  method: z.enum(['pwd', 'passkey', 'sso']),
  current: z.boolean(),
});
export const RevokeAllBody = z.object({
  /** false (the default) keeps the session making the request signed in. */
  includeCurrent: z.boolean().default(false),
});

const client = (req: FastifyRequest): ClientInfo => ({
  ip: req.ip,
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
});

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  /** Refresh token only in an httpOnly cookie, only for /auth paths, and same-site only. */
  #setRefresh(reply: FastifyReply, session: Session) {
    void reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      // Always Secure in production; in dev only over https (behind Traefik via X-Forwarded-Proto),
      // so the dashboard also keeps the session after reload on http://app.localhost.
      secure: this.env.NODE_ENV === 'production' || reply.request.protocol === 'https',
      sameSite: 'strict',
      path: `/${API_PREFIX}/auth`,
      maxAge: REFRESH_TTL_SECONDS,
    });
    return { accessToken: session.accessToken, expiresIn: session.expiresIn, user: session.user };
  }

  #clearRefresh(reply: FastifyReply) {
    void reply.clearCookie(REFRESH_COOKIE, { path: `/${API_PREFIX}/auth` });
  }

  @Get('setup')
  @ApiZodOk(z.object({ required: z.boolean() }), 'آیا ویزارد راه‌اندازی هنوز لازم است')
  async setupStatus() {
    return { required: await this.auth.setupRequired() };
  }

  @Post('setup')
  @ApiZodBody(SetupBody)
  @ApiZodOk(SessionResponse, 'سازمان و مالک ساخته شد؛ refresh token در کوکی')
  async setup(
    @Body(new ZodPipe(SetupBody)) body: z.infer<typeof SetupBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.#setRefresh(reply, await this.auth.setup(body, client(req)));
  }

  @Post('login')
  @HttpCode(200)
  @ApiZodBody(LoginBody)
  @ApiZodOk(SessionResponse)
  async login(
    @Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.#setRefresh(
      reply,
      await this.auth.login(body.email, body.password, client(req), body.mfaCode),
    );
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiZodOk(SessionResponse, 'توکن چرخیده؛ توکن قبلی دیگر قابل استفاده نیست')
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    try {
      return this.#setRefresh(
        reply,
        await this.auth.refresh(req.cookies[REFRESH_COOKIE], client(req)),
      );
    } catch (error) {
      this.#clearRefresh(reply);
      throw error;
    }
  }

  @Post('invitations/accept')
  @HttpCode(200)
  @ApiZodBody(AcceptInviteBody)
  @ApiZodOk(SessionResponse, 'عضو سازمان شد و وارد شد')
  async acceptInvitation(
    @Body(new ZodPipe(AcceptInviteBody)) body: z.infer<typeof AcceptInviteBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // The new user's password must also meet the minimum 10-character policy.
    if (body.name !== undefined && body.password.length < 10)
      throw new ValidationError([
        { path: 'password', message: 'Too small: expected at least 10 characters' },
      ]);
    return this.#setRefresh(reply, await this.auth.acceptInvitation(body, client(req)));
  }

  @Post('logout')
  @HttpCode(204)
  @ApiNoContentResponse()
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(req.cookies[REFRESH_COOKIE]);
    this.#clearRefresh(reply);
  }

  @Post('password')
  @HttpCode(204)
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  @ApiZodBody(PasswordBody)
  @ApiNoContentResponse({ description: 'رمز عوض شد و همهٔ نشست‌ها باطل شدند' })
  async password(
    @CurrentUser() user: AccessClaims,
    @Body(new ZodPipe(PasswordBody)) body: z.infer<typeof PasswordBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.changePassword(user.sub, body.currentPassword, body.newPassword);
    this.#clearRefresh(reply);
  }

  @Get('me')
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  @ApiZodOk(MeResponse)
  me(@CurrentUser() user: AccessClaims) {
    return this.auth.me(user.sub, user.amr === 'sso' ? (user.org ?? '') : undefined);
  }

  @Get('sessions')
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  @ApiZodOk(z.array(SessionSchema), 'نشست‌های فعال کاربر؛ نشست همین درخواست current است')
  listSessions(@CurrentUser() user: AccessClaims) {
    return this.sessions.list(user.sub, user.sid);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'نشست باطل شد؛ refresh token آن دیگر کار نمی‌کند' })
  async revokeSession(
    @CurrentUser() user: AccessClaims,
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.sessions.revoke(user.sub, id, req.ip);
    if (id === user.sid) this.#clearRefresh(reply);
  }

  @Post('sessions/revoke-all')
  @HttpCode(200)
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  @ApiZodBody(RevokeAllBody)
  @ApiZodOk(
    z.object({ revoked: z.int() }),
    'خروج از همهٔ دستگاه‌ها (به‌جز همین، مگر includeCurrent)',
  )
  async revokeAllSessions(
    @CurrentUser() user: AccessClaims,
    @Body(new ZodPipe(RevokeAllBody)) body: z.infer<typeof RevokeAllBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.sessions.revokeAll(user.sub, {
      keepSid: body.includeCurrent ? undefined : user.sid,
      ip: req.ip,
    });
    if (body.includeCurrent) this.#clearRefresh(reply);
    return result;
  }
}
