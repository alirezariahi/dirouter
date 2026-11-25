import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { RepairKind } from '@dirouter/contracts';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ApiZodQuery, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { KeysService } from './keys.service.js';
import { ChangeRequestsService } from '../change-requests/change-requests.service.js';
import { sendGated } from '../change-requests/gated.js';
import type { FastifyReply } from 'fastify';
import { BUDGET_PERIODS } from '../limits/periods.js';

const Budget = z.object({
  period: z.enum(BUDGET_PERIODS),
  limitUsd: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,8})?$/)
    .optional(),
  limitTokens: z.int().positive().optional(),
  alertThresholds: z.array(z.int().min(1).max(100)).max(10).optional(),
});
export const KeyBody = z.object({
  name: z.string().trim().min(1).max(100),
  projectId: z.string().min(1),
  allowedModels: z.array(z.string().min(1).max(128)).max(200).optional(),
  /** MCP tools (card 20.1): `server__tool`, `server__*` or `*`; empty = every tool. */
  mcpTools: z
    .array(z.string().regex(/^(\*|[a-z0-9][a-z0-9-]{0,40}__(\*|[A-Za-z0-9_.-]{1,128}))$/))
    .max(200)
    .optional(),
  ipAllowlist: z.array(z.string().max(64)).max(100).optional(),
  /** Gateway repairs (card 31.1): `json` answers and `tools` histories; empty = none. */
  repair: z.array(RepairKind).max(2).optional(),
  /**
   * Native pass-through (card 30.7): provider slugs (or `*`) this key may call through
   * /passthrough/{provider}/*; empty (the default) keeps pass-through off.
   */
  passthroughProviders: z
    .array(z.string().regex(/^(\*|[a-z0-9][a-z0-9-]{0,62})$/))
    .max(100)
    .optional(),
  /** DiRouter's admin MCP server (card 20.2); only owners and admins may grant read or write. */
  mcpAdmin: z.enum(['none', 'read', 'write']).optional(),
  rpm: z.int().positive().nullable().optional(),
  tpm: z.int().positive().nullable().optional(),
  maxConcurrency: z.int().positive().nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  budgets: z.array(Budget).max(4).optional(),
});
export const KeyPatch = KeyBody.omit({ projectId: true }).partial();
export const RotateBody = z.object({
  graceSeconds: z
    .int()
    .min(0)
    .max(30 * 24 * 3600)
    .default(24 * 3600),
});
const ListQuery = z.object({ projectId: z.string().optional() });

const KeyView = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  projectId: z.string(),
  state: z.enum(['active', 'rotating', 'expired', 'revoked']),
  allowedModels: z.array(z.string()),
  mcpTools: z.array(z.string()),
  passthroughProviders: z.array(z.string()),
  mcpAdmin: z.enum(['none', 'read', 'write']),
  ipAllowlist: z.array(z.string()),
  repair: z.array(RepairKind),
  rpm: z.int().nullable(),
  tpm: z.int().nullable(),
  maxConcurrency: z.int().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  rotatedToId: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  budgets: z.array(
    z.object({
      id: z.string(),
      period: z.enum(BUDGET_PERIODS),
      limitUsd: z.string().nullable(),
      limitTokens: z.int().nullable(),
      alertThresholds: z.array(z.int()),
    }),
  ),
});
const WithSecret = KeyView.extend({ key: z.string().describe('The full key; returned only once') });

@ApiTags('virtual keys')
@ApiBearerAuth()
@Controller('orgs/:orgId/keys')
@UseGuards(AccessGuard, OrgGuard)
export class KeysController {
  constructor(
    @Inject(KeysService) private readonly keys: KeysService,
    @Inject(ChangeRequestsService) private readonly changes: ChangeRequestsService,
  ) {
    // Budget changes are sensitive (card 22.2); the whole patch waits for approval with them.
    changes.register<{ keyId: string; patch: z.infer<typeof KeyPatch> }>('key.budgets', {
      permission: 'keys:write',
      targetId: (p) => p.keyId,
      describe: async (ctx, p) =>
        `Change the budgets of key ${(await this.keys.get(ctx, p.keyId)).name}`,
      apply: (ctx, p) => this.keys.update(ctx, p.keyId, p.patch),
    });
  }

  @Get()
  @RequirePermission('keys:read')
  @ApiZodQuery(ListQuery)
  @ApiZodOk(z.array(KeyView))
  list(@Org() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.keys.list(org, q.projectId);
  }

  @Post()
  @RequirePermission('keys:write')
  @ApiZodBody(KeyBody)
  @ApiZodOk(WithSecret, 'The full key appears only in this response')
  create(@Org() org: OrgContext, @Body(new ZodPipe(KeyBody)) body: z.infer<typeof KeyBody>) {
    return this.keys.create(org, body);
  }

  @Get(':id')
  @RequirePermission('keys:read')
  @ApiZodOk(KeyView)
  get(@Org() org: OrgContext, @Param('id') id: string) {
    return this.keys.get(org, id);
  }

  @Patch(':id')
  @RequirePermission('keys:write')
  @ApiZodBody(KeyPatch)
  @ApiZodOk(KeyView)
  async update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(KeyPatch)) body: z.infer<typeof KeyPatch>,
    @Res() reply: FastifyReply,
  ) {
    await this.keys.get(org, id);
    const gate =
      body.budgets !== undefined
        ? await this.changes.gate(org, 'key.budgets', { keyId: id, patch: body })
        : {};
    return sendGated(reply, gate, () => this.keys.update(org, id, body));
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermission('keys:write')
  @ApiZodOk(KeyView)
  revoke(@Org() org: OrgContext, @Param('id') id: string) {
    return this.keys.revoke(org, id);
  }

  @Post(':id/rotate')
  @RequirePermission('keys:write')
  @ApiZodBody(RotateBody)
  @ApiZodOk(
    WithSecret.extend({ previous: KeyView }),
    'The old key stays valid until the grace period ends',
  )
  rotate(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(RotateBody)) body: z.infer<typeof RotateBody>,
  ) {
    return this.keys.rotate(org, id, body.graceSeconds);
  }
}
