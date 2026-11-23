import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { REFRESH_TTL_SECONDS } from '../auth/crypto.js';
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
  @ApiZodOk(SessionResponse)
  async signup(
    @Body(new ZodPipe(SignupBody)) body: z.infer<typeof SignupBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.#session(reply, await this.portal.signup(body, client(req)));
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
