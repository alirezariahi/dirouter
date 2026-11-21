import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
import { ConfigService } from './config.service.js';

const DiffQuery = z.object({
  against: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('defaults to the previous version'),
});
const RollbackBody = z.object({ reason: z.string().max(500).default('manual rollback') });
const ImportBody = z.object({
  yaml: z.string().min(2).max(5_000_000),
  reason: z.string().max(500).default('yaml import'),
});

/** Shape is validated against GatewaySettings in the service so the error lists every bad field. */
const SettingsBody = z.record(z.string(), z.unknown());

/**
 * Config routes are per organization although the snapshot is instance-wide: reads return the
 * caller organization's slice without secrets, and writes are restricted in the service
 * (OWNER for instance-wide effects; see config.service.ts).
 */
@ApiTags('config')
@ApiBearerAuth()
@Controller('orgs/:orgId/config')
@UseGuards(AccessGuard, OrgGuard)
export class ConfigController {
  constructor(@Inject(ConfigService) private readonly service: ConfigService) {}

  @Get('versions')
  @RequirePermission('config:read')
  @ApiZodOk(JsonListSchema)
  list(@Org() _org: OrgContext) {
    return this.service.list();
  }

  @Get('versions/:version')
  @RequirePermission('config:read')
  @ApiZodOk(JsonObjectSchema)
  get(@Org() org: OrgContext, @Param('version') version: string) {
    return this.service.get(org, Number(version));
  }

  @Get('versions/:version/diff')
  @RequirePermission('config:read')
  @ApiZodQuery(DiffQuery)
  @ApiZodOk(JsonObjectSchema)
  diff(
    @Org() org: OrgContext,
    @Param('version') version: string,
    @Query(new ZodPipe(DiffQuery)) q: z.infer<typeof DiffQuery>,
  ) {
    const to = Number(version);
    return this.service.diff(org, q.against ?? Math.max(1, to - 1), to);
  }

  @Post('versions/:version/rollback')
  @HttpCode(200)
  @RequirePermission('config:write')
  @ApiZodBody(RollbackBody)
  @ApiZodOk(z.object({ version: z.int(), rolledBackTo: z.int() }))
  rollback(
    @Org() org: OrgContext,
    @Param('version') version: string,
    @Body(new ZodPipe(RollbackBody)) body: z.infer<typeof RollbackBody>,
  ) {
    return this.service.rollback(org, Number(version), body.reason);
  }

  @Get('settings')
  @RequirePermission('config:read')
  @ApiZodOk(JsonObjectSchema)
  getSettings(@Org() _org: OrgContext) {
    return this.service.getSettings();
  }

  @Put('settings')
  @RequirePermission('config:write')
  @ApiZodBody(SettingsBody)
  @ApiZodOk(JsonObjectSchema)
  putSettings(
    @Org() org: OrgContext,
    @Body(new ZodPipe(SettingsBody)) body: Record<string, unknown>,
  ) {
    return this.service.putSettings(org, body);
  }

  @Get('export.yaml')
  @RequirePermission('config:read')
  @ApiZodOk(z.object({ version: z.int(), yaml: z.string() }))
  exportYaml(@Org() org: OrgContext) {
    return this.service.exportYaml(org);
  }

  @Post('import.yaml')
  @HttpCode(200)
  @RequirePermission('config:write')
  @ApiZodBody(ImportBody)
  @ApiZodOk(z.object({ version: z.int() }))
  importYaml(
    @Org() org: OrgContext,
    @Body(new ZodPipe(ImportBody)) body: z.infer<typeof ImportBody>,
  ) {
    return this.service.importYaml(org, body.yaml, body.reason);
  }
}
