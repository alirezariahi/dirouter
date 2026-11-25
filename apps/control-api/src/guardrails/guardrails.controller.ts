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
import { ApiZodBody, ApiZodOk, JsonObjectSchema, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { GuardrailsService, previewGuardrail } from './guardrails.service.js';

const Type = z.enum([
  'regex',
  'keyword',
  'pii',
  'secret',
  'json_schema',
  'max_input_tokens',
  'prompt_injection',
  'moderation',
]);
export const GuardrailBody = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
  stage: z.enum(['request', 'response', 'both']).optional(),
  type: Type,
  action: z.enum(['block', 'redact', 'flag']).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  message: z.string().max(500).optional(),
  virtualKeyId: z.string().optional(),
  projectId: z.string().optional(),
});
const GuardrailPatch = GuardrailBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  'at least one field is required',
);
/** Preview input is bounded: the pattern is capped in regex-safety.ts and the text here. */
const TestBody = GuardrailBody.pick({ type: true, config: true, action: true }).extend({
  text: z.string().max(10_000),
});

@ApiTags('guardrails')
@ApiBearerAuth()
@Controller('orgs/:orgId/guardrails')
@UseGuards(AccessGuard, OrgGuard)
export class GuardrailsController {
  constructor(@Inject(GuardrailsService) private readonly service: GuardrailsService) {}

  @Get()
  @RequirePermission('guardrails:read')
  @ApiZodOk(z.array(z.record(z.string(), z.unknown())))
  list(@Org() org: OrgContext) {
    return this.service.list(org);
  }

  @Post()
  @RequirePermission('guardrails:write')
  @ApiZodBody(GuardrailBody)
  @ApiZodOk(JsonObjectSchema)
  create(
    @Org() org: OrgContext,
    @Body(new ZodPipe(GuardrailBody)) body: z.infer<typeof GuardrailBody>,
  ) {
    return this.service.create(org, body);
  }

  @Patch(':id')
  @RequirePermission('guardrails:write')
  @ApiZodBody(GuardrailPatch)
  @ApiZodOk(JsonObjectSchema)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(GuardrailPatch)) body: z.infer<typeof GuardrailPatch>,
  ) {
    return this.service.update(org, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('guardrails:write')
  @ApiNoContentResponse()
  async remove(@Org() org: OrgContext, @Param('id') id: string) {
    await this.service.remove(org, id);
  }

  /**
   * Live preview before saving (card 15.2); no policy is persisted. It executes a caller-supplied
   * pattern on the server, so it needs the same permission as saving a policy.
   */
  @Post('test')
  @HttpCode(200)
  @RequirePermission('guardrails:write')
  @ApiZodBody(TestBody)
  @ApiZodOk(JsonObjectSchema)
  test(@Body(new ZodPipe(TestBody)) body: z.infer<typeof TestBody>) {
    return previewGuardrail(
      {
        name: 'preview',
        type: body.type,
        config: body.config,
        ...(body.action ? { action: body.action } : {}),
      },
      body.text,
    );
  }
}
