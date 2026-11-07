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
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { PROVIDER_TYPES, ProvidersService } from './providers.service.js';

const ProxyUrl = z
  .string()
  .regex(/^(https?|socks5h?):\/\/[^\s]+$/, 'proxy must be http(s):// or socks5(h)://')
  .max(512);
const Timeouts = z.object({
  connectMs: z.int().positive().max(120_000).optional(),
  firstByteMs: z.int().positive().max(900_000).optional(),
  idleMs: z.int().positive().max(900_000).optional(),
  totalMs: z.int().positive().max(3_600_000).optional(),
});
const Headers = z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(1024));
export const CredentialBody = z.object({
  name: z.string().trim().min(1).max(100),
  secret: z.string().min(1).max(8192),
  weight: z.int().min(0).max(1000).optional(),
  headers: Headers.optional(),
  proxyUrl: ProxyUrl.nullable().optional(),
});
export const CredentialPatch = CredentialBody.partial().extend({
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});
export const ProviderBody = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .optional(),
  type: z.enum(PROVIDER_TYPES),
  baseUrl: z.url().max(512).optional(),
  enabled: z.boolean().optional(),
  proxyUrl: ProxyUrl.nullable().optional(),
  timeouts: Timeouts.nullable().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  maxConcurrency: z.int().positive().max(10_000).nullable().optional(),
  credentials: z.array(CredentialBody).max(50).optional(),
});
export const ProviderPatch = ProviderBody.omit({ credentials: true, type: true }).partial();
const TestBody = z.object({ credentialId: z.string().optional() }).optional();

const CredentialView = z.object({
  id: z.string(),
  name: z.string(),
  secret: z.string().describe('فقط ••••last4؛ secret واقعی هرگز برنمی‌گردد'),
  weight: z.int(),
  status: z.enum(['ACTIVE', 'DISABLED']),
  cooldownUntil: z.string().nullable(),
  headers: z.array(z.string()).describe('فقط نام هدرها'),
  proxyUrl: z.string().nullable(),
});
const ProviderView = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: z.enum([...PROVIDER_TYPES, 'mock']),
  baseUrl: z.string(),
  enabled: z.boolean(),
  proxyUrl: z.string().nullable(),
  timeouts: Timeouts.nullable(),
  options: z.record(z.string(), z.unknown()),
  maxConcurrency: z.int().nullable(),
  credentials: z.array(CredentialView),
  createdAt: z.string(),
});
const TestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.int(),
  status: z.int().optional(),
  error: z.object({ class: z.string(), message: z.string() }).optional(),
  modelCount: z.int(),
});
const DiscoverResult = z.object({
  ok: z.boolean(),
  latencyMs: z.int(),
  error: z.object({ class: z.string(), message: z.string() }).optional(),
  models: z.array(
    z.object({
      upstreamModel: z.string(),
      inCatalog: z.boolean(),
      suggested: z.boolean(),
      catalog: z
        .object({ key: z.string(), contextWindow: z.int().optional(), pricing: z.unknown() })
        .optional(),
    }),
  ),
});

@ApiTags('providers')
@ApiBearerAuth()
@Controller('orgs/:orgId/providers')
@UseGuards(AccessGuard, OrgGuard)
export class ProvidersController {
  constructor(@Inject(ProvidersService) private readonly providers: ProvidersService) {}

  @Get()
  @RequirePermission('providers:read')
  @ApiZodOk(z.array(ProviderView))
  list(@Org() org: OrgContext) {
    return this.providers.list(org);
  }

  @Post()
  @RequirePermission('providers:write')
  @ApiZodBody(ProviderBody)
  @ApiZodOk(ProviderView)
  create(
    @Org() org: OrgContext,
    @Body(new ZodPipe(ProviderBody)) body: z.infer<typeof ProviderBody>,
  ) {
    return this.providers.create(org, body);
  }

  @Get(':id')
  @RequirePermission('providers:read')
  @ApiZodOk(ProviderView)
  async get(@Org() org: OrgContext, @Param('id') id: string) {
    return this.providers.view(await this.providers.load(org, id));
  }

  @Patch(':id')
  @RequirePermission('providers:write')
  @ApiZodBody(ProviderPatch)
  @ApiZodOk(ProviderView)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ProviderPatch)) body: z.infer<typeof ProviderPatch>,
  ) {
    return this.providers.update(org, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('providers:write')
  @ApiNoContentResponse()
  async remove(@Org() org: OrgContext, @Param('id') id: string) {
    await this.providers.remove(org, id);
  }

  @Post(':id/credentials')
  @RequirePermission('providers:write')
  @ApiZodBody(CredentialBody)
  @ApiZodOk(ProviderView)
  addCredential(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(CredentialBody)) body: z.infer<typeof CredentialBody>,
  ) {
    return this.providers.addCredential(org, id, body);
  }

  @Patch(':id/credentials/:credentialId')
  @RequirePermission('providers:write')
  @ApiZodBody(CredentialPatch)
  @ApiZodOk(ProviderView, 'با secret تازه، کلید چرخانده می‌شود')
  updateCredential(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Param('credentialId') credentialId: string,
    @Body(new ZodPipe(CredentialPatch)) body: z.infer<typeof CredentialPatch>,
  ) {
    return this.providers.updateCredential(org, id, credentialId, body);
  }

  @Delete(':id/credentials/:credentialId')
  @HttpCode(204)
  @RequirePermission('providers:write')
  @ApiNoContentResponse()
  async removeCredential(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Param('credentialId') credentialId: string,
  ) {
    await this.providers.removeCredential(org, id, credentialId);
  }

  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission('providers:write')
  @ApiZodBody(z.object({ credentialId: z.string().optional() }))
  @ApiZodOk(TestResult, 'نتیجه و latency تست اتصال (فراخوانی /models از گیت‌وی)')
  test(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(TestBody)) body: z.infer<typeof TestBody>,
  ) {
    return this.providers.test(org, id, body?.credentialId);
  }

  @Post(':id/discover')
  @HttpCode(200)
  @RequirePermission('providers:write')
  @ApiZodOk(DiscoverResult, 'مدل‌های upstream؛ مدل‌های تازه با suggested=true')
  discover(@Org() org: OrgContext, @Param('id') id: string) {
    return this.providers.discover(org, id);
  }
}
