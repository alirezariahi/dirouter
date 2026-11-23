/**
 * Gift and recharge codes (card 19.3).
 *
 * The operator generates a batch: every code is random (60 bits), shown once and stored only as an
 * HMAC with the server pepper, like virtual keys. Redemption is one database transaction: a
 * conditional update takes one use of the code only while it is under its cap, unexpired and not
 * revoked (Postgres re-checks the condition after the row lock, so concurrent redemptions cannot
 * overshoot), a unique row stops an organization from redeeming the same code twice, and the
 * credit is posted to the ledger. Failed attempts are rate-limited per organization against
 * guessing.
 */
import { createHmac, randomInt } from 'node:crypto';

import {
  fromUnits,
  postInTransaction,
  SYSTEM_WALLETS,
  toUnits,
  type WalletState,
} from '@dirouter/db';
import { DiRouterError, prefixedId, RateLimitError } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { ledgerProblem, WalletsService } from './wallets.service.js';

/** Crockford-style alphabet without I, L, O and U: easy to read aloud and to type. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 3;
const GROUP_LEN = 4;
/** Failed redemptions allowed per organization per hour. */
export const REDEEM_FAILURES_PER_HOUR = 10;

export function generateCode(): string {
  const groups = Array.from({ length: GROUPS }, () =>
    Array.from({ length: GROUP_LEN }, () => ALPHABET.charAt(randomInt(ALPHABET.length))).join(''),
  );
  return `DR-${groups.join('-')}`;
}

/** Accepts any case, spaces and dashes, and the letters people confuse with digits. */
export function normalizeCode(input: string): string {
  const body = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/^DR/, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return body.length === GROUPS * GROUP_LEN ? `DR-${body.match(/.{4}/g)?.join('-') ?? ''}` : '';
}

export interface BatchInput {
  name: string;
  kind: 'gift' | 'recharge';
  amountUsd: string;
  count: number;
  maxRedemptions: number;
  expiresAt?: string | undefined;
}

