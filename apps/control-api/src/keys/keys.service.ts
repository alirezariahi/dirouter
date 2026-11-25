/**
 * Virtual keys (card 3.7). Format `dr-<prefix>-<secret>`: the full key is returned only once, in the create or
 * rotate response. The DB stores only `prefix` (for display and lookup) and the HMAC-SHA256 computed with `KEY_PEPPER`
 * ; the gateway sees this same hash in the snapshot. Revocation and expiry take effect with the next snapshot.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

import type { RepairKind } from '@dirouter/contracts';
import type { Prisma } from '@dirouter/db';
import { DiRouterError, ForbiddenError, hashApiKey, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { requireVerifiedEmail } from '../auth/acting-human.js';
import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { canAny } from '../rbac/permissions.js';
import { type BudgetPeriod, fromDbPeriod, toDbPeriod } from '../limits/periods.js';

const ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'; // no l, 0, or 1, for readability
const randomString = (n: number) => {
  const bytes = randomBytes(n);
  let out = '';
  for (const b of bytes) out += ALPHABET.charAt(b % ALPHABET.length);
  return out;
};

export function newApiKey(): { key: string; prefix: string } {
  const prefix = `dr-${randomString(8)}`;
  // 40 characters from 33 symbols ≈ 200 bits; modulo bias is negligible at this length.
  return { key: `${prefix}-${randomString(40)}`, prefix };
}

export function validCidr(entry: string): boolean {
  const [addr = '', bits, ...rest] = entry.split('/');
  const family = isIP(addr);
  if (!family || rest.length > 0) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && n >= 0 && n <= (family === 4 ? 32 : 128);
}

export interface BudgetInput {
  period: BudgetPeriod;
  limitUsd?: string | undefined;
  limitTokens?: number | undefined;
  alertThresholds?: number[] | undefined;
}
export interface KeyInput {
  name: string;
  projectId: string;
  allowedModels?: string[] | undefined;
  mcpTools?: string[] | undefined;
  passthroughProviders?: string[] | undefined;
  mcpAdmin?: 'none' | 'read' | 'write' | undefined;
  ipAllowlist?: string[] | undefined;
  repair?: RepairKind[] | undefined;
  rpm?: number | null | undefined;
  tpm?: number | null | undefined;
  inputTpm?: number | null | undefined;
  outputTpm?: number | null | undefined;
  maxConcurrency?: number | null | undefined;
  expiresAt?: string | null | undefined;
  budgets?: BudgetInput[] | undefined;
  /** Limits on one model each (card 33.3); replaces every entry, absent keeps them. */
  modelLimits?: ModelLimitInput[] | undefined;
}

export interface ModelLimitInput {
  /** Model, alias or combo slug, as clients name it. */
  model: string;
  rpm?: number | null | undefined;
  tpm?: number | null | undefined;
  inputTpm?: number | null | undefined;
  outputTpm?: number | null | undefined;
  maxConcurrency?: number | null | undefined;
  budgets?: BudgetInput[] | undefined;
}

/** Rate limits of one model entry as stored in `api_keys.model_limits`. */
interface StoredModelLimit {
  model: string;
  rpm?: number;
  tpm?: number;
  inputTpm?: number;
  outputTpm?: number;
  maxConcurrency?: number;
}

export const storedModelLimits = (value: unknown): StoredModelLimit[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is StoredModelLimit =>
          typeof v === 'object' &&
          v !== null &&
          typeof (v as { model?: unknown }).model === 'string',
      )
    : [];

/** Scope id of a key's budget on one model (card 33.3). */
export const keyModelScopeId = (keyId: string, model: string) => `${keyId}|${model}`;

const notFound = () => new DiRouterError('not_found');
const MAX_GRACE_S = 30 * 24 * 3600;

