/**
 * Service accounts and their management tokens (card 23.6).
 *
 * A service account is a non-human member of one organization: a user row that can never sign in
 * (`is_service_account`, no password) with a membership that carries its role and optional custom
 * role. Its tokens are scoped to permissions of the same RBAC matrix; a request is allowed only when
 * both the token's scopes and the account's current role grant the route's permission.
 */
import { DiRouterError, ForbiddenError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { requireVerifiedEmail } from '../auth/acting-human.js';
import { newManagementToken } from '../auth/management-token.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import {
  canManageMember,
  effectivePermissions,
  missingPermissions,
  type Role,
  ROLE_RANK,
} from '../rbac/permissions.js';

export type ServiceAccountRole = Exclude<Role, 'OWNER'>;

const notFound = () => new DiRouterError('not_found');

/** The backing user's address; `.invalid` is reserved (RFC 2606), so it can never receive mail. */
const serviceEmail = (id: string) => `${id}@service-accounts.invalid`;

@Injectable()
export class ServiceAccountsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  get #db() {
    return this.prisma.client;
  }

  async #audit(
    ctx: OrgContext,
    action: string,
    targetType: string,
    targetId: string,
    diff?: object,
  ) {
    await this.#db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        action,
        targetType,
        targetId,
        ...(diff ? { diff } : {}),
      },
    });
  }

  #held(ctx: OrgContext) {
    return effectivePermissions(ctx.role, ctx.customPermissions);
  }

  /** The actor may hand out the role (and custom role) only if they hold all of its permissions. */
  async #checkGrant(ctx: OrgContext, role: ServiceAccountRole, customRoleId?: string | null) {
    if (ROLE_RANK[role] > ROLE_RANK[ctx.role])
      throw new ForbiddenError('forbidden', { message: 'Cannot grant a role above your own' });
    if (!customRoleId) return null;
    const custom = await this.#db.customRole.findFirst({
      where: { id: customRoleId, organizationId: ctx.organizationId },
      select: { id: true, permissions: true },
    });
    if (!custom) throw notFound();
    const missing = missingPermissions(this.#held(ctx), custom.permissions);
    if (missing.length > 0)
      throw new ForbiddenError('forbidden', {
        message: `Cannot assign a custom role with permissions you do not hold: ${missing.join(', ')}`,
      });
    return custom.id;
  }

  async #find(ctx: OrgContext, id: string) {
    const account = await this.#db.serviceAccount.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
    });
    if (!account) throw notFound();
    const membership = await this.#db.membership.findUnique({
      where: {
        userId_organizationId: { userId: account.userId, organizationId: ctx.organizationId },
      },
      include: { customRole: { select: { permissions: true } } },
    });
    if (!membership) throw notFound();
    return { account, membership };
  }

  /** Nobody manages a service account that has more access than they do. */
  #checkManage(
    ctx: OrgContext,
    membership: { role: Role; customRole: { permissions: string[] } | null },
  ) {
    if (
      !canManageMember(
        { role: ctx.role, customPermissions: ctx.customPermissions },
        { role: membership.role, customPermissions: membership.customRole?.permissions },
      )
    )
      throw new ForbiddenError('forbidden', {
        message: 'Cannot manage a service account with more access than your own',
      });
  }

  async list(ctx: OrgContext) {
    const accounts = await this.#db.serviceAccount.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      include: {
        user: {
          select: {
            memberships: {
              where: { organizationId: ctx.organizationId },
              select: {
                role: true,
                customRoleId: true,
                customRole: { select: { permissions: true } },
              },
            },
          },
        },
        tokens: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map((account) => {
      const membership = account.user.memberships[0];
      const role = membership?.role ?? 'VIEWER';
      return {
        id: account.id,
        userId: account.userId,
        name: account.name,
        description: account.description,
        role,
        customRoleId: membership?.customRoleId ?? null,
        /** What its tokens can be scoped to: the role plus the custom role. */
        permissions: [
          ...effectivePermissions(role, membership?.customRole?.permissions ?? []),
        ].sort(),
        createdAt: account.createdAt.toISOString(),
        tokens: account.tokens.map(tokenView),
      };
    });
  }

  async create(
    ctx: OrgContext,
    input: {
      name: string;
      description?: string | undefined;
      role: ServiceAccountRole;
      customRoleId?: string | null | undefined;
    },
  ) {
    // A service account's user counts as verified, so an unverified person (a portal sign-up,
    // card 23.4) must not create one to get around the email check on API keys.
    await requireVerifiedEmail(
      this.#db,
      ctx,
      'Verify your email address before creating service accounts',
    );
    const customRoleId = await this.#checkGrant(ctx, input.role, input.customRoleId);
    const id = prefixedId('sa');
    const userId = prefixedId('usr');
    await this.#db.$transaction([
      this.#db.user.create({
        data: {
          id: userId,
          email: serviceEmail(id),
          name: input.name,
          passwordHash: '',
          isServiceAccount: true,
        },
      }),
      this.#db.membership.create({
        data: {
          id: prefixedId('mem'),
          userId,
          organizationId: ctx.organizationId,
          role: input.role,
          customRoleId,
        },
      }),
      this.#db.serviceAccount.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          userId,
          name: input.name,
          description: input.description ?? null,
          createdById: ctx.userId,
        },
      }),
    ]);
    await this.#audit(ctx, 'service_account.created', 'service_account', id, {
      name: input.name,
      role: input.role,
      customRoleId,
    });
    return (await this.list(ctx)).find((account) => account.id === id);
  }

  async update(
    ctx: OrgContext,
    id: string,
    input: {
      name?: string | undefined;
      description?: string | null | undefined;
      role?: ServiceAccountRole | undefined;
      customRoleId?: string | null | undefined;
    },
  ) {
    const { account, membership } = await this.#find(ctx, id);
    this.#checkManage(ctx, membership);
    const role = input.role ?? (membership.role as ServiceAccountRole);
    const customRoleId =
      input.customRoleId === undefined
        ? membership.customRoleId
        : await this.#checkGrant(ctx, role, input.customRoleId);
    if (input.role) await this.#checkGrant(ctx, input.role);
    await this.#db.$transaction([
      this.#db.serviceAccount.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      }),
      ...(input.name !== undefined
        ? [this.#db.user.update({ where: { id: account.userId }, data: { name: input.name } })]
        : []),
      this.#db.membership.update({ where: { id: membership.id }, data: { role, customRoleId } }),
    ]);
    await this.#audit(ctx, 'service_account.updated', 'service_account', id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role ? { from: membership.role, to: role } : {}),
      ...(input.customRoleId !== undefined ? { customRoleId } : {}),
    });
    return (await this.list(ctx)).find((item) => item.id === id);
  }

  /** Deletes the account: its membership goes, every token is revoked and the user is disabled. */
  async remove(ctx: OrgContext, id: string) {
    const { account, membership } = await this.#find(ctx, id);
    this.#checkManage(ctx, membership);
    const now = new Date();
    await this.#db.$transaction([
      this.#db.managementToken.updateMany({
        where: { serviceAccountId: id, revokedAt: null },
        data: { revokedAt: now },
      }),
      this.#db.membership.delete({ where: { id: membership.id } }),
      this.#db.serviceAccount.update({ where: { id }, data: { deletedAt: now } }),
      this.#db.user.update({
        where: { id: account.userId },
        data: { isActive: false, deletedAt: now },
      }),
    ]);
    await this.#audit(ctx, 'service_account.deleted', 'service_account', id, {
      name: account.name,
    });
  }

  /**
   * Issues a token; the secret is returned only here. Scopes must be held both by the service
   * account (otherwise they would never work) and by the actor (nobody mints access they lack).
   */
  async createToken(
    ctx: OrgContext,
    serviceAccountId: string,
    input: {
      name: string;
      scopes: string[];
      expiresInDays: number | null;
      allowedIps: string[];
    },
  ) {
    const { account, membership } = await this.#find(ctx, serviceAccountId);
    this.#checkManage(ctx, membership);
    const scopes = [...new Set(input.scopes)].sort();
    const beyondAccount = missingPermissions(
      effectivePermissions(membership.role, membership.customRole?.permissions),
      scopes,
    );
    if (beyondAccount.length > 0)
      throw new DiRouterError('validation_failed', {
        message: `The service account's role does not grant: ${beyondAccount.join(', ')}`,
      });
    const beyondActor = missingPermissions(this.#held(ctx), scopes);
    if (beyondActor.length > 0)
      throw new ForbiddenError('forbidden', {
        message: `Cannot issue scopes you do not hold: ${beyondActor.join(', ')}`,
      });
    const secret = newManagementToken();
    const id = prefixedId('mtk');
    const expiresAt =
      input.expiresInDays === null
        ? null
        : new Date(Date.now() + input.expiresInDays * 24 * 3600 * 1000);
    const row = await this.#db.managementToken.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        serviceAccountId: account.id,
        name: input.name,
        tokenHash: secret.hash,
        prefix: secret.prefix,
        scopes,
        allowedIps: input.allowedIps,
        expiresAt,
        createdById: ctx.userId,
      },
    });
    await this.#audit(ctx, 'management_token.created', 'management_token', id, {
      serviceAccountId: account.id,
      name: input.name,
      scopes,
      expiresAt: expiresAt?.toISOString() ?? null,
      allowedIps: input.allowedIps,
    });
    return { ...tokenView(row), token: secret.token };
  }

  /** Revocation takes effect on the token's next request: every request looks the token up. */
  async revokeToken(ctx: OrgContext, tokenId: string) {
    const row = await this.#db.managementToken.findFirst({
      where: { id: tokenId, organizationId: ctx.organizationId },
    });
    if (!row) throw notFound();
    const { membership } = await this.#find(ctx, row.serviceAccountId);
    this.#checkManage(ctx, membership);
    if (!row.revokedAt)
      await this.#db.managementToken.update({
        where: { id: tokenId },
        data: { revokedAt: new Date() },
      });
    await this.#audit(ctx, 'management_token.revoked', 'management_token', tokenId, {
      serviceAccountId: row.serviceAccountId,
    });
  }
}

function tokenView(row: {
  id: string;
  serviceAccountId: string;
  name: string;
  prefix: string;
  scopes: string[];
  allowedIps: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    serviceAccountId: row.serviceAccountId,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    allowedIps: row.allowedIps,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
