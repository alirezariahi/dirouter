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
import { ApiZodBody, ApiZodOk, JsonListSchema, JsonObjectSchema, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { AgentProfilesService } from './agent-profiles.service.js';
import { AGENT_TOOLS } from './templates.js';

const ModelName = z.string().trim().min(1).max(128);
export const ProfileBody = z.object({
  name: z.string().trim().min(1).max(60),
  tool: z.enum(AGENT_TOOLS),
  mainModel: ModelName,
  /** Model for background tasks (titles, summaries); the main model when absent. */
  fastModel: ModelName.optional(),
  options: z.object({ disableNonessentialTraffic: z.boolean().optional() }).optional(),
});
const ProfilePatch = ProfileBody.partial().refine((v) => Object.keys(v).length > 0, 'empty patch');
const SetupBody = z.object({
  projectId: z.string().min(1),
  expiresAt: z.iso.datetime().optional(),
});
const Files = z.object({
  files: z.array(
    z.object({
      name: z.string(),
      content: z.string(),
      description: z.string(),
      launcher: z.string().optional(),
    }),
  ),
  script: z.string(),
});

@ApiTags('agent-profiles')
@ApiBearerAuth()
@Controller('orgs/:orgId/agent-profiles')
@UseGuards(AccessGuard, OrgGuard)
export class AgentProfilesController {
  constructor(@Inject(AgentProfilesService) private readonly profiles: AgentProfilesService) {}

  @Get()
  @RequirePermission('keys:read')
  @ApiZodOk(JsonListSchema)
  list(@Org() org: OrgContext) {
    return this.profiles.list(org);
  }

  @Post()
  @RequirePermission('keys:write')
  @ApiZodBody(ProfileBody)
  @ApiZodOk(JsonObjectSchema)
  create(
    @Org() org: OrgContext,
    @Body(new ZodPipe(ProfileBody)) body: z.infer<typeof ProfileBody>,
  ) {
    return this.profiles.create(org, body);
  }

  @Patch(':id')
  @RequirePermission('keys:write')
  @ApiZodBody(ProfilePatch)
  @ApiZodOk(JsonObjectSchema)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ProfilePatch)) body: z.infer<typeof ProfilePatch>,
  ) {
    return this.profiles.update(org, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('keys:write')
  @ApiNoContentResponse()
  async remove(@Org() org: OrgContext, @Param('id') id: string) {
    await this.profiles.remove(org, id);
  }

  @Get(':id/preview')
  @RequirePermission('keys:read')
  @ApiZodOk(Files)
  preview(@Org() org: OrgContext, @Param('id') id: string) {
    return this.profiles.preview(org, id);
  }

  /** Creates a dedicated key and returns the files with it; the key is shown only here. */
  @Post(':id/setup')
  @RequirePermission('keys:write')
  @ApiZodBody(SetupBody)
  @ApiZodOk(Files.extend({ keyId: z.string(), key: z.string() }))
  setup(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(SetupBody)) body: z.infer<typeof SetupBody>,
  ) {
    return this.profiles.setup(org, id, body);
  }
}
