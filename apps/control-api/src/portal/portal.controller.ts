import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AccessGuard, CurrentUser } from '../auth/auth.guard.js';
import { type AccessClaims, REFRESH_TTL_SECONDS } from '../auth/crypto.js';
import { Email, Password, REFRESH_COOKIE } from '../auth/auth.controller.js';
import type { Session } from '../auth/auth.service.js';
import { API_PREFIX } from '../bootstrap.js';
import { ApiZodBody, ApiZodOk, ApiZodQuery, JsonObjectSchema, ZodPipe } from '../common/zod.js';
import { ENV, type Env } from '../env.js';
import { STATE_TTL_SECONDS } from '../security/sso.service.js';
import { PortalService } from './portal.service.js';

export const PORTAL_STATE_COOKIE = 'dr_portal_state';

export const SignupBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: Email,
  password: Password,
  organizationName: z.string().trim().min(1).max(100).optional(),
});
const CallbackQuery = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(512),
});
const SessionResponse = z.object({
  accessToken: z.string(),
  expiresIn: z.int(),
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
});
/** A password sign-up starts unverified and is told whether the link went out (card 23.4). */
const SignupResponse = SessionResponse.extend({
  emailVerified: z.boolean(),
  verificationEmailSent: z.boolean(),
});
export const VerifyBody = z.object({ token: z.string().min(16).max(256) });

const client = (req: FastifyRequest) => ({
  ip: req.ip,
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
});

/** Public endpoints of the self-service portal (card 19.5); everything else uses /orgs/:orgId. */
@ApiTags('portal')
@Controller('portal')
export class PortalController {
  constructor(
    @Inject(PortalService) private readonly portal: PortalService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  #secure(reply: FastifyReply) {
    return this.env.NODE_ENV === 'production' || reply.request.protocol === 'https';
  }

  /** Same cookie as the dashboard's sign-in: httpOnly, same-site, only for /auth paths. */
  #session(reply: FastifyReply, session: Session) {
    void reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: this.#secure(reply),
      sameSite: 'strict',
      path: `/${API_PREFIX}/auth`,
      maxAge: REFRESH_TTL_SECONDS,
    });
    return { accessToken: session.accessToken, expiresIn: session.expiresIn, user: session.user };
  }

  @Get('config')
  @ApiZodOk(JsonObjectSchema)
  config() {
    return this.portal.config();
  }

  @Get('market')
  @ApiZodOk(JsonObjectSchema)
  market() {
    return this.portal.market();
  }

  @Post('signup')
  @ApiZodBody(SignupBody)
  @ApiZodOk(SignupResponse)
  async signup(
    @Body(new ZodPipe(SignupBody)) body: z.infer<typeof SignupBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = await this.portal.signup(body, client(req));
    return {
      ...this.#session(reply, session),
      emailVerified: session.emailVerified,
      verificationEmailSent: session.verificationEmailSent,
    };
  }

  /** Opens the one-time link from the verification email; no session needed. */
  @Post('verify-email')
  @HttpCode(200)
  @ApiZodBody(VerifyBody)
  @ApiZodOk(z.object({ verified: z.literal(true), email: z.string() }))
  verifyEmail(@Body(new ZodPipe(VerifyBody)) body: z.infer<typeof VerifyBody>) {
    return this.portal.verifyEmail(body.token);
  }

  /** Sends a new verification link to the signed-in user (rate limited). */
  @Post('verify-email/resend')
  @HttpCode(200)
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  @ApiZodOk(z.object({ sent: z.boolean() }))
  resendVerification(@CurrentUser() user: AccessClaims) {
    return this.portal.resendVerification(user.sub);
  }

  @Post('oidc/start')
  @HttpCode(200)
  @ApiZodOk(z.object({ authorizationUrl: z.string() }))
  async oidcStart(@Res({ passthrough: true }) reply: FastifyReply) {
    const started = await this.portal.oidcStart();
    void reply.setCookie(PORTAL_STATE_COOKIE, started.binding, {
      httpOnly: true,
      secure: this.#secure(reply),
      // Lax: the cookie must survive the top-level redirect back from the provider.
      sameSite: 'lax',
      path: `/${API_PREFIX}/portal/oidc`,
      maxAge: STATE_TTL_SECONDS,
    });
    return { authorizationUrl: started.authorizationUrl };
  }

  @Get('oidc/callback')
  @ApiZodQuery(CallbackQuery)
  @ApiZodOk(SessionResponse)
  async oidcCallback(
    @Query(new ZodPipe(CallbackQuery)) q: z.infer<typeof CallbackQuery>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const binding = req.cookies[PORTAL_STATE_COOKIE];
    void reply.clearCookie(PORTAL_STATE_COOKIE, { path: `/${API_PREFIX}/portal/oidc` });
    return this.#session(
      reply,
      await this.portal.oidcCallback(q.code, q.state, binding, client(req)),
    );
  }
}
