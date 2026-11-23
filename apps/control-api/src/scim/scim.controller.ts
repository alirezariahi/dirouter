/**
 * SCIM 2.0 endpoints at /api/v1/scim/v2 (card 22.1), authenticated with an organization's SCIM
 * bearer token, and the token management API for organization owners.
 */
import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  Controller,
  Delete,
  type ExceptionFilter,
  type ExecutionContext,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
  Body,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { DiRouterError, ForbiddenError } from '@dirouter/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { ENV, type Env } from '../env.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { SCHEMAS, ScimError } from './errors.js';
import { ScimService, userInput, userPatch } from './scim.service.js';

type ScimRequest = FastifyRequest & { scimOrganization?: string };

@Injectable()
export class ScimGuard implements CanActivate {
  constructor(@Inject(ScimService) private readonly scim: ScimService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ScimRequest>();
    const header = req.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token) throw new DiRouterError('unauthenticated');
    req.scimOrganization = await this.scim.organizationFor(token);
    return true;
  }
}

/** Errors in the SCIM format, which identity providers read to decide what to do. */
@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const status =
      exception instanceof DiRouterError
        ? exception.status
        : exception instanceof HttpException
          ? exception.getStatus()
          : 500;
    const detail =
      status >= 500 ? 'internal error' : (exception as Error).message || 'request failed';
    void reply
      .status(status)
      .header('content-type', 'application/scim+json')
      .send({
        schemas: [SCHEMAS.error],
        status: String(status),
        detail,
        ...(exception instanceof ScimError && exception.scimType
          ? { scimType: exception.scimType }
          : {}),
      });
  }
}

const send = (reply: FastifyReply, status: number, body?: unknown) =>
  reply
    .status(status)
    .header('content-type', 'application/scim+json')
    .send(body === undefined ? undefined : body);

@ApiExcludeController()
@Controller('scim/v2')
@UseGuards(ScimGuard)
@UseFilters(ScimExceptionFilter)
export class ScimController {
  constructor(
    @Inject(ScimService) private readonly scim: ScimService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get #base() {
    return `${this.env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/v1/scim/v2`;
  }

