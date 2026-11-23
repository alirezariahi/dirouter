/**
 * SCIM 2.0 provisioning (card 22.1, RFC 7643/7644): the organization's identity provider creates,
 * updates and removes its users and groups here.
 *
 * - A user's role follows their groups through the SSO connection's group→role map (the default
 *   role when no group matches). OWNER is never assigned, and owners are never changed or removed.
 * - Deactivating (`active: false`) or deleting a user removes their membership and revokes the API
 *   keys they created in this organization. An account left with no organization is disabled and
 *   its sessions revoked. Reactivation restores the membership.
 * - The identity provider only speaks for its organization: an account that exists outside it is
 *   not adopted (409), as with SSO sign-in.
 */
import { createHash, randomBytes } from 'node:crypto';

import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { hashPassword } from '../auth/crypto.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { Role } from '../rbac/permissions.js';
import { resolveSsoRole } from '../security/sso-policy.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';
import { SCHEMAS, ScimError } from './errors.js';
import { matchesFilter, parseFilter } from './filter.js';

export const hashScimToken = (token: string) => createHash('sha256').update(token).digest('hex');

type Db = PrismaService['client'];
type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

interface UserInput {
  userName?: string;
  externalId?: string | null;
  active?: boolean;
  displayName?: string;
  givenName?: string;
  familyName?: string;
  email?: string;
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The fields DiRouter keeps from a SCIM User body. */
export function userInput(body: unknown): UserInput {
  const b = record(body);
  const name = record(b.name);
  const emails = Array.isArray(b.emails) ? b.emails.map(record) : [];
  const email = str((emails.find((e) => e.primary === true) ?? emails[0])?.value);
  const out: UserInput = {};
  if (str(b.userName)) out.userName = str(b.userName);
  if ('externalId' in b) out.externalId = str(b.externalId) ?? null;
  if (typeof b.active === 'boolean') out.active = b.active;
  if (str(b.displayName)) out.displayName = str(b.displayName);
  if (str(name.givenName)) out.givenName = str(name.givenName);
  if (str(name.familyName)) out.familyName = str(name.familyName);
  if (email) out.email = email;
  return out;
}

/**
 * PATCH operations on a User as a partial input. Supports the forms Okta, Entra ID and Keycloak
 * extensions send: `replace` with a path (`active`, `userName`, `name.givenName`, …) or with an
 * object value.
 */
export function userPatch(body: unknown): UserInput {
  const ops = Array.isArray(record(body).Operations) ? (record(body).Operations as unknown[]) : [];
  const out: UserInput = {};
  for (const raw of ops) {
    const op = record(raw);
    const kind = str(op.op)?.toLowerCase();
    if (kind !== 'replace' && kind !== 'add') continue;
    const path = str(op.path);
    const value = op.value;
    const merged: Record<string, unknown> = path
      ? path.includes('.')
        ? { [path.split('.')[0] ?? '']: { [path.split('.')[1] ?? '']: value } }
        : { [path]: value }
      : record(value);
    // Entra ID sends booleans as strings.
    if (merged.active === 'True' || merged.active === 'true') merged.active = true;
    if (merged.active === 'False' || merged.active === 'false') merged.active = false;
    Object.assign(out, userInput(merged));
  }
  return out;
}

@Injectable()
export class ScimService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  // ───────────── Tokens ─────────────

