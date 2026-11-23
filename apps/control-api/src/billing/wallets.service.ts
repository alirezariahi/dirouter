/**
 * Wallets (card 19.1): the customer's view of its balance and statement, and the operator's tools
 * (prepaid mode, manual credit and debit, ledger audit). Every money movement goes through
 * `@dirouter/db`'s ledger, which keeps it double-entry and idempotent; after a posting the new
 * balance is copied to Valkey so the gateway can reserve against it at once.
 */
import {
  usdToUnits,
  unitsToUsd,
  WALLET_APPLY_LUA,
  walletHoldsKey,
  walletKey,
} from '@dirouter/contracts';
import {
  checkLedger,
  ensureSystemWallets,
  ensureWallet,
  LedgerError,
  type PostInput,
  postTransaction,
  SYSTEM_WALLETS,
  toUnits,
  type WalletState,
} from '@dirouter/db';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

type MirrorRedis = Redis & { walletApply(...args: (string | number)[]): Promise<number> };

/** Ledger errors as API problems: a refused posting is a 409/422, never a 500. */
export function ledgerProblem(error: unknown): unknown {
  if (!(error instanceof LedgerError)) return error;
  switch (error.code) {
    case 'insufficient_funds':
      return new DiRouterError('insufficient_credit', { message: error.message });
    case 'wallet_not_found':
      return new DiRouterError('not_found', { message: error.message });
    default:
      return new DiRouterError('validation_failed', { message: error.message });
  }
}

