/**
 * Spend caps of upstream accounts (card 32.6): daily, weekly, monthly or yearly budgets of a whole
 * provider and of each credential, quota windows of a credential (coding plans used with an API
 * key: requests, tokens or dollars per N hours from the first request), and the order the gateway
 * uses the credentials in. A used-up account leaves the route, so traffic moves to the next
 * credential or target without an error.
 *
 * Budgets are `budgets` rows with scope PROVIDER_ACCOUNT or CREDENTIAL, owned by the provider's
 * organization; they count every organization's requests the account serves.
 */
import { QuotaWindowConfig, quotaWindowKey } from '@dirouter/contracts';
import { Prisma } from '@dirouter/db';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { PrismaService } from '../infra/prisma.service.js';
import type { LimitBudgetInput } from '../limits/limits.service.js';
import { sameBudgets } from '../limits/limits.service.js';
import { fromDbPeriod, periodRank, toDbPeriod } from '../limits/periods.js';
import type { OrgContext } from '../rbac/org.guard.js';

export const CREDENTIAL_STRATEGIES = ['weighted', 'fill-first', 'reset-aware'] as const;
export type CredentialStrategy = (typeof CREDENTIAL_STRATEGIES)[number];

export interface ProviderSpendInput {
  credentialStrategy?: CredentialStrategy | undefined;
  budgets?: LimitBudgetInput[] | undefined;
}
export interface CredentialSpendInput {
  budgets?: LimitBudgetInput[] | undefined;
  quotaWindows?: QuotaWindowConfig[] | undefined;
}

type BudgetRow = Awaited<ReturnType<PrismaService['client']['budget']['findMany']>>[number];
const decimal = (value: Prisma.Decimal | null) =>
  value === null ? null : value.toFixed(8).replace(/\.?0+$/, '') || '0';
const budgetView = (b: BudgetRow) => ({
  id: b.id,
  period: fromDbPeriod(b.period),
  limitUsd: decimal(b.limitUsd),
  limitTokens: b.limitTokens === null ? null : Number(b.limitTokens),
  alertThresholds: b.alertThresholds,
});

/** Quota windows as stored on a credential; anything malformed is dropped. */
export const storedQuotaWindows = (value: unknown): QuotaWindowConfig[] =>
  Array.isArray(value)
    ? value.flatMap((w) => {
        const parsed = QuotaWindowConfig.safeParse(w);
        return parsed.success ? [parsed.data] : [];
      })
    : [];

/** A quota window with its live counters (Health page countdown, card 32.6). */
export interface QuotaView {
  id: string;
  hours: number;
  limitRequests: number | null;
  limitTokens: number | null;
  limitUsd: string | null;
  used: { requests: number; tokens: number; usd: string };
  /** When the running window ends; null before its first request. */
  resetAt: string | null;
  exhausted: boolean;
}

const units = (usd: string) => Number(new Prisma.Decimal(usd).mul(100_000_000).toFixed(0));

