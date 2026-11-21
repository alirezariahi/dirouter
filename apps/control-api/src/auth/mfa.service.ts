/**
 * TOTP MFA and backup codes (card 14.1). The secret is encrypted with MASTER_KEY and bound to the
 * user id as AAD, so a copied ciphertext cannot be replayed for another account.
 *
 * Every accepted TOTP code burns its time step (no replay), and wrong codes on the endpoints that
 * weaken MFA (disable, replace) count towards the same lockout as failed logins.
 */
import { decrypt, DiRouterError, encrypt, keyVersionOf, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { LoginLimiter, LoginLockedError } from './login-limiter.js';
import {
  consumeBackupCode,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  matchTotpStep,
  otpauthUrl,
  type TotpStepStore,
  ValkeyTotpStepStore,
} from './totp.js';
import { auditUserEvent } from './user-audit.js';

export interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  backupCodesRemaining: number;
}

/** Who is asking, for the lockout counters and the audit trail. */
export interface MfaActor {
  userId: string;
  email: string;
  ip: string;
}

const PENDING_TTL_SECONDS = 10 * 60;
const pendingKey = (userId: string) => `dirouter:mfa:pending:${userId}`;

@Injectable()
export class MfaService {
  readonly #limiter: LoginLimiter;
  readonly #steps: TotpStepStore;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
  ) {
    // Same Valkey counters as AuthService: failures here and at login add up to one lockout.
    this.#limiter = new LoginLimiter(valkey.client);
    this.#steps = new ValkeyTotpStepStore(valkey.client);
  }

  async status(userId: string): Promise<MfaStatus> {
    const row = await this.prisma.client.userMfa.findUnique({ where: { userId } });
    const replacing = row?.enabled ? (await this.#pending(userId)) !== null : false;
    return {
      enabled: row?.enabled ?? false,
      pending: (row !== null && !row.enabled) || replacing,
      backupCodesRemaining: row?.backupCodeHashes.length ?? 0,
    };
  }

  /**
   * Starts enrollment; MFA is not active until `verify`. When MFA is already enabled a valid current
   * code is required, and the new secret waits in Valkey until it is confirmed: the active secret
   * keeps protecting the account in the meantime and is never overwritten by an unconfirmed one.
   */
  async begin(
    actor: MfaActor,
    currentCode?: string,
  ): Promise<{ secret: string; otpauthUrl: string }> {
    const { userId, email } = actor;
    const row = await this.prisma.client.userMfa.findUnique({ where: { userId } });
    const secret = generateTotpSecret();
    const secretEnc = encrypt(this.env.MASTER_KEY, secret, userId);
    if (row?.enabled) {
      if (!currentCode)
        throw new DiRouterError('mfa_required', {
          message: 'A current code is required to replace the authenticator',
        });
      await this.#guardedCheck(actor, currentCode);
      await this.valkey.client.set(pendingKey(userId), secretEnc, 'EX', PENDING_TTL_SECONDS);
    } else {
      await this.prisma.client.userMfa.upsert({
        where: { userId },
        create: {
          id: prefixedId('mfa'),
          userId,
          secretEnc,
          keyVersion: keyVersionOf(secretEnc),
          enabled: false,
        },
        update: { secretEnc, keyVersion: keyVersionOf(secretEnc) },
      });
    }
    return { secret, otpauthUrl: otpauthUrl({ secret, email }) };
  }

  /** Confirms the pending secret and returns the one-time backup codes. */
  async verify(actor: MfaActor, code: string): Promise<{ backupCodes: string[] }> {
    const { userId } = actor;
    const row = await this.prisma.client.userMfa.findUnique({ where: { userId } });
    const replacement = row?.enabled ? await this.#pending(userId) : null;
    if (!row || (row.enabled && !replacement))
      throw new DiRouterError('validation_failed', { message: 'MFA setup not started' });
    const secretEnc = replacement ?? row.secretEnc;
    const secret = decrypt(this.env.MASTER_KEY, secretEnc, userId);
    const step = matchTotpStep(secret, code);
    if (step === undefined || !(await this.#steps.claim(userId, step)))
      throw new DiRouterError('validation_failed', { message: 'Invalid TOTP code' });
    const backupCodes = generateBackupCodes();
    // Conditional on the state that was read: two concurrent confirmations cannot both win.
    const updated = await this.prisma.client.userMfa.updateMany({
      where: { userId, enabled: row.enabled, secretEnc: row.secretEnc },
      data: {
        secretEnc,
        keyVersion: keyVersionOf(secretEnc),
        enabled: true,
        backupCodeHashes: backupCodes.map(hashBackupCode),
      },
    });
    if (updated.count !== 1)
      throw new DiRouterError('conflict', { message: 'MFA settings changed; start again' });
    if (replacement) await this.valkey.client.del(pendingKey(userId));
    await auditUserEvent(this.prisma, {
      userId,
      action: replacement ? 'mfa.replaced' : 'mfa.enabled',
      targetType: 'user',
      targetId: userId,
      ip: actor.ip,
      diff: { method: 'totp' },
    });
    return { backupCodes };
  }

  async disable(actor: MfaActor, code: string): Promise<void> {
    const { userId } = actor;
    const row = await this.prisma.client.userMfa.findUnique({ where: { userId } });
    if (!row) return;
    if (row.enabled) await this.#guardedCheck(actor, code);
    await this.prisma.client.userMfa.delete({ where: { userId } });
    await this.valkey.client.del(pendingKey(userId)).catch(() => 0);
    if (row.enabled)
      await auditUserEvent(this.prisma, {
        userId,
        action: 'mfa.disabled',
        targetType: 'user',
        targetId: userId,
        ip: actor.ip,
        diff: { method: 'totp' },
      });
  }

  /**
   * Second-factor gate: TOTP (each time step is accepted once) or a single-use backup code (which
   * is consumed on success). Callers count a `false` as a failed attempt in the login limiter.
   */
  async check(userId: string, code: string): Promise<boolean> {
    const row = await this.prisma.client.userMfa.findUnique({ where: { userId } });
    if (!row?.enabled) return true;
    const secret = decrypt(this.env.MASTER_KEY, row.secretEnc, userId);
    const step = matchTotpStep(secret, code);
    // A code that matches but was already used is a replay; it is not tried as a backup code.
    if (step !== undefined) return this.#steps.claim(userId, step);
    const remaining = consumeBackupCode(row.backupCodeHashes, code);
    if (!remaining) return false;
    // Single use even under concurrency: the UPDATE only matches while the code is still stored, so
    // of two simultaneous logins with the same recovery code exactly one succeeds.
    const consumed = await this.prisma.client.userMfa.updateMany({
      where: { userId, backupCodeHashes: { has: hashBackupCode(code) } },
      data: { backupCodeHashes: remaining },
    });
    return consumed.count === 1;
  }

  async required(userId: string): Promise<boolean> {
    const row = await this.prisma.client.userMfa.findUnique({ where: { userId } });
    return row?.enabled ?? false;
  }

  /** `check` behind the login lockout; throws on a wrong code or while locked. */
  async #guardedCheck(actor: MfaActor, code: string): Promise<void> {
    const locked = await this.#limiter.lockedFor(actor.email, actor.ip);
    if (locked !== undefined) throw new LoginLockedError(locked);
    if (await this.check(actor.userId, code)) return;
    await this.#limiter.failure(actor.email, actor.ip);
    const now = await this.#limiter.lockedFor(actor.email, actor.ip);
    if (now !== undefined) throw new LoginLockedError(now);
    throw new DiRouterError('validation_failed', { message: 'Invalid TOTP code' });
  }

  #pending(userId: string): Promise<string | null> {
    return this.valkey.client.get(pendingKey(userId)).catch(() => null);
  }
}