@Injectable()
export class WalletsService implements OnApplicationBootstrap {
  readonly #redis: MirrorRedis;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) valkey: ValkeyService,
  ) {
    this.#redis = valkey.client as MirrorRedis;
    this.#redis.defineCommand('walletApply', { numberOfKeys: 2, lua: WALLET_APPLY_LUA });
  }

  get db() {
    return this.prisma.client;
  }

  async onApplicationBootstrap(): Promise<void> {
    await ensureSystemWallets(this.db);
  }

  /**
   * Posts and mirrors the touched customer wallets to Valkey. A failed mirror is not an error:
   * the worker's wallet sync copies the balance within a minute.
   */
  async post(input: PostInput) {
    let result;
    try {
      result = await postTransaction(this.db, input);
    } catch (error) {
      throw ledgerProblem(error);
    }
    await this.mirror(result.wallets);
    return result;
  }

  async mirror(wallets: readonly WalletState[]): Promise<void> {
    for (const w of wallets)
      await this.#redis
        .walletApply(
          walletKey(w.walletId),
          walletHoldsKey(w.walletId),
          '',
          usdToUnits(w.balanceUsd),
          w.version,
        )
        .catch(() => undefined);
  }

  /** The organization's wallet, created and mirrored to Valkey on first use. */
  async ensure(organizationId: string) {
    const wallet = await ensureWallet(this.db, organizationId);
    if (wallet.version === 0)
      await this.mirror([{ walletId: wallet.id, balanceUsd: '0.00000000', version: 0 }]);
    return wallet;
  }

  /** Balance as the gateway sees it: the ledger balance minus open reservations. */
  async #held(walletId: string): Promise<string> {
    const held = await this.#redis.hget(walletKey(walletId), 'held').catch(() => null);
    return unitsToUsd(Math.max(0, Number(held ?? 0)));
  }

  async summary(organizationId: string) {
    const org = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { prepaid: true, wallet: true },
    });
    if (!org) throw new DiRouterError('not_found');
    const wallet = org.wallet;
    if (!wallet) return { prepaid: org.prepaid, wallet: null };
    const balanceUsd = wallet.balanceUsd.toFixed(8);
    const heldUsd = await this.#held(wallet.id);
    const available = toUnits(balanceUsd) - toUnits(heldUsd);
    return {
      prepaid: org.prepaid,
      wallet: {
        id: wallet.id,
        balanceUsd,
        heldUsd,
        availableUsd: unitsToUsd(Number(available > 0n ? available : 0n)),
        updatedAt: wallet.updatedAt.toISOString(),
      },
    };
  }

  /** Statement: the wallet's legs, newest first, with the running balance after each. */
  async statement(organizationId: string, limit: number, before?: string) {
    const wallet = await this.db.wallet.findUnique({ where: { organizationId } });
    if (!wallet) return [];
    const entries = await this.db.walletEntry.findMany({
      where: { walletId: wallet.id, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: {
        transaction: { select: { kind: true, description: true, metadata: true } },
      },
    });
    return entries.map((e) => ({
      id: e.id,
      transactionId: e.transactionId,
      kind: e.transaction.kind,
      description: e.transaction.description,
      amountUsd: e.amountUsd.toFixed(8),
      balanceAfterUsd: e.balanceAfter?.toFixed(8) ?? null,
      metadata: e.transaction.metadata,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  // ───────────── Operator (platform organization) ─────────────

  async listWallets() {
    const orgs = await this.db.organization.findMany({
      where: { deletedAt: null, isPlatform: false },
      select: { id: true, name: true, slug: true, prepaid: true, wallet: true },
      orderBy: { createdAt: 'asc' },
    });
    return orgs.map((o) => ({
      organizationId: o.id,
      name: o.name,
      slug: o.slug,
      prepaid: o.prepaid,
      walletId: o.wallet?.id ?? null,
      balanceUsd: o.wallet?.balanceUsd.toFixed(8) ?? '0.00000000',
    }));
  }

  async #customer(organizationId: string) {
    const org = await this.db.organization.findFirst({
      where: { id: organizationId, deletedAt: null, isPlatform: false },
      select: { id: true },
    });
    if (!org) throw new DiRouterError('not_found', { message: 'Organization not found' });
    return this.ensure(org.id);
  }

  /** Prepaid mode on or off. The snapshot rebuild then adds or removes the keys' wallet. */
  async setPrepaid(ctx: OrgContext, organizationId: string, prepaid: boolean) {
    const wallet = await this.#customer(organizationId);
    await this.db.organization.update({ where: { id: organizationId }, data: { prepaid } });
    await this.mirror([
      { walletId: wallet.id, balanceUsd: wallet.balanceUsd.toFixed(8), version: wallet.version },
    ]);
    await this.#audit(ctx, 'billing.prepaid_changed', organizationId, { prepaid });
    return this.summary(organizationId);
  }

  /**
   * Manual credit (positive) or debit (negative) against the funding account, e.g. a bank
   * transfer or a correction. The idempotency key makes a double-click or a retry harmless.
   */
  async adjust(
    ctx: OrgContext,
    organizationId: string,
    input: { amountUsd: string; reason: string; idempotencyKey: string },
  ) {
    const wallet = await this.#customer(organizationId);
    const amount = toUnits(input.amountUsd);
    if (amount === 0n) throw new DiRouterError('validation_failed', { message: 'amount is zero' });
    const negated = input.amountUsd.startsWith('-')
      ? input.amountUsd.slice(1)
      : `-${input.amountUsd}`;
    const result = await this.post({
      kind: 'adjustment',
      idempotencyKey: `adjustment:${organizationId}:${input.idempotencyKey}`,
      description: input.reason,
      createdById: ctx.userId,
      metadata: { organizationId },
      legs: [
        { walletId: wallet.id, amountUsd: input.amountUsd },
        { walletId: SYSTEM_WALLETS.funding, amountUsd: negated },
      ],
    });
    if (result.created)
      await this.#audit(ctx, 'billing.wallet_adjusted', organizationId, {
        amountUsd: input.amountUsd,
        reason: input.reason,
        transactionId: result.transactionId,
      });
    return { transactionId: result.transactionId, created: result.created };
  }

  async ledgerCheck() {
    const check = await checkLedger(this.db);
    return {
      ...check,
      ok:
        check.totalUsd === '0.00000000' &&
        check.unbalancedTransactions === 0 &&
        check.driftedWallets === 0,
    };
  }

  async #audit(ctx: OrgContext, action: string, targetId: string, diff: object) {
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        action,
        targetType: 'organization',
        targetId,
        diff,
      },
    });
  }
}