@Injectable()
export class ProviderSpendService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  get db() {
    return this.prisma.client;
  }

  async #provider(ctx: OrgContext, id: string) {
    const p = await this.db.provider.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
      include: { credentials: { orderBy: { id: 'asc' } } },
    });
    if (!p) throw new DiRouterError('not_found', { message: 'provider not found' });
    return p;
  }

  async get(ctx: OrgContext, id: string) {
    const p = await this.#provider(ctx, id);
    const budgets = await this.db.budget.findMany({
      where: {
        organizationId: ctx.organizationId,
        OR: [
          { scope: 'PROVIDER_ACCOUNT', scopeId: p.id },
          { scope: 'CREDENTIAL', scopeId: { in: p.credentials.map((c) => c.id) } },
        ],
      },
    });
    const of = (scope: string, scopeId: string) =>
      budgets
        .filter((b) => b.scope === scope && b.scopeId === scopeId)
        .sort((a, b) => periodRank(a.period) - periodRank(b.period))
        .map(budgetView);
    return {
      providerId: p.id,
      credentialStrategy: p.credentialStrategy as CredentialStrategy,
      budgets: of('PROVIDER_ACCOUNT', p.id),
      credentials: p.credentials.map((c) => ({
        id: c.id,
        name: c.name,
        budgets: of('CREDENTIAL', c.id),
        quotaWindows: storedQuotaWindows(c.quotaWindows),
      })),
    };
  }

  /** Whether an input changes budgets (they need four-eyes approval, card 22.2). */
  async changesBudgets(
    ctx: OrgContext,
    id: string,
    input: { budgets?: LimitBudgetInput[] | undefined },
    credentialId?: string,
  ) {
    if (input.budgets === undefined) return false;
    const view = await this.get(ctx, id);
    const current = credentialId
      ? view.credentials.find((c) => c.id === credentialId)?.budgets
      : view.budgets;
    return !sameBudgets(current ?? [], input.budgets);
  }

  async #replaceBudgets(
    tx: Pick<PrismaService['client'], 'budget'>,
    ctx: OrgContext,
    scope: 'PROVIDER_ACCOUNT' | 'CREDENTIAL',
    scopeId: string,
    budgets: LimitBudgetInput[],
  ) {
    if (new Set(budgets.map((b) => b.period)).size !== budgets.length)
      throw new DiRouterError('validation_failed', { message: 'one budget per period' });
    const where = { organizationId: ctx.organizationId, scope, scopeId };
    await tx.budget.deleteMany({
      where: { ...where, period: { notIn: budgets.map((b) => toDbPeriod(b.period)) } },
    });
    for (const b of budgets) {
      if (b.limitUsd === undefined && b.limitTokens === undefined)
        throw new DiRouterError('validation_failed', {
          message: 'budget needs limitUsd or limitTokens',
        });
      const data = {
        limitUsd: b.limitUsd ?? null,
        limitTokens: b.limitTokens ?? null,
        alertThresholds: b.alertThresholds ?? [50, 80, 100],
      };
      const period = toDbPeriod(b.period);
      await tx.budget.upsert({
        where: { organizationId_scope_scopeId_period: { ...where, period } },
        update: data,
        create: { id: prefixedId('bud'), ...where, period, ...data },
      });
    }
  }

  #audit(ctx: OrgContext, targetType: string, targetId: string, diff: object) {
    return {
      id: prefixedId('aud'),
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      ...(ctx.ip ? { ip: ctx.ip } : {}),
      action: 'provider.spend_updated',
      targetType,
      targetId,
      diff: JSON.parse(JSON.stringify(diff)) as Prisma.InputJsonValue,
    };
  }

  async setProvider(ctx: OrgContext, id: string, input: ProviderSpendInput) {
    await this.#provider(ctx, id);
    await this.db.$transaction(async (tx) => {
      if (input.credentialStrategy)
        await tx.provider.update({
          where: { id },
          data: { credentialStrategy: input.credentialStrategy },
        });
      if (input.budgets) await this.#replaceBudgets(tx, ctx, 'PROVIDER_ACCOUNT', id, input.budgets);
      await tx.auditLog.create({ data: this.#audit(ctx, 'provider', id, input) });
    });
    return this.get(ctx, id);
  }

  async setCredential(
    ctx: OrgContext,
    id: string,
    credentialId: string,
    input: CredentialSpendInput,
  ) {
    const p = await this.#provider(ctx, id);
    if (!p.credentials.some((c) => c.id === credentialId))
      throw new DiRouterError('not_found', { message: 'credential not found' });
    if (input.quotaWindows) {
      const ids = input.quotaWindows.map((w) => w.id);
      if (new Set(ids).size !== ids.length)
        throw new DiRouterError('validation_failed', { message: 'quota window ids must differ' });
    }
    await this.db.$transaction(async (tx) => {
      if (input.quotaWindows)
        await tx.credential.update({
          where: { id: credentialId },
          data: {
            quotaWindows: JSON.parse(JSON.stringify(input.quotaWindows)) as Prisma.InputJsonValue,
          },
        });
      if (input.budgets)
        await this.#replaceBudgets(tx, ctx, 'CREDENTIAL', credentialId, input.budgets);
      await tx.auditLog.create({ data: this.#audit(ctx, 'credential', credentialId, input) });
    });
    return this.get(ctx, id);
  }
}

/**
 * Live state of the quota windows of these credentials (card 32.6), from the gateway's Valkey
 * counters: what was used and when the window resets (null before its first request).
 */
export async function quotaState(
  valkey: Pick<Redis, 'pipeline'>,
  credentials: { id: string; quotaWindows: unknown }[],
  now = Date.now(),
): Promise<Map<string, QuotaView[]>> {
  const windows = credentials.flatMap((c) =>
    storedQuotaWindows(c.quotaWindows).map((w) => ({ credentialId: c.id, w })),
  );
  const out = new Map<string, QuotaView[]>();
  if (windows.length === 0) return out;
  let raw: [Error | null, unknown][] = [];
  try {
    const pipeline = valkey.pipeline();
    for (const { credentialId, w } of windows) {
      const key = quotaWindowKey(credentialId, w.id);
      pipeline.hmget(key, 'requests', 'tokens', 'usd');
      pipeline.pttl(key);
    }
    raw = (await pipeline.exec()) ?? [];
  } catch {
    raw = [];
  }
  windows.forEach(({ credentialId, w }, i) => {
    const values = (raw[i * 2]?.[1] as (string | null)[] | undefined) ?? [];
    const pttl = Number(raw[i * 2 + 1]?.[1] ?? -2);
    const used = {
      requests: Number(values[0] ?? 0),
      tokens: Number(values[1] ?? 0),
      usd: (Number(values[2] ?? 0) / 100_000_000).toFixed(8).replace(/\.?0+$/, '') || '0',
    };
    const exhausted =
      (w.limitRequests !== undefined && used.requests >= w.limitRequests) ||
      (w.limitTokens !== undefined && used.tokens >= w.limitTokens) ||
      (w.limitUsd !== undefined && Number(values[2] ?? 0) >= units(w.limitUsd));
    const list = out.get(credentialId) ?? [];
    list.push({
      id: w.id,
      hours: w.hours,
      limitRequests: w.limitRequests ?? null,
      limitTokens: w.limitTokens ?? null,
      limitUsd: w.limitUsd ?? null,
      used,
      resetAt: pttl > 0 ? new Date(now + pttl).toISOString() : null,
      exhausted,
    });
    out.set(credentialId, list);
  });
  return out;
}
