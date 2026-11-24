/**
 * Organization, members, invitations, teams, and projects (card 3.5). All queries are limited to the same organizationId
 * that the Guard has verified membership in.
 */
import { randomBytes } from 'node:crypto';

import { DiRouterError, ForbiddenError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { SessionsService } from '../auth/sessions.service.js';
import { hashInvite, slugify } from '../common/ids.js';
import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import {
  canManageMember,
  effectivePermissions,
  missingPermissions,
  type Role,
  ROLE_RANK,
} from '../rbac/permissions.js';

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

const notFound = () => new DiRouterError('not_found');

@Injectable()
export class OrgsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  async #audit(
    ctx: OrgContext,
    action: string,
    targetType: string,
    targetId: string,
    diff?: object,
  ) {
    await this.db.auditLog.create({
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

  async getOrg(ctx: OrgContext) {
    const org = await this.db.organization.findUnique({ where: { id: ctx.organizationId } });
    if (!org) throw notFound();
    return { id: org.id, name: org.name, slug: org.slug, role: ctx.role };
  }

  async renameOrg(ctx: OrgContext, name: string) {
    await this.db.organization.update({ where: { id: ctx.organizationId }, data: { name } });
    await this.#audit(ctx, 'org.updated', 'organization', ctx.organizationId, { name });
    return this.getOrg(ctx);
  }

  // ───── Members ─────
  async members(ctx: OrgContext) {
    const rows = await this.db.membership.findMany({
      // Service accounts (card 23.6) are managed on their own page.
      where: {
        organizationId: ctx.organizationId,
        user: { deletedAt: null, isServiceAccount: false },
      },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  /**
   * Rules: you cannot grant a role higher than your own; only OWNER deals with OWNERs; the last OWNER
   * remains; and nobody modifies or removes a member who is more powerful than themselves, whether by
   * base role or by the permissions of a custom role.
   */
  async #checkMemberChange(ctx: OrgContext, userId: string, newRole?: Role) {
    const target = await this.db.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
      include: {
        customRole: { select: { permissions: true } },
        user: { select: { isServiceAccount: true } },
      },
    });
    // A service account's role is changed through /service-accounts, where its tokens are managed.
    if (!target || target.user.isServiceAccount) throw notFound();
    const touchesOwner = target.role === 'OWNER' || newRole === 'OWNER';
    if (touchesOwner && ctx.role !== 'OWNER')
      throw new ForbiddenError('forbidden', { message: 'Only an owner can change owners' });
    if (newRole && ROLE_RANK[newRole] > ROLE_RANK[ctx.role])
      throw new ForbiddenError('forbidden', { message: 'Cannot grant a role above your own' });
    if (
      userId !== ctx.userId &&
      !canManageMember(
        { role: ctx.role, customPermissions: ctx.customPermissions },
        { role: target.role, customPermissions: target.customRole?.permissions },
      )
    )
      throw new ForbiddenError('forbidden', {
        message: 'Cannot change a member with more access than your own',
      });
    if (target.role === 'OWNER' && newRole !== 'OWNER') {
      const owners = await this.db.membership.count({
        where: { organizationId: ctx.organizationId, role: 'OWNER' },
      });
      if (owners <= 1)
        throw new DiRouterError('conflict', {
          message: 'The organization must keep at least one owner',
        });
    }
    return target;
  }

  async changeRole(ctx: OrgContext, userId: string, role: Role, customRoleId?: string | null) {
    const target = await this.#checkMemberChange(ctx, userId, role);
    // Nobody edits their own access: a role change always needs a second, sufficiently powerful
    // member. (Checked after the rules above so the last-owner conflict is still reported as such.)
    if (userId === ctx.userId)
      throw new ForbiddenError('forbidden', { message: 'You cannot change your own role' });
    let nextCustomRoleId = target.customRoleId;
    if (customRoleId !== undefined) {
      if (customRoleId === null) nextCustomRoleId = null;
      else {
        const custom = await this.db.customRole.findFirst({
          where: { id: customRoleId, organizationId: ctx.organizationId },
          select: { id: true, permissions: true },
        });
        if (!custom) throw notFound();
        // Assigning a custom role grants its permissions, so the actor must hold all of them.
        const missing = missingPermissions(
          effectivePermissions(ctx.role, ctx.customPermissions),
          custom.permissions,
        );
        if (missing.length > 0)
          throw new ForbiddenError('forbidden', {
            message: `Cannot assign a custom role with permissions you do not hold: ${missing.join(', ')}`,
          });
        nextCustomRoleId = custom.id;
      }
    }
    await this.db.membership.update({
      where: { id: target.id },
      data: { role, customRoleId: nextCustomRoleId },
    });
    await this.#audit(ctx, 'member.role_changed', 'user', userId, {
      from: target.role,
      to: role,
      ...(customRoleId !== undefined ? { customRoleId: nextCustomRoleId } : {}),
    });
    return { userId, role, customRoleId: nextCustomRoleId };
  }

  async removeMember(ctx: OrgContext, userId: string) {
    const target = await this.#checkMemberChange(ctx, userId);
    await this.db.membership.delete({ where: { id: target.id } });
    await this.#audit(ctx, 'member.removed', 'user', userId);
  }

  /**
   * Sessions of a member (card 23.5). Seeing where somebody is signed in, and signing them out, is
   * managing that member: the same "not above your own access" rule as role changes applies.
   */
  async #manageableMember(ctx: OrgContext, userId: string) {
    const target = await this.db.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
      include: { customRole: { select: { permissions: true } } },
    });
    if (!target) throw notFound();
    if (
      userId !== ctx.userId &&
      !canManageMember(
        { role: ctx.role, customPermissions: ctx.customPermissions },
        { role: target.role, customPermissions: target.customRole?.permissions },
      )
    )
      throw new ForbiddenError('forbidden', {
        message: 'Cannot manage a member with more access than your own',
      });
    return target;
  }

  async memberSessions(ctx: OrgContext, userId: string) {
    await this.#manageableMember(ctx, userId);
    // The administrator's own current session is not marked: `current` is about the caller.
    return this.sessions.list(userId);
  }

  /** Signs the member out everywhere: every refresh token and access token stops working. */
  async revokeMemberSessions(ctx: OrgContext, userId: string) {
    await this.#manageableMember(ctx, userId);
    const result = await this.sessions.revokeAll(userId, { audit: false });
    await this.#audit(ctx, 'member.sessions_revoked', 'user', userId, {
      sessions: result.revoked,
    });
    return result;
  }

  // ───── Invitations ─────
  async invitations(ctx: OrgContext) {
    const rows = await this.db.invitation.findMany({
      where: {
        organizationId: ctx.organizationId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt.toISOString(),
    }));
  }

  async invite(ctx: OrgContext, email: string, role: Role) {
    if (ROLE_RANK[role] > ROLE_RANK[ctx.role] || (role === 'OWNER' && ctx.role !== 'OWNER'))
      throw new ForbiddenError('forbidden', {
        message: 'Cannot invite with a role above your own',
      });
    const normalized = email.toLowerCase();
    const already = await this.db.membership.findFirst({
      where: { organizationId: ctx.organizationId, user: { email: normalized } },
    });
    if (already) throw new DiRouterError('conflict', { message: 'User is already a member' });
    // The token is shown to the inviter only once; the DB stores only its hash.
    const token = randomBytes(24).toString('base64url');
    const invitation = await this.db.invitation.create({
      data: {
        id: prefixedId('inv'),
        organizationId: ctx.organizationId,
        email: normalized,
        role,
        tokenHash: hashInvite(token),
        invitedById: ctx.userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await this.#audit(ctx, 'invitation.created', 'invitation', invitation.id, {
      email: normalized,
      role,
    });
    return {
      id: invitation.id,
      email: normalized,
      role,
      expiresAt: invitation.expiresAt.toISOString(),
      token,
      url: `${this.env.PUBLIC_DASHBOARD_URL.replace(/\/+$/, '')}/invite/${token}`,
    };
  }

  async revokeInvitation(ctx: OrgContext, id: string) {
    const r = await this.db.invitation.updateMany({
      where: { id, organizationId: ctx.organizationId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (r.count === 0) throw notFound();
    await this.#audit(ctx, 'invitation.revoked', 'invitation', id);
  }

  // ───── Teams and Projects ─────
  async teams(ctx: OrgContext) {
    return this.db.team.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true, name: true, slug: true, createdAt: true },
      orderBy: { name: 'asc' },
    });
  }

  async createTeam(ctx: OrgContext, input: { name: string; slug?: string | undefined }) {
    const team = await this.db.team.create({
      data: {
        id: prefixedId('team'),
        organizationId: ctx.organizationId,
        name: input.name,
        slug: input.slug ?? slugify(input.name),
      },
      select: { id: true, name: true, slug: true, createdAt: true },
    });
    await this.#audit(ctx, 'team.created', 'team', team.id, { name: team.name });
    return team;
  }

  async updateTeam(
    ctx: OrgContext,
    id: string,
    input: { name?: string | undefined; slug?: string | undefined },
  ) {
    await this.#own('team', ctx, id);
    const team = await this.db.team.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.slug ? { slug: input.slug } : {}),
      },
      select: { id: true, name: true, slug: true, createdAt: true },
    });
    await this.#audit(ctx, 'team.updated', 'team', id, input);
    return team;
  }

  async deleteTeam(ctx: OrgContext, id: string) {
    await this.#own('team', ctx, id);
    // soft-delete; team projects remain without a team.
    await this.db.$transaction([
      this.db.team.update({
        where: { id },
        data: { deletedAt: new Date(), slug: `deleted-${id}` },
      }),
      this.db.project.updateMany({ where: { teamId: id }, data: { teamId: null } }),
    ]);
    await this.#audit(ctx, 'team.deleted', 'team', id);
  }

  async projects(ctx: OrgContext) {
    return this.db.project.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true, name: true, slug: true, teamId: true, createdAt: true },
      orderBy: { name: 'asc' },
    });
  }

  async createProject(
    ctx: OrgContext,
    input: { name: string; slug?: string | undefined; teamId?: string | null | undefined },
  ) {
    if (input.teamId) await this.#own('team', ctx, input.teamId);
    const project = await this.db.project.create({
      data: {
        id: prefixedId('prj'),
        organizationId: ctx.organizationId,
        name: input.name,
        slug: input.slug ?? slugify(input.name),
        teamId: input.teamId ?? null,
      },
      select: { id: true, name: true, slug: true, teamId: true, createdAt: true },
    });
    await this.#audit(ctx, 'project.created', 'project', project.id, { name: project.name });
    return project;
  }

  async updateProject(
    ctx: OrgContext,
    id: string,
    input: {
      name?: string | undefined;
      slug?: string | undefined;
      teamId?: string | null | undefined;
    },
  ) {
    await this.#own('project', ctx, id);
    if (input.teamId) await this.#own('team', ctx, input.teamId);
    const project = await this.db.project.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.slug ? { slug: input.slug } : {}),
        ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
      },
      select: { id: true, name: true, slug: true, teamId: true, createdAt: true },
    });
    await this.#audit(ctx, 'project.updated', 'project', id, input);
    return project;
  }

  async deleteProject(ctx: OrgContext, id: string) {
    await this.#own('project', ctx, id);
    await this.db.project.update({
      where: { id },
      data: { deletedAt: new Date(), slug: `deleted-${id}` },
    });
    await this.#audit(ctx, 'project.deleted', 'project', id);
  }

  /** The record must belong to this organization and not be deleted; otherwise 404 (not 403). */
  async #own(kind: 'team' | 'project', ctx: OrgContext, id: string) {
    const where = { id, organizationId: ctx.organizationId, deletedAt: null };
    const found =
      kind === 'team'
        ? await this.db.team.findFirst({ where, select: { id: true } })
        : await this.db.project.findFirst({ where, select: { id: true } });
    if (!found) throw notFound();
  }
}
