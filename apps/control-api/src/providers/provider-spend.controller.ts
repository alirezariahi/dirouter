import { Body, Controller, Get, Inject, Param, Put, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { QuotaWindowConfig } from '@dirouter/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ChangeRequestsService } from '../change-requests/change-requests.service.js';
import { sendGated } from '../change-requests/gated.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { BUDGET_PERIODS } from '../limits/periods.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import {
  CREDENTIAL_STRATEGIES,
  type CredentialSpendInput,
  type ProviderSpendInput,
  ProviderSpendService,
} from './provider-spend.service.js';

const Budget = z.object({
  period: z.enum(BUDGET_PERIODS),
  limitUsd: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,8})?$/)
    .optional(),
  limitTokens: z.int().positive().optional(),
  alertThresholds: z.array(z.int().min(1).max(100)).max(10).optional(),
});
export const ProviderSpendBody = z.object({
  credentialStrategy: z
    .enum(CREDENTIAL_STRATEGIES)
    .optional()
    .describe('weighted (random by weight), fill-first, or reset-aware'),
  /** Replaces every budget of the provider; absent keeps them. */
  budgets: z.array(Budget).max(4).optional(),
});
export const CredentialSpendBody = z.object({
  /** Replaces every budget of the credential; absent keeps them. */
  budgets: z.array(Budget).max(4).optional(),
  /** Replaces every quota window; absent keeps them. */
  quotaWindows: z.array(QuotaWindowConfig).max(5).optional(),
});
const BudgetView = z.object({
  id: z.string(),
  period: z.enum(BUDGET_PERIODS),
  limitUsd: z.string().nullable(),
  limitTokens: z.int().nullable(),
  alertThresholds: z.array(z.int()),
});
const SpendView = z.object({
  providerId: z.string(),
  credentialStrategy: z.enum(CREDENTIAL_STRATEGIES),
  budgets: z.array(BudgetView),
  credentials: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      budgets: z.array(BudgetView),
      quotaWindows: z.array(
        z.object({
          id: z.string(),
          hours: z.int(),
          limitRequests: z.int().optional(),
          limitTokens: z.int().optional(),
          limitUsd: z.string().optional(),
        }),
      ),
    }),
  ),
});

interface Payload {
  providerId: string;
  credentialId?: string;
  patch: ProviderSpendInput & CredentialSpendInput;
}

/** Budgets, quota windows and the credential strategy of an upstream provider (card 32.6). */
@ApiTags('providers')
@ApiBearerAuth()
@Controller('orgs/:orgId/providers/:id')
@UseGuards(AccessGuard, OrgGuard)
export class ProviderSpendController {
  constructor(
    @Inject(ProviderSpendService) private readonly spend: ProviderSpendService,
    @Inject(ChangeRequestsService) private readonly changes: ChangeRequestsService,
  ) {
    // Budget changes wait for a second person when the organization asks for it (card 22.2).
    changes.register<Payload>('provider.budgets', {
      permission: 'providers:write',
      targetId: (p) => p.credentialId ?? p.providerId,
      describe: (_ctx, p) =>
        Promise.resolve(
          p.credentialId
            ? `Change the budgets of credential ${p.credentialId}`
            : `Change the budgets of provider ${p.providerId}`,
        ),
      apply: (ctx, p) =>
        p.credentialId
          ? this.spend.setCredential(ctx, p.providerId, p.credentialId, p.patch)
          : this.spend.setProvider(ctx, p.providerId, p.patch),
    });
  }

  @Get('spend')
  @RequirePermission('providers:read')
  @ApiZodOk(SpendView, 'Budgets, quota windows and the credential strategy')
  get(@Org() org: OrgContext, @Param('id') id: string) {
    return this.spend.get(org, id);
  }

  @Put('spend')
  @RequirePermission('providers:write')
  @ApiZodBody(ProviderSpendBody)
  @ApiZodOk(SpendView, '202 with the change request when a budget change waits for approval')
  async setProvider(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ProviderSpendBody)) body: z.infer<typeof ProviderSpendBody>,
    @Res() reply: FastifyReply,
  ) {
    const gate = (await this.spend.changesBudgets(org, id, body))
      ? await this.changes.gate(org, 'provider.budgets', { providerId: id, patch: body })
      : {};
    return sendGated(reply, gate, () => this.spend.setProvider(org, id, body));
  }

  @Put('credentials/:credentialId/spend')
  @RequirePermission('providers:write')
  @ApiZodBody(CredentialSpendBody)
  @ApiZodOk(SpendView, '202 with the change request when a budget change waits for approval')
  async setCredential(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Param('credentialId') credentialId: string,
    @Body(new ZodPipe(CredentialSpendBody)) body: z.infer<typeof CredentialSpendBody>,
    @Res() reply: FastifyReply,
  ) {
    const gate = (await this.spend.changesBudgets(org, id, body, credentialId))
      ? await this.changes.gate(org, 'provider.budgets', {
          providerId: id,
          credentialId,
          patch: body,
        })
      : {};
    return sendGated(reply, gate, () => this.spend.setCredential(org, id, credentialId, body));
  }
}
