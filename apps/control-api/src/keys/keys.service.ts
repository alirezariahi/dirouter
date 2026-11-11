/**
 * Virtual keys (card 3.7). Format `dr-<prefix>-<secret>`: the full key is returned only once, in the create or
 * rotate response. The DB stores only `prefix` (for display and lookup) and the HMAC-SHA256 computed with `KEY_PEPPER`
 * ; the gateway sees this same hash in the snapshot. Revocation and expiry take effect with the next snapshot.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

import { DiRouterError, hashApiKey, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

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
  period: 'daily' | 'monthly';
  limitUsd?: string | undefined;
  limitTokens?: number | undefined;
  alertThresholds?: number[] | undefined;
}
export interface KeyInput {
  name: string;
  projectId: string;
  allowedModels?: string[] | undefined;
  ipAllowlist?: string[] | undefined;
  rpm?: number | null | undefined;
  tpm?: number | null | undefined;
  maxConcurrency?: number | null | undefined;
  expiresAt?: string | null | undefined;
  budgets?: BudgetInput[] | undefined;
}

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
      where: { scope: 'API_KEY', scopeId: { in: keyIds } },
    });
    const by = new Map<string, typeof rows>();
    for (const b of rows) by.set(b.scopeId, [...(by.get(b.scopeId) ?? []), b]);
    return by;
  }

  #view(
    k: Awaited<ReturnType<KeysService['load']>>,
    budgets: Awaited<ReturnType<KeysService['budgetRows']>>,
  ) {
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
      ipAllowlist: k.ipAllowlist,
      rpm: k.rpm,
      tpm: k.tpm,
      maxConcurrency: k.maxConcurrency,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      rotatedToId: k.rotatedToId,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
      budgets: budgets.map((b) => ({
        id: b.id,
        period: b.period === 'DAILY' ? 'daily' : 'monthly',
        limitUsd: b.limitUsd?.toFixed(8).replace(/\.?0+$/, '') ?? null,
        limitTokens: b.limitTokens === null ? null : Number(b.limitTokens),
        alertThresholds: b.alertThresholds,
      })),
    };
  }

  budgetRows(keyId: string) {
    return this.db.budget.findMany({
      where: { scope: 'API_KEY', scopeId: keyId },
      orderBy: { period: 'asc' },
    });
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

  #check(input: Partial<KeyInput>) {
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
    this.#check(input);
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
          ipAllowlist: input.ipAllowlist ?? [],
          rpm: input.rpm ?? null,
          tpm: input.tpm ?? null,
          maxConcurrency: input.maxConcurrency ?? null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdById: ctx.userId,
        },
      });
      await this.#replaceBudgets(tx, ctx, id, input.budgets ?? []);
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
    this.#check(input);
    await this.load(ctx, id);
    await this.db.$transaction(async (tx) => {
      await tx.apiKey.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.allowedModels !== undefined ? { allowedModels: input.allowedModels } : {}),
          ...(input.ipAllowlist !== undefined ? { ipAllowlist: input.ipAllowlist } : {}),
          ...(input.rpm !== undefined ? { rpm: input.rpm } : {}),
          ...(input.tpm !== undefined ? { tpm: input.tpm } : {}),
          ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
          ...(input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }
            : {}),
        },
      });
      if (input.budgets !== undefined) await this.#replaceBudgets(tx, ctx, id, input.budgets);
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
          ipAllowlist: old.ipAllowlist,
          rpm: old.rpm,
          tpm: old.tpm,
          maxConcurrency: old.maxConcurrency,
          expiresAt: old.expiresAt,
          createdById: ctx.userId,
        },
      });
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
        budgets.map((b) => ({
          period: b.period === 'DAILY' ? 'daily' : 'monthly',
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
          period: b.period === 'daily' ? 'DAILY' : 'MONTHLY',
          limitUsd: b.limitUsd ?? null,
          limitTokens: b.limitTokens ?? null,
          alertThresholds: b.alertThresholds ?? [50, 80, 100],
        },
      });
    }
  }

  #auditData(ctx: OrgContext, action: string, targetId: string, diff?: object) {
    return {
      id: prefixedId('aud'),
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
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