@Injectable()
export class GiftCodesService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
    @Inject(WalletsService) private readonly wallets: WalletsService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  #hash(code: string): string {
    return createHmac('sha256', this.env.KEY_PEPPER).update(`gift:${code}`).digest('hex');
  }

  /** Creates the batch and returns its codes; they are never shown again. */
  async createBatch(ctx: OrgContext, input: BatchInput) {
    const batchId = prefixedId('gcb');
    const codes = new Set<string>();
    while (codes.size < input.count) codes.add(generateCode());
    const plain = [...codes];
    await this.db.$transaction([
      this.db.giftCodeBatch.create({
        data: {
          id: batchId,
          name: input.name,
          kind: input.kind,
          amountUsd: input.amountUsd,
          maxRedemptions: input.maxRedemptions,
          ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
          createdById: ctx.userId,
        },
      }),
      this.db.giftCode.createMany({
        data: plain.map((code) => ({
          id: prefixedId('gco'),
          batchId,
          codeHash: this.#hash(code),
          hint: code.slice(0, 7),
        })),
      }),
      this.db.auditLog.create({
        data: {
          id: prefixedId('aud'),
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          ...(ctx.ip ? { ip: ctx.ip } : {}),
          action: 'billing.gift_batch_created',
          targetType: 'gift_code_batch',
          targetId: batchId,
          diff: { ...input, codes: plain.length },
        },
      }),
    ]);
    return { ...(await this.batch(batchId)), codes: plain };
  }

  async batches() {
    const rows = await this.db.giftCodeBatch.findMany({ orderBy: { createdAt: 'desc' } });
    const stats = await this.#stats(rows.map((r) => r.id));
    return rows.map((r) => this.#view(r, stats.get(r.id)));
  }

  async batch(id: string) {
    const row = await this.db.giftCodeBatch.findUnique({ where: { id } });
    if (!row) throw new DiRouterError('not_found');
    return this.#view(row, (await this.#stats([id])).get(id));
  }

  /** Report: every redemption of the batch, with the organization and the code hint. */
  async redemptions(batchId: string) {
    await this.batch(batchId);
    const rows = await this.db.giftCodeRedemption.findMany({
      where: { code: { batchId } },
      orderBy: { createdAt: 'desc' },
      include: {
        code: { select: { hint: true } },
        organization: { select: { id: true, name: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      codeHint: r.code.hint,
      organizationId: r.organization.id,
      organizationName: r.organization.name,
      transactionId: r.transactionId,
      redeemedAt: r.createdAt.toISOString(),
    }));
  }

  async revoke(ctx: OrgContext, id: string) {
    await this.batch(id);
    await this.db.giftCodeBatch.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        action: 'billing.gift_batch_revoked',
        targetType: 'gift_code_batch',
        targetId: id,
      },
    });
    return this.batch(id);
  }

  async #stats(batchIds: string[]) {
    if (batchIds.length === 0) return new Map<string, { codes: number; redeemed: number }>();
    const rows = await this.db.giftCode.groupBy({
      by: ['batchId'],
      where: { batchId: { in: batchIds } },
      _count: { _all: true },
      _sum: { redemptions: true },
    });
    return new Map(
      rows.map((r) => [r.batchId, { codes: r._count._all, redeemed: r._sum.redemptions ?? 0 }]),
    );
  }

  #view(
    b: {
      id: string;
      name: string;
      kind: string;
      amountUsd: { toFixed(n: number): string };
      maxRedemptions: number;
      expiresAt: Date | null;
      revokedAt: Date | null;
      createdAt: Date;
    },
    stats: { codes: number; redeemed: number } | undefined,
  ) {
    const redeemed = stats?.redeemed ?? 0;
    const amount = b.amountUsd.toFixed(8);
    return {
      id: b.id,
      name: b.name,
      kind: b.kind,
      amountUsd: amount,
      maxRedemptions: b.maxRedemptions,
      expiresAt: b.expiresAt?.toISOString() ?? null,
      revokedAt: b.revokedAt?.toISOString() ?? null,
      createdAt: b.createdAt.toISOString(),
      codes: stats?.codes ?? 0,
      redemptions: redeemed,
      creditedUsd: fromUnits(BigInt(redeemed) * toUnits(amount)),
    };
  }

  // ───────────── Customer ─────────────

  async redeem(ctx: OrgContext, input: string) {
    const limiterKey = `dirouter:billing:redeem-failures:${ctx.organizationId}`;
    const failures = Number((await this.valkey.client.get(limiterKey).catch(() => null)) ?? 0);
    if (failures >= REDEEM_FAILURES_PER_HOUR)
      throw new RateLimitError({
        message: 'Too many invalid codes; try again in an hour',
        retryAfterMs: 3_600_000,
      });
    const fail = async (message: string): Promise<never> => {
      await this.valkey.client
        .multi()
        .incr(limiterKey)
        .expire(limiterKey, 3_600, 'NX')
        .exec()
        .catch(() => undefined);
      throw new DiRouterError('validation_failed', { message });
    };

    const code = normalizeCode(input);
    const found = code
      ? await this.db.giftCode.findUnique({
          where: { codeHash: this.#hash(code) },
          include: { batch: true },
        })
      : null;
    // One answer for unknown, expired, revoked and used-up codes: no hint for guessers.
    if (!found) return fail('This code is not valid');
    const org = await this.db.organization.findFirst({
      where: { id: ctx.organizationId, deletedAt: null, isPlatform: false },
      select: { id: true },
    });
    if (!org) throw new DiRouterError('validation_failed', { message: 'No wallet to credit' });
    const already = await this.db.giftCodeRedemption.findUnique({
      where: { codeId_organizationId: { codeId: found.id, organizationId: org.id } },
      select: { id: true },
    });
    if (already)
      throw new DiRouterError('conflict', { message: 'This code was already redeemed here' });
    const wallet = await this.wallets.ensure(org.id);

    const amount = found.batch.amountUsd.toFixed(8);
    type Outcome =
      { kind: 'redeemed'; wallets: WalletState[] } | { kind: 'used' } | { kind: 'already' };
    let outcome: Outcome;
    try {
      outcome = await this.db.$transaction(async (tx): Promise<Outcome> => {
        const taken = await tx.$executeRaw`
          UPDATE "gift_codes" c SET "redemptions" = c."redemptions" + 1
            FROM "gift_code_batches" b
           WHERE c."id" = ${found.id} AND b."id" = c."batch_id"
             AND c."redemptions" < b."max_redemptions" AND b."revoked_at" IS NULL
             AND (b."expires_at" IS NULL OR b."expires_at" > now())`;
        if (taken === 0) return { kind: 'used' };
        const redemptionId = prefixedId('gcr');
        const inserted = await tx.$executeRaw`
          INSERT INTO "gift_code_redemptions" ("id", "code_id", "organization_id", "transaction_id", "redeemed_by_id")
          VALUES (${redemptionId}, ${found.id}, ${org.id}, ${`pending:${redemptionId}`}, ${ctx.userId})
          ON CONFLICT ("code_id", "organization_id") DO NOTHING`;
        // Rolls back, giving the use back: this organization already has credit from this code.
        if (inserted === 0) throw new AlreadyRedeemed();
        const posted = await postInTransaction(tx, {
          kind: 'gift',
          idempotencyKey: `gift:${found.id}:${org.id}`,
          description: `${found.batch.kind === 'gift' ? 'Gift' : 'Recharge'} code ${found.hint}…`,
          createdById: ctx.userId,
          metadata: { batchId: found.batchId, codeId: found.id, redemptionId },
          legs: [
            { walletId: wallet.id, amountUsd: amount },
            {
              walletId: found.batch.kind === 'gift' ? SYSTEM_WALLETS.promo : SYSTEM_WALLETS.funding,
              amountUsd: `-${amount}`,
            },
          ],
        });
        await tx.giftCodeRedemption.update({
          where: { id: redemptionId },
          data: { transactionId: posted.transactionId },
        });
        return { kind: 'redeemed', wallets: posted.wallets };
      });
    } catch (error) {
      if (!(error instanceof AlreadyRedeemed)) throw ledgerProblem(error);
      outcome = { kind: 'already' };
    }
    if (outcome.kind === 'already')
      throw new DiRouterError('conflict', { message: 'This code was already redeemed here' });
    if (outcome.kind === 'used') return fail('This code is not valid');
    await this.wallets.mirror(outcome.wallets);
    return { amountUsd: amount, ...(await this.wallets.summary(org.id)) };
  }
}

class AlreadyRedeemed extends Error {}