@Injectable()
export class KeysService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get db() {
    return this.prisma.client;
  }

  async #budgets(keyIds: string[]) {
    const rows = await this.db.budget.findMany({
      where: {
        OR: [
          { scope: 'API_KEY', scopeId: { in: keyIds } },
          ...keyIds.map((id) => ({
            scope: 'API_KEY_MODEL' as const,
            scopeId: { startsWith: `${id}|` },
          })),
        ],
      },
      orderBy: { period: 'asc' },
    });
    const by = new Map<string, typeof rows>();
    for (const b of rows) {
      const keyId = b.scope === 'API_KEY' ? b.scopeId : b.scopeId.slice(0, b.scopeId.indexOf('|'));
      by.set(keyId, [...(by.get(keyId) ?? []), b]);
    }
    return by;
  }

  #view(
    k: Awaited<ReturnType<KeysService['load']>>,
    all: Awaited<ReturnType<KeysService['budgetRows']>>,
  ) {
    const budgets = all.filter((b) => b.scope === 'API_KEY');
    const budgetView = (b: (typeof all)[number]) => ({
      id: b.id,
      period: fromDbPeriod(b.period),
      limitUsd: b.limitUsd?.toFixed(8).replace(/\.?0+$/, '') ?? null,
      limitTokens: b.limitTokens === null ? null : Number(b.limitTokens),
      alertThresholds: b.alertThresholds,
    });
    const now = Date.now();
    const state =
      k.status === 'REVOKED'
        ? 'revoked'
        : k.expiresAt && k.expiresAt.getTime() <= now
          ? 'expired'
          : k.rotatedToId
            ? 'rotating'
            : 'active';
    return {
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      projectId: k.projectId,
      state,
      allowedModels: k.allowedModels,
      mcpTools: k.mcpTools,
      passthroughProviders: k.passthroughProviders,
      mcpAdmin: k.mcpAdmin as 'none' | 'read' | 'write',
      ipAllowlist: k.ipAllowlist,
      repair: k.repair.filter((r): r is RepairKind => r === 'json' || r === 'tools'),
      rpm: k.rpm,
      tpm: k.tpm,
      inputTpm: k.inputTpm,
      outputTpm: k.outputTpm,
      maxConcurrency: k.maxConcurrency,
      modelLimits: storedModelLimits(k.modelLimits).map((m) => ({
        model: m.model,
        rpm: m.rpm ?? null,
        tpm: m.tpm ?? null,
        inputTpm: m.inputTpm ?? null,
        outputTpm: m.outputTpm ?? null,
        maxConcurrency: m.maxConcurrency ?? null,
        budgets: all
          .filter(
            (b) => b.scope === 'API_KEY_MODEL' && b.scopeId === keyModelScopeId(k.id, m.model),
          )
          .map(budgetView),
      })),
      expiresAt: k.expiresAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      rotatedToId: k.rotatedToId,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
      budgets: budgets.map(budgetView),
    };
  }

  budgetRows(keyId: string) {
    return this.db.budget.findMany({
      where: {
        OR: [
          { scope: 'API_KEY', scopeId: keyId },
          { scope: 'API_KEY_MODEL', scopeId: { startsWith: `${keyId}|` } },
        ],
      },
      orderBy: { period: 'asc' },
    });
  }

  /** Whether a patch changes the key's budgets on its models (four-eyes, card 22.2). */
  async changesModelBudgets(
    ctx: OrgContext,
    id: string,
    input: { modelLimits?: ModelLimitInput[] | undefined },
  ) {
    if (input.modelLimits === undefined) return false;
    if (input.modelLimits.some((m) => (m.budgets ?? []).length > 0)) return true;
    return (await this.get(ctx, id)).modelLimits.some((m) => m.budgets.length > 0);
  }

  async load(ctx: OrgContext, id: string) {
    const k = await this.db.apiKey.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!k) throw notFound();
    return k;
  }

  async list(ctx: OrgContext, projectId?: string) {
    const rows = await this.db.apiKey.findMany({
      where: { organizationId: ctx.organizationId, ...(projectId ? { projectId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    const budgets = await this.#budgets(rows.map((r) => r.id));
    return rows.map((k) => this.#view(k, budgets.get(k.id) ?? []));
  }

  async get(ctx: OrgContext, id: string) {
    return this.#view(await this.load(ctx, id), await this.budgetRows(id));
  }

  #check(input: Partial<KeyInput>, ctx?: OrgContext) {
    // Admin scope on DiRouter's MCP server (card 20.2) is granted by owners and admins only: a
    // member who may create keys must not mint one that manages the organization.
    if (
      ctx &&
      input.mcpAdmin !== undefined &&
      input.mcpAdmin !== 'none' &&
      !canAny(ctx.role, ctx.customPermissions, 'org:write')
    )
      throw new ForbiddenError('forbidden', {
        message: 'Only owners and admins can grant MCP admin access to a key',
      });
    // Pass-through (card 30.7) reaches the provider's raw API (files, batches, fine-tunes) with
    // the organization's credentials, so granting it is an owner or admin decision too.
    if (
      ctx &&
      input.passthroughProviders !== undefined &&
      input.passthroughProviders.length > 0 &&
      !canAny(ctx.role, ctx.customPermissions, 'org:write')
    )
      throw new ForbiddenError('forbidden', {
        message: 'Only owners and admins can grant pass-through access to a key',
      });
    for (const ip of input.ipAllowlist ?? [])
      if (!validCidr(ip))
        throw new DiRouterError('validation_failed', { message: `invalid IP or CIDR: ${ip}` });
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
      throw new DiRouterError('validation_failed', { message: 'expiresAt must be in the future' });
  }

  async #project(ctx: OrgContext, projectId: string) {
    const p = await this.db.project.findFirst({
      where: { id: projectId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!p) throw new DiRouterError('not_found', { message: 'Project not found' });
  }

  async create(ctx: OrgContext, input: KeyInput) {
    this.#check(input, ctx);
    // A portal sign-up whose address is not verified yet cannot create keys (card 23.4); with a
    // management token the person who created the token is checked.
    await requireVerifiedEmail(this.db, ctx, 'Verify your email address before creating API keys');
    await this.#project(ctx, input.projectId);
    const { key, prefix } = newApiKey();
    const id = prefixedId('key');
    await this.db.$transaction(async (tx) => {
      await tx.apiKey.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          projectId: input.projectId,
          name: input.name,
          prefix,
          hash: hashApiKey(key, this.env.KEY_PEPPER),
          allowedModels: input.allowedModels ?? [],
          mcpTools: input.mcpTools ?? [],
          passthroughProviders: input.passthroughProviders ?? [],
          mcpAdmin: input.mcpAdmin ?? 'none',
          ipAllowlist: input.ipAllowlist ?? [],
          repair: [...new Set(input.repair ?? [])],
          rpm: input.rpm ?? null,
          tpm: input.tpm ?? null,
          inputTpm: input.inputTpm ?? null,
          outputTpm: input.outputTpm ?? null,
          maxConcurrency: input.maxConcurrency ?? null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdById: ctx.userId,
        },
      });
      await this.#replaceBudgets(tx, ctx, id, input.budgets ?? []);
      if (input.modelLimits) await this.#replaceModelLimits(tx, ctx, id, input.modelLimits);
      await this.#audit(tx, ctx, 'key.created', id, {
        name: input.name,
        prefix,
        projectId: input.projectId,
      });
    });
    // The full key is returned only here.
    return { ...(await this.get(ctx, id)), key };
  }

  async update(ctx: OrgContext, id: string, input: Partial<Omit<KeyInput, 'projectId'>>) {
    this.#check(input, ctx);
    await this.load(ctx, id);
    await this.db.$transaction(async (tx) => {
      await tx.apiKey.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.allowedModels !== undefined ? { allowedModels: input.allowedModels } : {}),
          ...(input.mcpTools !== undefined ? { mcpTools: input.mcpTools } : {}),
          ...(input.passthroughProviders !== undefined
            ? { passthroughProviders: input.passthroughProviders }
            : {}),
          ...(input.mcpAdmin !== undefined ? { mcpAdmin: input.mcpAdmin } : {}),
          ...(input.ipAllowlist !== undefined ? { ipAllowlist: input.ipAllowlist } : {}),
          ...(input.repair !== undefined ? { repair: [...new Set(input.repair)] } : {}),
          ...(input.rpm !== undefined ? { rpm: input.rpm } : {}),
          ...(input.tpm !== undefined ? { tpm: input.tpm } : {}),
          ...(input.inputTpm !== undefined ? { inputTpm: input.inputTpm } : {}),
          ...(input.outputTpm !== undefined ? { outputTpm: input.outputTpm } : {}),
          ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
          ...(input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }
            : {}),
        },
      });
      if (input.budgets !== undefined) await this.#replaceBudgets(tx, ctx, id, input.budgets);
      if (input.modelLimits !== undefined)
        await this.#replaceModelLimits(tx, ctx, id, input.modelLimits);
      await this.#audit(tx, ctx, 'key.updated', id, input);
    });
    return this.get(ctx, id);
  }

  async revoke(ctx: OrgContext, id: string) {
    const k = await this.load(ctx, id);
    if (k.status !== 'REVOKED')
      await this.db.$transaction([
        this.db.apiKey.update({
          where: { id },
          data: { status: 'REVOKED', revokedAt: new Date() },
        }),
        this.db.auditLog.create({
          data: this.#auditData(ctx, 'key.revoked', id, { prefix: k.prefix }),
        }),
      ]);
    return this.get(ctx, id);
  }

  /**
   * Rotation: the new key is created with the same settings and budget; the old key remains valid until the end of the grace period
   * (expiresAt = now + grace period) and points to the new key.
   */
  async rotate(ctx: OrgContext, id: string, graceSeconds: number) {
    const old = await this.load(ctx, id);
    if (old.status === 'REVOKED' || (old.expiresAt && old.expiresAt.getTime() <= Date.now()))
      throw new DiRouterError('conflict', { message: 'Only an active key can be rotated' });
    if (old.rotatedToId)
      throw new DiRouterError('conflict', { message: 'Key has already been rotated' });
    const grace = Math.min(Math.max(0, graceSeconds), MAX_GRACE_S);
    const graceEnd = new Date(Date.now() + grace * 1000);
    const { key, prefix } = newApiKey();
    const nextId = prefixedId('key');
    const budgets = await this.budgetRows(id);
    await this.db.$transaction(async (tx) => {
      await tx.apiKey.create({
        data: {
          id: nextId,
          organizationId: old.organizationId,
          projectId: old.projectId,
          name: old.name,
          prefix,
          hash: hashApiKey(key, this.env.KEY_PEPPER),
          allowedModels: old.allowedModels,
          mcpTools: old.mcpTools,
          passthroughProviders: old.passthroughProviders,
          mcpAdmin: old.mcpAdmin,
          ipAllowlist: old.ipAllowlist,
          repair: old.repair,
          rpm: old.rpm,
          tpm: old.tpm,
          inputTpm: old.inputTpm,
          outputTpm: old.outputTpm,
          maxConcurrency: old.maxConcurrency,
          expiresAt: old.expiresAt,
          createdById: ctx.userId,
        },
      });
      // The key's model limits and their budgets move to the new key (card 33.3).
      await this.#replaceModelLimits(
        tx,
        ctx,
        nextId,
        storedModelLimits(old.modelLimits).map((m) => ({
          ...m,
          budgets: budgets
            .filter(
              (b) => b.scope === 'API_KEY_MODEL' && b.scopeId === keyModelScopeId(id, m.model),
            )
            .map((b) => ({
              period: fromDbPeriod(b.period),
              ...(b.limitUsd ? { limitUsd: b.limitUsd.toString() } : {}),
              ...(b.limitTokens !== null ? { limitTokens: Number(b.limitTokens) } : {}),
              alertThresholds: b.alertThresholds,
            })),
        })),
      );
      await tx.apiKey.update({
        where: { id },
        data: {
          rotatedToId: nextId,
          expiresAt: old.expiresAt && old.expiresAt < graceEnd ? old.expiresAt : graceEnd,
        },
      });
      await this.#replaceBudgets(
        tx,
        ctx,
        nextId,
        budgets
          .filter((b) => b.scope === 'API_KEY')
          .map((b) => ({
            period: fromDbPeriod(b.period),
            ...(b.limitUsd ? { limitUsd: b.limitUsd.toString() } : {}),
            ...(b.limitTokens !== null ? { limitTokens: Number(b.limitTokens) } : {}),
            alertThresholds: b.alertThresholds,
          })),
      );
      await this.#audit(tx, ctx, 'key.rotated', id, { to: nextId, graceSeconds: grace });
    });
    return { ...(await this.get(ctx, nextId)), key, previous: await this.get(ctx, id) };
  }

  async #replaceBudgets(
    tx: Pick<PrismaService['client'], 'budget'>,
    ctx: OrgContext,
    keyId: string,
    budgets: BudgetInput[],
  ) {
    const periods = new Set(budgets.map((b) => b.period));
    if (periods.size !== budgets.length)
      throw new DiRouterError('validation_failed', { message: 'one budget per period' });
    await tx.budget.deleteMany({ where: { scope: 'API_KEY', scopeId: keyId } });
    for (const b of budgets) {
      if (b.limitUsd === undefined && b.limitTokens === undefined)
        throw new DiRouterError('validation_failed', {
          message: 'budget needs limitUsd or limitTokens',
        });
      await tx.budget.create({
        data: {
          id: prefixedId('bud'),
          organizationId: ctx.organizationId,
          scope: 'API_KEY',
          scopeId: keyId,
          period: toDbPeriod(b.period),
          limitUsd: b.limitUsd ?? null,
          limitTokens: b.limitTokens ?? null,
          alertThresholds: b.alertThresholds ?? [50, 80, 100],
        },
      });
    }
  }

  /**
   * Replaces the key's limits on single models (card 33.3). A budget keeps its id while its model
   * and period stay, so the gateway keeps counting the current period on the same counter.
   */
  async #replaceModelLimits(
    tx: Pick<PrismaService['client'], 'budget' | 'apiKey'>,
    ctx: OrgContext,
    keyId: string,
    entries: ModelLimitInput[],
  ) {
    const models = new Set(entries.map((e) => e.model));
    if (models.size !== entries.length)
      throw new DiRouterError('validation_failed', { message: 'one entry per model' });
    const stored: StoredModelLimit[] = entries.map((e) => ({
      model: e.model,
      ...(e.rpm ? { rpm: e.rpm } : {}),
      ...(e.tpm ? { tpm: e.tpm } : {}),
      ...(e.inputTpm ? { inputTpm: e.inputTpm } : {}),
      ...(e.outputTpm ? { outputTpm: e.outputTpm } : {}),
      ...(e.maxConcurrency ? { maxConcurrency: e.maxConcurrency } : {}),
    }));
    await tx.apiKey.update({
      where: { id: keyId },
      data: { modelLimits: JSON.parse(JSON.stringify(stored)) as Prisma.InputJsonValue },
    });
    const keep: string[] = [];
    for (const e of entries) {
      const budgets = e.budgets ?? [];
      if (new Set(budgets.map((b) => b.period)).size !== budgets.length)
        throw new DiRouterError('validation_failed', { message: 'one budget per period' });
      const scopeId = keyModelScopeId(keyId, e.model);
      for (const b of budgets) {
        if (b.limitUsd === undefined && b.limitTokens === undefined)
          throw new DiRouterError('validation_failed', {
            message: 'budget needs limitUsd or limitTokens',
          });
        const period = toDbPeriod(b.period);
        const data = {
          limitUsd: b.limitUsd ?? null,
          limitTokens: b.limitTokens ?? null,
          alertThresholds: b.alertThresholds ?? [50, 80, 100],
        };
        const row = await tx.budget.upsert({
          where: {
            organizationId_scope_scopeId_period: {
              organizationId: ctx.organizationId,
              scope: 'API_KEY_MODEL',
              scopeId,
              period,
            },
          },
          update: data,
          create: {
            id: prefixedId('bud'),
            organizationId: ctx.organizationId,
            scope: 'API_KEY_MODEL',
            scopeId,
            period,
            ...data,
          },
        });
        keep.push(row.id);
      }
    }
    await tx.budget.deleteMany({
      where: {
        scope: 'API_KEY_MODEL',
        scopeId: { startsWith: `${keyId}|` },
        id: { notIn: keep },
      },
    });
  }

  #auditData(ctx: OrgContext, action: string, targetId: string, diff?: object) {
    return {
      id: prefixedId('aud'),
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      ...(ctx.ip ? { ip: ctx.ip } : {}),
      action,
      targetType: 'api_key',
      targetId,
      ...(diff ? { diff } : {}),
    };
  }

  async #audit(
    tx: Pick<PrismaService['client'], 'auditLog'>,
    ctx: OrgContext,
    action: string,
    targetId: string,
    diff?: object,
  ) {
    await tx.auditLog.create({ data: this.#auditData(ctx, action, targetId, diff) });
  }
}