  async organizationFor(token: string): Promise<string> {
    const row = await this.db.scimToken.findUnique({ where: { tokenHash: hashScimToken(token) } });
    if (!row || row.revokedAt) throw new DiRouterError('unauthenticated');
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000)
      await this.db.scimToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
    return row.organizationId;
  }

  async listTokens(organizationId: string) {
    const rows = await this.db.scimToken.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      revokedAt: t.revokedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  async createToken(organizationId: string, userId: string, name: string) {
    const token = `scim_${randomBytes(32).toString('base64url')}`;
    const id = prefixedId('sct');
    await this.db.$transaction([
      this.db.scimToken.create({
        data: {
          id,
          organizationId,
          name,
          tokenHash: hashScimToken(token),
          prefix: token.slice(0, 12),
          createdById: userId,
        },
      }),
      this.#audit(organizationId, userId, 'scim.token_created', 'scim_token', id, { name }),
    ]);
    return { id, name, token };
  }

  async revokeToken(organizationId: string, userId: string, id: string) {
    const row = await this.db.scimToken.findFirst({ where: { id, organizationId } });
    if (!row) throw new DiRouterError('not_found');
    if (!row.revokedAt)
      await this.db.$transaction([
        this.db.scimToken.update({ where: { id }, data: { revokedAt: new Date() } }),
        this.#audit(organizationId, userId, 'scim.token_revoked', 'scim_token', id),
      ]);
  }

  // ───────────── Users ─────────────

  async #loadUser(organizationId: string, id: string) {
    const row = await this.db.scimUser.findFirst({
      where: { id, organizationId },
      include: { groups: { include: { group: true } } },
    });
    if (!row) throw new ScimError(404, `User ${id} not found`);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: row.userId } });
    return { row, user };
  }

  userResource(
    base: string,
    { row, user }: Awaited<ReturnType<ScimService['loadUserForView']>>,
  ): Record<string, unknown> {
    return {
      schemas: [SCHEMAS.user],
      id: row.id,
      ...(row.externalId ? { externalId: row.externalId } : {}),
      userName: row.userName,
      name: { formatted: user.name },
      displayName: user.name,
      emails: [{ value: user.email, type: 'work', primary: true }],
      active: row.active,
      groups: row.groups.map((m) => ({ value: m.group.id, display: m.group.displayName })),
      meta: {
        resourceType: 'User',
        created: row.createdAt.toISOString(),
        lastModified: row.updatedAt.toISOString(),
        location: `${base}/Users/${row.id}`,
      },
    };
  }

  loadUserForView(organizationId: string, id: string) {
    return this.#loadUser(organizationId, id);
  }

  async listUsers(organizationId: string, base: string, query: Record<string, unknown>) {
    const filter = parseFilter(str(query.filter));
    const rows = await this.db.scimUser.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: { groups: { include: { group: true } } },
    });
    const users = await this.db.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } } });
    const byId = new Map(users.map((u) => [u.id, u]));
    const all = rows
      .map((row) => ({ row, user: byId.get(row.userId) }))
      .filter((x): x is { row: (typeof rows)[number]; user: NonNullable<typeof x.user> } =>
        Boolean(x.user),
      )
      .map((x) => this.userResource(base, x))
      .filter((resource) => matchesFilter(resource, filter));
    return this.#page(all, query);
  }

  #page(resources: Record<string, unknown>[], query: Record<string, unknown>) {
    const startIndex = Math.max(1, Number(query.startIndex) || 1);
    const count = Math.min(200, Math.max(0, Number(query.count ?? 100) || 0));
    const page = resources.slice(startIndex - 1, startIndex - 1 + count);
    return {
      schemas: [SCHEMAS.list],
      totalResults: resources.length,
      startIndex,
      itemsPerPage: page.length,
      Resources: page,
    };
  }

  /** The role a user's groups give them (default role of the first enabled SSO connection). */
  async #roleFor(tx: Tx, organizationId: string, scimUserId: string): Promise<Role> {
    const connection = await tx.ssoConnection.findFirst({
      where: { organizationId, enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    const groups = await tx.scimGroupMember.findMany({
      where: { scimUserId },
      include: { group: true },
    });
    return resolveSsoRole(
      (connection?.groupRoleMap ?? {}) as Record<string, unknown>,
      groups.map((g) => g.group.displayName),
      connection?.defaultRole ?? 'MEMBER',
    ).role;
  }

  async createUser(organizationId: string, body: unknown) {
    const input = userInput(body);
    if (!input.userName) throw new ScimError(400, 'userName is required', 'invalidValue');
    const email = (input.email ?? input.userName).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new ScimError(400, 'an email address is required (emails or userName)', 'invalidValue');
    if (await this.db.scimUser.findFirst({ where: { organizationId, userName: input.userName } }))
      throw new ScimError(409, `userName ${input.userName} already exists`, 'uniqueness');

    const id = prefixedId('scu');
    const name =
      input.displayName ??
      ([input.givenName, input.familyName].filter(Boolean).join(' ') ||
        email.split('@')[0] ||
        email);
    const active = input.active ?? true;
    await this.db.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email } });
      if (user) {
        const member = await tx.membership.findUnique({
          where: { userId_organizationId: { userId: user.id, organizationId } },
        });
        if (!member)
          throw new ScimError(
            409,
            'An account with this email exists outside this organization; invite it instead',
            'uniqueness',
          );
      } else {
        user = await tx.user.create({
          data: {
            id: prefixedId('usr'),
            email,
            name: name.slice(0, 100),
            // Provisioned users sign in through SSO; the random hash is never usable.
            passwordHash: await hashPassword(randomBytes(32).toString('hex')),
          },
        });
      }
      await tx.scimUser.create({
        data: {
          id,
          organizationId,
          userId: user.id,
          userName: input.userName ?? email,
          externalId: input.externalId ?? null,
          active,
        },
      });
      await this.#applyMembership(tx, organizationId, id, active);
      await tx.auditLog.create({
        data: this.#auditData(organizationId, 'scim.user_created', 'user', user.id, {
          scimId: id,
          userName: input.userName,
          active,
        }),
      });
    });
    return id;
  }

  /** PUT replaces the attributes DiRouter keeps; PATCH applies only the given ones. */
  async updateUser(organizationId: string, id: string, input: UserInput) {
    const { row, user } = await this.#loadUser(organizationId, id);
    if (input.userName && input.userName !== row.userName) {
      const taken = await this.db.scimUser.findFirst({
        where: { organizationId, userName: input.userName, NOT: { id } },
      });
      if (taken)
        throw new ScimError(409, `userName ${input.userName} already exists`, 'uniqueness');
    }
    const name =
      input.displayName ??
      ([input.givenName, input.familyName].filter(Boolean).join(' ') || undefined);
    await this.db.$transaction(async (tx) => {
      await tx.scimUser.update({
        where: { id },
        data: {
          ...(input.userName ? { userName: input.userName } : {}),
          ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      if (name)
        await tx.user.update({ where: { id: user.id }, data: { name: name.slice(0, 100) } });
      if (input.active !== undefined && input.active !== row.active)
        await this.#applyMembership(tx, organizationId, id, input.active);
    });
    this.snapshots.schedule('scim user update');
  }

  async deleteUser(organizationId: string, id: string) {
    const { row } = await this.#loadUser(organizationId, id);
    await this.db.$transaction(async (tx) => {
      if (row.active) await this.#applyMembership(tx, organizationId, id, false);
      await tx.scimUser.delete({ where: { id } });
      await tx.auditLog.create({
        data: this.#auditData(organizationId, 'scim.user_deleted', 'user', row.userId, {
          scimId: id,
          userName: row.userName,
        }),
      });
    });
    this.snapshots.schedule('scim user delete');
  }

  /**
   * Makes the membership follow `active`. Deactivation removes it, revokes the user's keys in the
   * organization, and disables an account left without any organization. Owners are not managed
   * through SCIM.
   */
  async #applyMembership(tx: Tx, organizationId: string, scimUserId: string, active: boolean) {
    const scimUser = await tx.scimUser.findUniqueOrThrow({ where: { id: scimUserId } });
    const userId = scimUser.userId;
    const membership = await tx.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
    if (membership?.role === 'OWNER') {
      if (!active)
        throw new ScimError(
          409,
          'Organization owners cannot be deactivated through SCIM',
          'mutability',
        );
      return;
    }
    if (active) {
      const role = await this.#roleFor(tx, organizationId, scimUserId);
      if (membership) {
        if (membership.role !== role)
          await tx.membership.update({ where: { id: membership.id }, data: { role } });
      } else
        await tx.membership.create({
          data: { id: prefixedId('mem'), userId, organizationId, role },
        });
      await tx.user.update({ where: { id: userId }, data: { isActive: true } });
      await tx.scimUser.update({ where: { id: scimUserId }, data: { role } });
      return;
    }
    if (membership) await tx.membership.delete({ where: { id: membership.id } });
    const now = new Date();
    const revoked = await tx.apiKey.updateMany({
      where: { organizationId, createdById: userId, status: { not: 'REVOKED' } },
      data: { status: 'REVOKED', revokedAt: now },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    const elsewhere = await tx.membership.count({ where: { userId } });
    if (elsewhere === 0) await tx.user.update({ where: { id: userId }, data: { isActive: false } });
    await tx.auditLog.create({
      data: this.#auditData(organizationId, 'scim.user_deactivated', 'user', userId, {
        scimId: scimUserId,
        revokedKeys: revoked.count,
        accountDisabled: elsewhere === 0,
      }),
    });
  }

  // ───────────── Groups ─────────────

  async #loadGroup(organizationId: string, id: string) {
    const row = await this.db.scimGroup.findFirst({
      where: { id, organizationId },
      include: { members: { include: { user: true } } },
    });
    if (!row) throw new ScimError(404, `Group ${id} not found`);
    return row;
  }

  groupResource(base: string, row: Awaited<ReturnType<ScimService['loadGroupForView']>>) {
    return {
      schemas: [SCHEMAS.group],
      id: row.id,
      ...(row.externalId ? { externalId: row.externalId } : {}),
      displayName: row.displayName,
      members: row.members.map((m) => ({
        value: m.user.id,
        display: m.user.userName,
        type: 'User',
      })),
      meta: {
        resourceType: 'Group',
        created: row.createdAt.toISOString(),
        lastModified: row.updatedAt.toISOString(),
        location: `${base}/Groups/${row.id}`,
      },
    };
  }

  loadGroupForView(organizationId: string, id: string) {
    return this.#loadGroup(organizationId, id);
  }

  async listGroups(organizationId: string, base: string, query: Record<string, unknown>) {
    const filter = parseFilter(str(query.filter));
    const rows = await this.db.scimGroup.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: { members: { include: { user: true } } },
    });
    const all = rows
      .map((row) => this.groupResource(base, row))
      .filter((resource) => matchesFilter(resource, filter));
    // `excludedAttributes=members` keeps large groups cheap for clients that ask for it.
    if (str(query.excludedAttributes)?.includes('members'))
      for (const g of all) delete (g as { members?: unknown }).members;
    return this.#page(all, query);
  }

  /** Member IDs from SCIM `members` values (User IDs of this organization only). */
  async #memberIds(tx: Tx, organizationId: string, members: unknown): Promise<string[]> {
    const ids = (Array.isArray(members) ? members : [])
      .map((m) => str(record(m).value))
      .filter((v): v is string => Boolean(v));
    if (ids.length === 0) return [];
    const found = await tx.scimUser.findMany({ where: { organizationId, id: { in: ids } } });
    if (found.length !== new Set(ids).size)
      throw new ScimError(400, 'members must be users of this organization', 'invalidValue');
    return found.map((u) => u.id);
  }

  /** Recomputes the roles of the users whose groups changed. */
  async #syncRoles(tx: Tx, organizationId: string, scimUserIds: Iterable<string>) {
    for (const id of new Set(scimUserIds)) {
      const scimUser = await tx.scimUser.findUnique({ where: { id } });
      if (scimUser?.active) await this.#applyMembership(tx, organizationId, id, true);
    }
  }

  async createGroup(organizationId: string, body: unknown) {
    const b = record(body);
    const displayName = str(b.displayName)?.trim();
    if (!displayName) throw new ScimError(400, 'displayName is required', 'invalidValue');
    if (await this.db.scimGroup.findFirst({ where: { organizationId, displayName } }))
      throw new ScimError(409, `Group ${displayName} already exists`, 'uniqueness');
    const id = prefixedId('scg');
    await this.db.$transaction(async (tx) => {
      const members = await this.#memberIds(tx, organizationId, b.members);
      await tx.scimGroup.create({
        data: {
          id,
          organizationId,
          displayName,
          externalId: str(b.externalId) ?? null,
          members: { create: members.map((scimUserId) => ({ scimUserId })) },
        },
      });
      await this.#syncRoles(tx, organizationId, members);
    });
    return id;
  }

  async replaceGroup(organizationId: string, id: string, body: unknown) {
    const current = await this.#loadGroup(organizationId, id);
    const b = record(body);
    await this.db.$transaction(async (tx) => {
      const members = await this.#memberIds(tx, organizationId, b.members);
      await tx.scimGroupMember.deleteMany({ where: { groupId: id } });
      await tx.scimGroup.update({
        where: { id },
        data: {
          ...(str(b.displayName) ? { displayName: str(b.displayName) } : {}),
          ...('externalId' in b ? { externalId: str(b.externalId) ?? null } : {}),
          members: { create: members.map((scimUserId) => ({ scimUserId })) },
        },
      });
      await this.#syncRoles(tx, organizationId, [
        ...members,
        ...current.members.map((m) => m.scimUserId),
      ]);
    });
    this.snapshots.schedule('scim group update');
  }

  /** PATCH: add/remove/replace members, replace displayName or externalId. */
  async patchGroup(organizationId: string, id: string, body: unknown) {
    const current = await this.#loadGroup(organizationId, id);
    const ops = Array.isArray(record(body).Operations)
      ? (record(body).Operations as unknown[]).map(record)
      : [];
    const touched = new Set<string>();
    await this.db.$transaction(async (tx) => {
      for (const op of ops) {
        const kind = str(op.op)?.toLowerCase();
        const path = str(op.path) ?? '';
        if (path === 'members' || (path === '' && 'members' in record(op.value))) {
          const value = path === '' ? record(op.value).members : op.value;
          const ids = await this.#memberIds(tx, organizationId, value);
          if (kind === 'replace') {
            for (const m of current.members) touched.add(m.scimUserId);
            await tx.scimGroupMember.deleteMany({ where: { groupId: id } });
          }
          if (kind === 'remove')
            await tx.scimGroupMember.deleteMany({
              where: { groupId: id, scimUserId: { in: ids } },
            });
          else
            await tx.scimGroupMember.createMany({
              data: ids.map((scimUserId) => ({ groupId: id, scimUserId })),
              skipDuplicates: true,
            });
          for (const i of ids) touched.add(i);
          continue;
        }
        // remove with a filter: members[value eq "scu_..."]
        const removeOne = /^members\[value eq "([^"]+)"\]$/i.exec(path);
        if (kind === 'remove' && removeOne?.[1]) {
          await tx.scimGroupMember.deleteMany({ where: { groupId: id, scimUserId: removeOne[1] } });
          touched.add(removeOne[1]);
          continue;
        }
        if (kind === 'remove' && path === 'members') continue;
        const value = path ? { [path]: op.value } : record(op.value);
        const displayName = str(value.displayName);
        if (displayName) await tx.scimGroup.update({ where: { id }, data: { displayName } });
        if ('externalId' in value)
          await tx.scimGroup.update({
            where: { id },
            data: { externalId: str(value.externalId) ?? null },
          });
      }
      await this.#syncRoles(tx, organizationId, touched);
    });
    this.snapshots.schedule('scim group update');
  }

  async deleteGroup(organizationId: string, id: string) {
    const current = await this.#loadGroup(organizationId, id);
    await this.db.$transaction(async (tx) => {
      await tx.scimGroup.delete({ where: { id } });
      await this.#syncRoles(
        tx,
        organizationId,
        current.members.map((m) => m.scimUserId),
      );
    });
  }

  // ───────────── Audit ─────────────

  #auditData(
    organizationId: string,
    action: string,
    targetType: string,
    targetId: string,
    diff?: object,
  ) {
    return {
      id: prefixedId('aud'),
      organizationId,
      action,
      targetType,
      targetId,
      ...(diff ? { diff: diff as never } : {}),
    };
  }

  #audit(
    organizationId: string,
    userId: string,
    action: string,
    targetType: string,
    targetId: string,
    diff?: object,
  ) {
    return this.db.auditLog.create({
      data: {
        ...this.#auditData(organizationId, action, targetType, targetId, diff),
        actorUserId: userId,
      },
    });
  }
}
