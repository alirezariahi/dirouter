/**
 * Security administration (cards 14.2-14.5): custom roles, organization security flags, the audit log
 * (read + CSV export) and MASTER_KEY rotation.
 *
 * Rotation re-encrypts every ciphertext that is bound to the old key version. All ciphertexts are bound
 * to a context with AAD (credential id, user id, or `sso:<id>`), so the AAD is rebuilt while rotating.
 */
import { decrypt, encrypt, DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import {
  effectivePermissions,
  isPermission,
  missingPermissions,
  type Permission,
  type Role,
} from '../rbac/permissions.js';

export interface CustomRoleInput {
  name: string;
  permissions: string[];
}

export interface AuditFilters {
  actorUserId?: string | undefined;
  action?: string | undefined;
  targetType?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

const ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];

const ROTATION_ATTEMPTS = 3;

interface RotationCounts {
  credentials: number;
  ssoConnections: number;
  mfaSecrets: number;
}

/** A ciphertext changed (or its row disappeared) between the read and the conditional write. */
class RotationRaceError extends Error {}

const csv = (value: unknown): string => {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

@Injectable()
export class SecurityService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get db() {
    return this.prisma.client;
  }

  // ───── Custom roles (card 14.3) ─────

  listRoles(org: OrgContext) {
    return this.db.customRole.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createRole(org: OrgContext, input: CustomRoleInput) {
    const permissions = this.#validatePermissions(input.permissions);
    this.#assertHeld(org, permissions);
    const row = await this.db.customRole.create({
      data: {
        id: prefixedId('rol'),
        organizationId: org.organizationId,
        name: input.name,
        permissions,
      },
    });
    await this.#audit(org, 'custom_role.created', 'custom_role', row.id, {
      name: row.name,
      permissions,
    });
    return row;
  }

  async updateRole(org: OrgContext, id: string, input: Partial<CustomRoleInput>) {
    const existing = await this.#roleOwned(org, id);
    // Editing a role changes the access of everyone who has it, so the editor must hold both what
    // the role grants today and what it will grant afterwards.
    this.#assertHeld(org, existing.permissions);
    const permissions =
      input.permissions === undefined ? undefined : this.#validatePermissions(input.permissions);
    if (permissions) this.#assertHeld(org, permissions);
    const row = await this.db.customRole.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
      },
    });
    await this.#audit(org, 'custom_role.updated', 'custom_role', id, {
      fields: Object.keys(input),
      ...(permissions ? { permissions, previousPermissions: existing.permissions } : {}),
    });
    return row;
  }

  async removeRole(org: OrgContext, id: string) {
    const existing = await this.#roleOwned(org, id);
    this.#assertHeld(org, existing.permissions);
    await this.db.customRole.delete({ where: { id } });
    await this.#audit(org, 'custom_role.deleted', 'custom_role', id, {
      permissions: existing.permissions,
    });
  }

  #validatePermissions(values: string[]): Permission[] {
    const unique = [...new Set(values)];
    const unknown = unique.filter((value) => !isPermission(value));
    if (unknown.length > 0)
      throw new DiRouterError('validation_failed', {
        message: `Unknown permissions: ${unknown.join(', ')}`,
      });
    return unique as Permission[];
  }

  async #roleOwned(org: OrgContext, id: string) {
    const row = await this.db.customRole.findFirst({
      where: { id, organizationId: org.organizationId },
      select: { id: true, permissions: true },
    });
    if (!row) throw new DiRouterError('not_found');
    return row;
  }

  /** A role may only contain permissions its editor holds; otherwise it is a privilege escalation. */
  #assertHeld(org: OrgContext, permissions: readonly string[]) {
    const missing = missingPermissions(
      effectivePermissions(org.role, org.customPermissions),
      permissions,
    );
    if (missing.length > 0)
      throw new DiRouterError('forbidden', {
        message: `A custom role cannot include permissions you do not hold: ${missing.join(', ')}`,
      });
  }

  // ───── Organization security flags (card 14.2) ─────

  async securitySettings(org: OrgContext) {
    const row = await this.db.organization.findUnique({
      where: { id: org.organizationId },
      select: { mfaRequiredRoles: true, passwordLoginDisabled: true, changeApprovalRequired: true },
    });
    if (!row) throw new DiRouterError('not_found');
    const connections = await this.db.ssoConnection.count({
      where: { organizationId: org.organizationId, enabled: true },
    });
    return {
      mfaRequiredRoles: row.mfaRequiredRoles,
      passwordLoginDisabled: row.passwordLoginDisabled,
      changeApprovalRequired: row.changeApprovalRequired,
      ssoEnabled: connections > 0,
    };
  }

  async updateSecuritySettings(
    org: OrgContext,
    patch: {
      mfaRequiredRoles?: string[];
      passwordLoginDisabled?: boolean;
      changeApprovalRequired?: boolean;
    },
  ) {
    if (patch.mfaRequiredRoles) {
      const invalid = patch.mfaRequiredRoles.filter((role) => !ROLES.includes(role as Role));
      if (invalid.length > 0)
        throw new DiRouterError('validation_failed', {
          message: `Unknown roles: ${invalid.join(', ')}`,
        });
    }
    if (patch.passwordLoginDisabled === true) {
      const enabled = await this.db.ssoConnection.count({
        where: { organizationId: org.organizationId, enabled: true },
      });
      if (enabled === 0)
        throw new DiRouterError('invalid_request', {
          message: 'Add an enabled SSO connection before disabling password login',
        });
    }
    await this.db.organization.update({
      where: { id: org.organizationId },
      data: {
        ...(patch.mfaRequiredRoles !== undefined
          ? { mfaRequiredRoles: patch.mfaRequiredRoles }
          : {}),
        ...(patch.passwordLoginDisabled !== undefined
          ? { passwordLoginDisabled: patch.passwordLoginDisabled }
          : {}),
        ...(patch.changeApprovalRequired !== undefined
          ? { changeApprovalRequired: patch.changeApprovalRequired }
          : {}),
      },
    });
    await this.#audit(org, 'org.security_updated', 'organization', org.organizationId, {
      fields: Object.keys(patch),
    });
    return this.securitySettings(org);
  }

  // ───── Audit log (card 14.4) ─────

  async auditLog(
    org: OrgContext,
    filters: AuditFilters,
    limit: number,
    cursor?: { createdAt: Date; id: string },
  ) {
    const rows = await this.db.auditLog.findMany({
      where: {
        organizationId: org.organizationId,
        ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
        ...(filters.action ? { action: { startsWith: filters.action } } : {}),
        ...(filters.targetType ? { targetType: filters.targetType } : {}),
        ...(filters.from || filters.to
          ? {
              createdAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lt: filters.to } : {}),
              },
            }
          : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        actorUserId: row.actorUserId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        diff: row.diff,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url')
          : null,
    };
  }

  async auditLogCsv(org: OrgContext, filters: AuditFilters): Promise<string> {
    const rows = await this.db.auditLog.findMany({
      where: {
        organizationId: org.organizationId,
        ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
        ...(filters.action ? { action: { startsWith: filters.action } } : {}),
        ...(filters.targetType ? { targetType: filters.targetType } : {}),
        ...(filters.from || filters.to
          ? {
              createdAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lt: filters.to } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50_000,
    });
    const header = 'id,createdAt,actorUserId,action,targetType,targetId,ip,diff';
    const body = rows.map((row) =>
      [
        row.id,
        row.createdAt.toISOString(),
        row.actorUserId,
        row.action,
        row.targetType,
        row.targetId,
        row.ip,
        row.diff,
      ]
        .map(csv)
        .join(','),
    );
    return [header, ...body].join('\r\n') + '\r\n';
  }

  // ───── MASTER_KEY rotation (card 14.5) ─────

  /**
   * Re-encrypts credentials, SSO client secrets and TOTP secrets with the current key.
   * Requires the old key to still be present in MASTER_KEY; if any ciphertext cannot be decrypted the
   * whole operation aborts before writing (nothing is half-rotated).
   *
   * Each write is conditional on the ciphertext that was read. A secret that somebody replaced in
   * the meantime is therefore never overwritten with its old value: the transaction rolls back and
   * the rotation is retried from a fresh read.
   */
  async rotateMasterKey(org: OrgContext) {
    if (org.role !== 'OWNER')
      throw new DiRouterError('forbidden', { message: 'Only an owner can rotate MASTER_KEY' });
    const target = this.env.MASTER_KEY.currentVersion;
    let counts: RotationCounts | undefined;
    for (let attempt = 0; attempt < ROTATION_ATTEMPTS && !counts; attempt++)
      counts = await this.#rotateOnce(target);
    if (!counts)
      throw new DiRouterError('conflict', {
        message: 'Secrets kept changing during the rotation; nothing was rotated, try again',
      });
    const rotated = counts.credentials + counts.ssoConnections + counts.mfaSecrets;
    if (rotated > 0)
      await this.#audit(org, 'security.master_key_rotated', 'organization', org.organizationId, {
        keyVersion: target,
        ...counts,
      });
    return { keyVersion: target, rotated, ...counts };
  }

  /** One read-then-write pass; undefined means a row changed in between and nothing was written. */
  async #rotateOnce(target: number): Promise<RotationCounts | undefined> {
    const db = this.db;
    const reencrypt = (ciphertext: string, aad: string) =>
      encrypt(this.env.MASTER_KEY, decrypt(this.env.MASTER_KEY, ciphertext, aad), aad);

    const credentials = (
      await db.credential.findMany({
        where: { keyVersion: { not: target } },
        select: { id: true, secretEnc: true },
      })
    ).map((row) => ({ id: row.id, old: row.secretEnc, next: reencrypt(row.secretEnc, row.id) }));

    const connections = (
      await db.ssoConnection.findMany({
        where: { keyVersion: { not: target } },
        select: { id: true, clientSecretEnc: true },
      })
    ).map((row) => ({
      id: row.id,
      old: row.clientSecretEnc,
      next: reencrypt(row.clientSecretEnc, `sso:${row.id}`),
    }));

    const mfa = (
      await db.userMfa.findMany({
        where: { keyVersion: { not: target } },
        select: { id: true, userId: true, secretEnc: true },
      })
    ).map((row) => ({
      id: row.id,
      old: row.secretEnc,
      next: reencrypt(row.secretEnc, row.userId),
    }));

    const counts: RotationCounts = {
      credentials: credentials.length,
      ssoConnections: connections.length,
      mfaSecrets: mfa.length,
    };
    if (credentials.length + connections.length + mfa.length === 0) return counts;

    try {
      await db.$transaction(async (tx) => {
        const expectOne = (result: { count: number }) => {
          if (result.count !== 1) throw new RotationRaceError();
        };
        for (const row of credentials)
          expectOne(
            await tx.credential.updateMany({
              where: { id: row.id, secretEnc: row.old },
              data: { secretEnc: row.next, keyVersion: target },
            }),
          );
        for (const row of connections)
          expectOne(
            await tx.ssoConnection.updateMany({
              where: { id: row.id, clientSecretEnc: row.old },
              data: { clientSecretEnc: row.next, keyVersion: target },
            }),
          );
        for (const row of mfa)
          expectOne(
            await tx.userMfa.updateMany({
              where: { id: row.id, secretEnc: row.old },
              data: { secretEnc: row.next, keyVersion: target },
            }),
          );
      });
    } catch (error) {
      if (error instanceof RotationRaceError) return undefined;
      throw error;
    }
    return counts;
  }

  async #audit(
    org: OrgContext,
    action: string,
    targetType: string,
    targetId: string,
    diff?: object,
  ) {
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org.organizationId,
        actorUserId: org.userId,
        ...(org.ip ? { ip: org.ip } : {}),
        action,
        targetType,
        targetId,
        ...(diff ? { diff: diff as never } : {}),
      },
    });
  }
}
