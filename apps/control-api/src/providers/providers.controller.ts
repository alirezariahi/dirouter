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
  Res,
  UseGuards,
} from '@nestjs/common';
import { ProviderDataPolicy } from '@dirouter/contracts';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { PROVIDER_TYPES, ProvidersService } from './providers.service.js';
import { ChangeRequestsService } from '../change-requests/change-requests.service.js';
import { sendGated } from '../change-requests/gated.js';
import type { FastifyReply } from 'fastify';

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
/** One pass-through allow-list entry (card 30.7): `[METHOD ]/path`, a trailing `*` matches the rest. */
const PASSTHROUGH_PATH = /^(?:(GET|POST|PUT|PATCH|DELETE) )?(\/[\x21-\x7e]*)$/;
const ProviderOptions = z.record(z.string(), z.unknown()).superRefine((options, ctx) => {
  const paths = options.passthroughPaths;
  if (paths === undefined) return;
  if (
    !Array.isArray(paths) ||
    paths.length > 100 ||
    paths.some((p) => typeof p !== 'string' || p.length > 512 || !PASSTHROUGH_PATH.test(p))
  )
    ctx.addIssue({
      code: 'custom',
      path: ['passthroughPaths'],
      message: 'passthroughPaths must be at most 100 entries like "POST /files" or "/batches/*"',
    });
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
  options: ProviderOptions.optional(),
  maxConcurrency: z.int().positive().max(10_000).nullable().optional(),
  /** Region, country, retention and training use (card 32.5); `null` clears it. */
  dataPolicy: ProviderDataPolicy.nullable().optional(),
  credentials: z.array(CredentialBody).max(50).optional(),
  /** Required when the provider uses a plugin with a terms warning (card 21.2). */
  acceptTerms: z.boolean().optional(),
});
const PluginView = z.object({
  name: z.string(),
  status: z.enum(['available', 'loaded', 'failed']),
  error: z.string().optional(),
  displayName: z.string().optional(),
  version: z.string().optional(),
  description: z.string().nullable().optional(),
  defaultBaseUrl: z.string().nullable().optional(),
  termsWarning: z.object({ text: z.string(), url: z.string().optional() }).nullable().optional(),
});
export const ProviderPatch = ProviderBody.omit({ credentials: true, type: true }).partial();
const TestBody = z.object({ credentialId: z.string().optional() }).optional();

/** Latest upstream balance of a credential (card 32.9). */
const BalanceView = z.object({
  kind: z.string(),
  ok: z.boolean(),
  amount: z.string().nullable().describe('the last known amount, also after a failed lookup'),
  currency: z.string().nullable(),
  error: z.string().nullable(),
  checkedAt: z.string(),
});
const CredentialView = z.object({
  id: z.string(),
  name: z.string(),
  secret: z.string().describe('فقط ••••last4؛ secret واقعی هرگز برنمی‌گردد'),
  balance: BalanceView.nullable(),
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
  dataPolicy: ProviderDataPolicy.nullable(),
  /** openrouter | deepseek | moonshot | siliconflow when the provider has a balance API. */
  balanceKind: z.string().nullable(),
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
  constructor(
    @Inject(ProvidersService) private readonly providers: ProvidersService,
    @Inject(ChangeRequestsService) private readonly changes: ChangeRequestsService,
  ) {
    // Deleting a provider is sensitive (card 22.2): with four-eyes on, it waits for approval.
    changes.register<{ providerId: string }>('provider.delete', {
      permission: 'providers:write',
      targetId: (p) => p.providerId,
      describe: async (ctx, p) =>
        `Delete provider ${(await this.providers.load(ctx, p.providerId)).name}`,
      apply: (ctx, p) => this.providers.remove(ctx, p.providerId),
    });
  }

  @Get()
  @RequirePermission('providers:read')
  @ApiZodOk(z.array(ProviderView))
  list(@Org() org: OrgContext) {
    return this.providers.list(org);
  }

  /** Plugins enabled on this server, with any terms warning to show before use (card 21.2). */
  @Get('plugins')
  @RequirePermission('providers:read')
  @ApiZodOk(z.array(PluginView))
  plugins() {
    return this.providers.plugins();
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
  async remove(@Org() org: OrgContext, @Param('id') id: string, @Res() reply: FastifyReply) {
    await this.providers.load(org, id);
    const gate = await this.changes.gate(org, 'provider.delete', { providerId: id });
    return sendGated(reply, gate, () => this.providers.remove(org, id), 204);
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

  @Post(':id/balance')
  @HttpCode(200)
  @RequirePermission('providers:write')
  @ApiZodOk(
    ProviderView,
    'موجودی حساب upstream هر credential همین حالا از provider خوانده و ذخیره می‌شود',
  )
  refreshBalance(@Org() org: OrgContext, @Param('id') id: string) {
    return this.providers.refreshBalance(org, id);
  }

  @Post(':id/discover')
  @HttpCode(200)
  @RequirePermission('providers:write')
  @ApiZodOk(DiscoverResult, 'مدل‌های upstream؛ مدل‌های تازه با suggested=true')
  discover(@Org() org: OrgContext, @Param('id') id: string) {
    return this.providers.discover(org, id);
  }
}
