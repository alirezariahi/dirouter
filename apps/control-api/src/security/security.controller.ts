import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import {
  ApiZodBody,
  ApiZodOk,
  ApiZodQuery,
  JsonListSchema,
  JsonObjectSchema,
  ZodPipe,
} from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { SecurityService } from './security.service.js';

const RoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
const PermissionSchema = z.enum(PERMISSIONS);
export const CustomRoleBody = z.object({
  name: z.string().trim().min(1).max(60),
  permissions: z.array(PermissionSchema).max(PERMISSIONS.length),
});
const CustomRolePatch = CustomRoleBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  'at least one field is required',
);
export const SecurityPatch = z.object({
  mfaRequiredRoles: z.array(RoleSchema).max(4).optional(),
  passwordLoginDisabled: z.boolean().optional(),
});
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  actorUserId: z.string().optional(),
  action: z.string().max(100).optional(),
  targetType: z.string().max(60).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(200).optional(),
});
const CsvQuery = AuditQuery.omit({ limit: true, cursor: true });

function filters(q: z.infer<typeof AuditQuery>) {
  return {
    ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.targetType ? { targetType: q.targetType } : {}),
    ...(q.from ? { from: new Date(q.from) } : {}),
    ...(q.to ? { to: new Date(q.to) } : {}),
  };
}

@ApiTags('security')
@ApiBearerAuth()
@Controller('orgs/:orgId')
@UseGuards(AccessGuard, OrgGuard)
export class SecurityController {
  constructor(@Inject(SecurityService) private readonly service: SecurityService) {}

  @Get('custom-roles')
  @RequirePermission('members:read')
  @ApiZodOk(JsonListSchema)
  roles(@Org() org: OrgContext) {
    return this.service.listRoles(org);
  }

  @Post('custom-roles')
  @RequirePermission('security:write')
  @ApiZodBody(CustomRoleBody)
  @ApiZodOk(JsonObjectSchema)
  createRole(
    @Org() org: OrgContext,
    @Body(new ZodPipe(CustomRoleBody)) body: z.infer<typeof CustomRoleBody>,
  ) {
    return this.service.createRole(org, body);
  }

  @Patch('custom-roles/:id')
  @RequirePermission('security:write')
  @ApiZodBody(CustomRolePatch)
  @ApiZodOk(JsonObjectSchema)
  updateRole(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(CustomRolePatch)) body: z.infer<typeof CustomRolePatch>,
  ) {
    return this.service.updateRole(org, id, body);
  }

  @Delete('custom-roles/:id')
  @HttpCode(204)
  @RequirePermission('security:write')
  @ApiNoContentResponse()
  async removeRole(@Org() org: OrgContext, @Param('id') id: string) {
    await this.service.removeRole(org, id);
  }

  @Get('security')
  @RequirePermission('org:read')
  @ApiZodOk(JsonObjectSchema)
  settings(@Org() org: OrgContext) {
    return this.service.securitySettings(org);
  }

  @Patch('security')
  @RequirePermission('security:write')
  @ApiZodBody(SecurityPatch)
  @ApiZodOk(JsonObjectSchema)
  updateSettings(
    @Org() org: OrgContext,
    @Body(new ZodPipe(SecurityPatch)) body: z.infer<typeof SecurityPatch>,
  ) {
    return this.service.updateSecuritySettings(org, body);
  }

  @Post('security/rotate-key')
  @HttpCode(200)
  @RequirePermission('security:write')
  @ApiZodOk(
    z.object({
      keyVersion: z.int(),
      rotated: z.int(),
      credentials: z.int(),
      ssoConnections: z.int(),
      mfaSecrets: z.int(),
    }),
  )
  rotate(@Org() org: OrgContext) {
    return this.service.rotateMasterKey(org);
  }

  @Get('audit')
  @RequirePermission('audit:read')
  @ApiZodQuery(AuditQuery)
  @ApiZodOk(JsonObjectSchema)
  audit(@Org() org: OrgContext, @Query(new ZodPipe(AuditQuery)) q: z.infer<typeof AuditQuery>) {
    const cursor = q.cursor
      ? (() => {
          const [createdAt, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
          if (!createdAt || !id) return undefined;
          return { createdAt: new Date(createdAt), id };
        })()
      : undefined;
    return this.service.auditLog(org, filters(q), q.limit, cursor);
  }

  @Get('audit/export')
  @RequirePermission('audit:read')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="audit-log.csv"')
  @ApiZodOk(z.string(), 'CSV text')
  async export(
    @Org() org: OrgContext,
    @Query(new ZodPipe(CsvQuery)) q: z.infer<typeof CsvQuery>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.service.auditLogCsv(org, {
      ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.targetType ? { targetType: q.targetType } : {}),
      ...(q.from ? { from: new Date(q.from) } : {}),
      ...(q.to ? { to: new Date(q.to) } : {}),
    });
  }
}
