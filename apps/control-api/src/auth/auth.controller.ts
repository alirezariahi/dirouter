import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { API_PREFIX } from '../bootstrap.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { AccessGuard, CurrentUser } from './auth.guard.js';
import { type ClientInfo, AuthService, type Session } from './auth.service.js';
import { type AccessClaims, REFRESH_TTL_SECONDS } from './crypto.js';

export const REFRESH_COOKIE = 'dr_refresh';

const Email = z.email().max(254);
/** حداقل ۱۰ کاراکتر؛ سقف برای جلوگیری از DoS روی argon2. */
const Password = z.string().min(10).max(256);

export const SetupBody = z.object({
  organizationName: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  email: Email,
  password: Password,
});
export const LoginBody = z.object({ email: Email, password: z.string().min(1).max(256) });
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
    }),
  ),
});

const client = (req: FastifyRequest): ClientInfo => ({
  ip: req.ip,
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
});

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** refresh token فقط در کوکی httpOnly، فقط برای مسیرهای /auth و فقط same-site. */
  #setRefresh(reply: FastifyReply, session: Session) {
    void reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: true,
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
    return this.#setRefresh(reply, await this.auth.login(body.email, body.password, client(req)));
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
    return this.auth.me(user.sub);
  }
}
