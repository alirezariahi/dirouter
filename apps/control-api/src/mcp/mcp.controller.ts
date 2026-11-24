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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
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
import { McpService } from './mcp.service.js';

const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const McpServerFields = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'lowercase letters, digits and dashes'),
  /** `a2a`: an external A2A agent (card 20.3), proxied at /a2a/agents/<slug>. */
  transport: z.enum(['streamable-http', 'sse', 'a2a']),
  url: z.url().max(1000),
  headers: z.record(HeaderName, z.string().max(4096)).nullable().optional(),
  enabled: z.boolean().optional(),
  forwardIdentity: z.boolean().optional(),
  timeoutMs: z.int().min(1_000).max(300_000).optional(),
});
export const McpServerBody = McpServerFields.extend({
  transport: McpServerFields.shape.transport.default('streamable-http'),
});
// No defaults in a patch: an omitted field must stay as it is.
const McpServerPatch = McpServerFields.partial().refine(
  (v) => Object.keys(v).length > 0,
  'empty patch',
);
const McpTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.int(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
  agentName: z.string().optional(),
  error: z.string().optional(),
});
const CallsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  serverId: z.string().optional(),
  apiKeyId: z.string().optional(),
  status: z.enum(['success', 'error', 'denied']).optional(),
});

@ApiTags('mcp')
@ApiBearerAuth()
@Controller('orgs/:orgId/mcp')
@UseGuards(AccessGuard, OrgGuard)
export class McpController {
  constructor(@Inject(McpService) private readonly mcp: McpService) {}

  @Get('servers')
  @RequirePermission('mcp:read')
  @ApiZodOk(JsonListSchema)
  list(@Org() org: OrgContext) {
    return this.mcp.list(org);
  }

  @Post('servers')
  @RequirePermission('mcp:write')
  @ApiZodBody(McpServerBody)
  @ApiZodOk(JsonObjectSchema)
  create(
    @Org() org: OrgContext,
    @Body(new ZodPipe(McpServerBody)) body: z.infer<typeof McpServerBody>,
  ) {
    return this.mcp.create(org, body);
  }

  @Get('servers/:id')
  @RequirePermission('mcp:read')
  @ApiZodOk(JsonObjectSchema)
  get(@Org() org: OrgContext, @Param('id') id: string) {
    return this.mcp.get(org, id);
  }

  @Patch('servers/:id')
  @RequirePermission('mcp:write')
  @ApiZodBody(McpServerPatch)
  @ApiZodOk(JsonObjectSchema)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(McpServerPatch)) body: z.infer<typeof McpServerPatch>,
  ) {
    return this.mcp.update(org, id, body);
  }

  @Delete('servers/:id')
  @HttpCode(204)
  @RequirePermission('mcp:write')
  @ApiNoContentResponse()
  async remove(@Org() org: OrgContext, @Param('id') id: string) {
    await this.mcp.remove(org, id);
  }

  @Post('servers/:id/test')
  @HttpCode(200)
  @RequirePermission('mcp:write')
  @ApiZodOk(McpTestResult, 'Connection test: latency and the tools (A2A: skills) the server offers')
  test(@Org() org: OrgContext, @Param('id') id: string) {
    return this.mcp.test(org, id);
  }

  @Get('calls')
  @RequirePermission('mcp:read')
  @ApiZodQuery(CallsQuery)
  @ApiZodOk(JsonListSchema)
  calls(@Org() org: OrgContext, @Query(new ZodPipe(CallsQuery)) q: z.infer<typeof CallsQuery>) {
    return this.mcp.calls(org, q);
  }
}
