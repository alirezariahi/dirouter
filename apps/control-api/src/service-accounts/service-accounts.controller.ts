/** Service accounts and management tokens (card 23.6); people only, never with a token. */
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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { parseIpRule } from '../auth/management-token.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { HumanOnly, Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { ServiceAccountsService } from './service-accounts.service.js';

const AccountRole = z.enum(['ADMIN', 'MEMBER', 'VIEWER']);
const Name = z.string().trim().min(1).max(100);

export const CreateServiceAccountBody = z.object({
  name: Name,
  description: z.string().trim().max(500).optional(),
  role: AccountRole,
  customRoleId: z.string().max(64).nullable().optional(),
});
export const UpdateServiceAccountBody = z
  .object({
    name: Name.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    role: AccountRole.optional(),
    customRoleId: z.string().max(64).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change');
export const CreateTokenBody = z.object({
  name: Name,
  /** Permissions of the RBAC matrix (docs/rbac.md); `*:read` only makes a read-only token. */
  scopes: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
  /** Days until the token expires; null means it never expires. */
  expiresInDays: z.int().min(1).max(730).nullable().default(90),
  /** Addresses or CIDR ranges; empty allows every address. */
  allowedIps: z
    .array(
      z
        .string()
        .trim()
        .max(64)
        .refine((value) => parseIpRule(value) !== undefined, 'Not an IP address or CIDR range'),
    )
    .max(50)
    .default([]),
});

export const TokenView = z.object({
  id: z.string(),
  serviceAccountId: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  allowedIps: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  lastUsedIp: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
const ServiceAccountView = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']),
  customRoleId: z.string().nullable(),
  /** Effective permissions (role plus custom role): the scopes its tokens may have. */
  permissions: z.array(z.string()),
  createdAt: z.string(),
  tokens: z.array(TokenView),
});

@ApiTags('security')
@ApiBearerAuth()
@Controller('orgs/:orgId')
@UseGuards(AccessGuard, OrgGuard)
@HumanOnly()
export class ServiceAccountsController {
  constructor(@Inject(ServiceAccountsService) private readonly service: ServiceAccountsService) {}

  @Get('service-accounts')
  @RequirePermission('members:read')
  @ApiZodOk(
    z.array(ServiceAccountView),
    'Service accounts with their tokens (without the token values)',
  )
  list(@Org() org: OrgContext) {
    return this.service.list(org);
  }

  @Post('service-accounts')
  @RequirePermission('security:write')
  @ApiZodBody(CreateServiceAccountBody)
  @ApiZodOk(ServiceAccountView)
  create(
    @Org() org: OrgContext,
    @Body(new ZodPipe(CreateServiceAccountBody)) body: z.infer<typeof CreateServiceAccountBody>,
  ) {
    return this.service.create(org, body);
  }

  @Patch('service-accounts/:id')
  @RequirePermission('security:write')
  @ApiZodBody(UpdateServiceAccountBody)
  @ApiZodOk(ServiceAccountView)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateServiceAccountBody)) body: z.infer<typeof UpdateServiceAccountBody>,
  ) {
    return this.service.update(org, id, body);
  }

  @Delete('service-accounts/:id')
  @HttpCode(204)
  @RequirePermission('security:write')
  @ApiNoContentResponse({ description: 'Deleted and all its tokens revoked' })
  async remove(@Org() org: OrgContext, @Param('id') id: string) {
    await this.service.remove(org, id);
  }

  /** The token is returned only here, once. */
  @Post('service-accounts/:id/tokens')
  @RequirePermission('security:write')
  @ApiZodBody(CreateTokenBody)
  @ApiZodOk(TokenView.extend({ token: z.string() }), 'The token is returned only this once')
  createToken(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(CreateTokenBody)) body: z.infer<typeof CreateTokenBody>,
  ) {
    return this.service.createToken(org, id, body);
  }

  @Delete('management-tokens/:id')
  @HttpCode(204)
  @RequirePermission('security:write')
  @ApiNoContentResponse({ description: 'Token revoked; its next request is rejected' })
  async revokeToken(@Org() org: OrgContext, @Param('id') id: string) {
    await this.service.revokeToken(org, id);
  }
}
