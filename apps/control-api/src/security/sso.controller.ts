import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { API_PREFIX } from '../bootstrap.js';
import { REFRESH_COOKIE } from '../auth/auth.controller.js';
import { type ClientInfo, type Session } from '../auth/auth.service.js';
import { AccessGuard } from '../auth/auth.guard.js';
import { REFRESH_TTL_SECONDS } from '../auth/crypto.js';
import {
  ApiZodBody,
  ApiZodOk,
  ApiZodQuery,
  JsonListSchema,
  JsonObjectSchema,
  ZodPipe,
} from '../common/zod.js';
import { ENV, type Env } from '../env.js';
import { ForbiddenError } from '@dirouter/shared';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { SsoService, STATE_TTL_SECONDS } from './sso.service.js';

/** HttpOnly cookie that ties an SSO `state` to the browser that started the flow. */
export const SSO_STATE_COOKIE = 'dr_sso_state';

// OWNER is never assignable through SSO; the service also rejects roles above the editor's own.
const Role = z.enum(['ADMIN', 'MEMBER', 'VIEWER']);
export const SsoBody = z.object({
  name: z.string().trim().min(1).max(100),
  /** `oidc` (default) or `saml` (card 22.1). */
  protocol: z.enum(['oidc', 'saml']).optional(),
  /** OIDC issuer URL, or the SAML IdP entity ID. */
  issuer: z.string().trim().min(1).max(500),
  /** OIDC client ID, or the SAML SP entity ID. */
  clientId: z.string().trim().min(1).max(300),
  /** OIDC only. */
  clientSecret: z.string().min(1).max(2000).optional(),
  samlSsoUrl: z.url().max(1000).optional(),
  samlCert: z.string().min(1).max(20_000).optional(),
  enabled: z.boolean().optional(),
  defaultRole: Role.optional(),
  allowedDomains: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)
        .max(253),
    )
    .min(1)
    .max(50),
  groupRoleMap: z.record(z.string().max(200), Role).optional(),
});
const SsoPatch = SsoBody.omit({ protocol: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
const LookupBody = z.object({ email: z.email().max(254) });
/** Optional and only checked: the redirect URI is derived from PUBLIC_DASHBOARD_URL. */
const StartBody = z.object({ redirectUri: z.url().max(1000).optional() }).optional();
const CallbackQuery = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(200),
});

const client = (req: FastifyRequest): ClientInfo => ({
  ip: req.ip,
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
});

/** Public OIDC endpoints used by the login page (no session required). */
@ApiTags('auth')
@Controller('auth/sso')
export class SsoPublicController {
  constructor(
    @Inject(SsoService) private readonly sso: SsoService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Which SSO connection (if any) applies to an email address. */
  @Post('lookup')
  @HttpCode(200)
  @ApiZodBody(LookupBody)
  @ApiZodOk(z.object({ connectionId: z.string(), name: z.string() }).nullable())
  lookup(@Body(new ZodPipe(LookupBody)) body: z.infer<typeof LookupBody>) {
    return this.sso.lookup(body.email);
  }

  #stateCookie(reply: FastifyReply) {
    return {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production' || reply.request.protocol === 'https',
      // Lax, not strict: the cookie must survive the top-level redirect back from the provider.
      sameSite: 'lax' as const,
      path: `/${API_PREFIX}/auth/sso`,
    };
  }

  @Post(':connectionId/start')
  @HttpCode(200)
  @ApiZodBody(StartBody)
  @ApiZodOk(z.object({ authorizationUrl: z.string(), state: z.string() }))
  async start(
    @Param('connectionId') connectionId: string,
    @Body(new ZodPipe(StartBody)) body: z.infer<typeof StartBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const started = await this.sso.start(connectionId, body?.redirectUri);
    void reply.setCookie(SSO_STATE_COOKIE, started.binding, {
      ...this.#stateCookie(reply),
      maxAge: STATE_TTL_SECONDS,
    });
    return { authorizationUrl: started.authorizationUrl, state: started.state };
  }

  /**
   * SAML Assertion Consumer Service (card 22.1): validates the posted assertion and sends the
   * browser back to the dashboard, which finishes the sign-in through `callback`.
   */
  @Post('saml/:connectionId/acs')
  @ApiExcludeEndpoint()
  async samlAcs(
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ) {
    const back = await this.sso.acs(
      connectionId,
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {},
    );
    await reply.status(303).header('location', back).send();
  }

  /** SP metadata (entity ID, ACS URL) to configure the identity provider with. */
  @Get('saml/:connectionId/metadata')
  @ApiExcludeEndpoint()
  async samlMetadata(@Param('connectionId') connectionId: string, @Res() reply: FastifyReply) {
    await reply
      .header('content-type', 'application/samlmetadata+xml; charset=utf-8')
      .send(await this.sso.samlMetadata(connectionId));
  }

  @Get('callback')
  @ApiZodQuery(CallbackQuery)
  @ApiZodOk(JsonObjectSchema)
  async callback(
    @Query(new ZodPipe(CallbackQuery)) q: z.infer<typeof CallbackQuery>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Omit<Session, 'refreshToken'> & { organizationId: string }> {
    const binding = req.cookies[SSO_STATE_COOKIE];
    void reply.clearCookie(SSO_STATE_COOKIE, this.#stateCookie(reply));
    const session = await this.sso.callback(q.code, q.state, binding, client(req));
    void reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production' || reply.request.protocol === 'https',
      sameSite: 'strict',
      path: `/${API_PREFIX}/auth`,
      maxAge: REFRESH_TTL_SECONDS,
    });
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
      organizationId: session.organizationId,
    };
  }
}

/** Connection management for the security page. */
/**
 * Whoever controls a connection controls who its identity provider says a user is, which
 * includes the owner's e-mail address. Only an owner may therefore create, change or remove one;
 * `security:write` alone (admins, custom roles) is enough to list them.
 */
function ownerOnly(org: OrgContext): void {
  if (org.role !== 'OWNER')
    throw new ForbiddenError('forbidden', {
      message: 'Only an organization owner can manage SSO connections',
    });
}

@ApiTags('security')
@ApiBearerAuth()
@Controller('orgs/:orgId/sso')
@UseGuards(AccessGuard, OrgGuard)
export class SsoAdminController {
  constructor(@Inject(SsoService) private readonly sso: SsoService) {}

  @Get()
  @RequirePermission('security:write')
  @ApiZodOk(JsonListSchema)
  list(@Org() org: OrgContext) {
    return this.sso.list(org);
  }

  @Post()
  @RequirePermission('security:write')
  @ApiZodBody(SsoBody)
  @ApiZodOk(JsonObjectSchema)
  create(@Org() org: OrgContext, @Body(new ZodPipe(SsoBody)) body: z.infer<typeof SsoBody>) {
    ownerOnly(org);
    return this.sso.create(org, body);
  }

  @Patch(':id')
  @RequirePermission('security:write')
  @ApiZodBody(SsoPatch)
  @ApiZodOk(JsonObjectSchema)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(SsoPatch)) body: z.infer<typeof SsoPatch>,
  ) {
    ownerOnly(org);
    return this.sso.update(org, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('security:write')
  @ApiNoContentResponse()
  async remove(@Org() org: OrgContext, @Param('id') id: string) {
    ownerOnly(org);
    await this.sso.remove(org, id);
  }
}
