/**
 * سازمان، اعضا، دعوت، تیم و پروژه (کارت ۳.۵). همهٔ کوئری‌ها با organizationId همان
 * سازمانی محدود می‌شوند که Guard عضویت را در آن تأیید کرده است.
 */
import { randomBytes } from 'node:crypto';

import { DiRouterError, ForbiddenError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { hashInvite, slugify } from '../common/ids.js';
import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { type Role, ROLE_RANK } from '../rbac/permissions.js';

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

const notFound = () => new DiRouterError('not_found');

@Injectable()
export class OrgsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
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

  // ───── اعضا ─────
  async members(ctx: OrgContext) {
    const rows = await this.db.membership.findMany({
      where: { organizationId: ctx.organizationId, user: { deletedAt: null } },
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

  /** قانون‌ها: نقشی بالاتر از خودت نمی‌دهی؛ فقط OWNER با OWNERها کار دارد؛ آخرین OWNER می‌ماند. */
  async #checkMemberChange(ctx: OrgContext, userId: string, newRole?: Role) {
    const target = await this.db.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: ctx.organizationId } },
    });
    if (!target) throw notFound();
    const touchesOwner = target.role === 'OWNER' || newRole === 'OWNER';
    if (touchesOwner && ctx.role !== 'OWNER')
      throw new ForbiddenError('forbidden', { message: 'Only an owner can change owners' });
    if (newRole && ROLE_RANK[newRole] > ROLE_RANK[ctx.role])
      throw new ForbiddenError('forbidden', { message: 'Cannot grant a role above your own' });
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

  async changeRole(ctx: OrgContext, userId: string, role: Role) {
    const target = await this.#checkMemberChange(ctx, userId, role);
    await this.db.membership.update({ where: { id: target.id }, data: { role } });
    await this.#audit(ctx, 'member.role_changed', 'user', userId, { from: target.role, to: role });
    return { userId, role };
  }

  async removeMember(ctx: OrgContext, userId: string) {
    const target = await this.#checkMemberChange(ctx, userId);
    await this.db.membership.delete({ where: { id: target.id } });
    await this.#audit(ctx, 'member.removed', 'user', userId);
  }

  // ───── دعوت ─────
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
    // توکن فقط یک بار به دعوت‌کننده نشان داده می‌شود؛ در DB فقط hash آن است.
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

  // ───── تیم و پروژه ─────
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
    // soft-delete؛ پروژه‌های تیم بدون تیم می‌مانند.
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

  /** رکورد باید مال همین سازمان و حذف‌نشده باشد؛ وگرنه 404 (نه 403). */
  async #own(kind: 'team' | 'project', ctx: OrgContext, id: string) {
    const where = { id, organizationId: ctx.organizationId, deletedAt: null };
    const found =
      kind === 'team'
        ? await this.db.team.findFirst({ where, select: { id: true } })
        : await this.db.project.findFirst({ where, select: { id: true } });
    if (!found) throw notFound();
  }
}