  #org(req: ScimRequest): string {
    if (!req.scimOrganization) throw new DiRouterError('unauthenticated');
    return req.scimOrganization;
  }

  @Get('ServiceProviderConfig')
  config(@Res() reply: FastifyReply) {
    return send(reply, 200, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description: 'An organization SCIM token from DiRouter',
          primary: true,
        },
      ],
    });
  }

  @Get('ResourceTypes')
  resourceTypes(@Res() reply: FastifyReply) {
    const type = (name: string, schema: string) => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: name,
      name,
      endpoint: `/${name}s`,
      schema,
    });
    const list = [type('User', SCHEMAS.user), type('Group', SCHEMAS.group)];
    return send(reply, 200, {
      schemas: [SCHEMAS.list],
      totalResults: list.length,
      startIndex: 1,
      itemsPerPage: list.length,
      Resources: list,
    });
  }

  @Get('Users')
  async listUsers(
    @Req() req: ScimRequest,
    @Query() query: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ) {
    return send(reply, 200, await this.scim.listUsers(this.#org(req), this.#base, query));
  }

  @Get('Users/:id')
  async getUser(@Req() req: ScimRequest, @Param('id') id: string, @Res() reply: FastifyReply) {
    const org = this.#org(req);
    return send(
      reply,
      200,
      this.scim.userResource(this.#base, await this.scim.loadUserForView(org, id)),
    );
  }

  @Post('Users')
  async createUser(@Req() req: ScimRequest, @Body() body: unknown, @Res() reply: FastifyReply) {
    const org = this.#org(req);
    const id = await this.scim.createUser(org, body);
    return send(
      reply,
      201,
      this.scim.userResource(this.#base, await this.scim.loadUserForView(org, id)),
    );
  }

  @Put('Users/:id')
  async replaceUser(
    @Req() req: ScimRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ) {
    const org = this.#org(req);
    await this.scim.updateUser(org, id, userInput(body));
    return send(
      reply,
      200,
      this.scim.userResource(this.#base, await this.scim.loadUserForView(org, id)),
    );
  }

  @Patch('Users/:id')
  async patchUser(
    @Req() req: ScimRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ) {
    const org = this.#org(req);
    await this.scim.updateUser(org, id, userPatch(body));
    return send(
      reply,
      200,
      this.scim.userResource(this.#base, await this.scim.loadUserForView(org, id)),
    );
  }

  @Delete('Users/:id')
  async deleteUser(@Req() req: ScimRequest, @Param('id') id: string, @Res() reply: FastifyReply) {
    await this.scim.deleteUser(this.#org(req), id);
    return send(reply, 204);
  }

  @Get('Groups')
  async listGroups(
    @Req() req: ScimRequest,
    @Query() query: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ) {
    return send(reply, 200, await this.scim.listGroups(this.#org(req), this.#base, query));
  }

  @Get('Groups/:id')
  async getGroup(@Req() req: ScimRequest, @Param('id') id: string, @Res() reply: FastifyReply) {
    const org = this.#org(req);
    return send(
      reply,
      200,
      this.scim.groupResource(this.#base, await this.scim.loadGroupForView(org, id)),
    );
  }

  @Post('Groups')
  async createGroup(@Req() req: ScimRequest, @Body() body: unknown, @Res() reply: FastifyReply) {
    const org = this.#org(req);
    const id = await this.scim.createGroup(org, body);
    return send(
      reply,
      201,
      this.scim.groupResource(this.#base, await this.scim.loadGroupForView(org, id)),
    );
  }

  @Put('Groups/:id')
  async replaceGroup(
    @Req() req: ScimRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ) {
    const org = this.#org(req);
    await this.scim.replaceGroup(org, id, body);
    return send(
      reply,
      200,
      this.scim.groupResource(this.#base, await this.scim.loadGroupForView(org, id)),
    );
  }

  @Patch('Groups/:id')
  async patchGroup(
    @Req() req: ScimRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ) {
    const org = this.#org(req);
    await this.scim.patchGroup(org, id, body);
    return send(
      reply,
      200,
      this.scim.groupResource(this.#base, await this.scim.loadGroupForView(org, id)),
    );
  }

  @Delete('Groups/:id')
  async deleteGroup(@Req() req: ScimRequest, @Param('id') id: string, @Res() reply: FastifyReply) {
    await this.scim.deleteGroup(this.#org(req), id);
    return send(reply, 204);
  }
}

const TokenBody = z.object({ name: z.string().trim().min(1).max(100) });
const TokenView = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
const CreatedToken = z.object({ id: z.string(), name: z.string(), token: z.string() });

/** SCIM tokens decide who belongs to the organization, so only owners create or revoke them. */
function ownerOnly(org: OrgContext): void {
  if (org.role !== 'OWNER')
    throw new ForbiddenError('forbidden', {
      message: 'Only an organization owner can manage SCIM tokens',
    });
}

@ApiTags('security')
@ApiBearerAuth()
@Controller('orgs/:orgId/scim/tokens')
@UseGuards(AccessGuard, OrgGuard)
export class ScimTokensController {
  constructor(@Inject(ScimService) private readonly scim: ScimService) {}

  @Get()
  @RequirePermission('security:write')
  @ApiZodOk(z.array(TokenView))
  list(@Org() org: OrgContext) {
    return this.scim.listTokens(org.organizationId);
  }

  /** The token is returned only here, once. */
  @Post()
  @RequirePermission('security:write')
  @ApiZodBody(TokenBody)
  @ApiZodOk(CreatedToken)
  create(@Org() org: OrgContext, @Body(new ZodPipe(TokenBody)) body: z.infer<typeof TokenBody>) {
    ownerOnly(org);
    return this.scim.createToken(org.organizationId, org.userId, body.name);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('security:write')
  async revoke(@Org() org: OrgContext, @Param('id') id: string) {
    ownerOnly(org);
    await this.scim.revokeToken(org.organizationId, org.userId, id);
  }
}
