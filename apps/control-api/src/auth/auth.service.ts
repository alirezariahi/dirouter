/**
 * Dashboard authentication (card 3.4): setup wizard, login, refresh token rotation with reuse detection,
 * logout, and password change.
 */
import { AuthenticationError, DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { MailService } from '../infra/mail.service.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import {
  ACCESS_TTL_SECONDS,
  familyOrigin,
  hashPassword,
  newFamilyId,
  REFRESH_TTL_SECONDS,
  TokenService,
  verifyPassword,
} from './crypto.js';
import { hashInvite, slugify } from '../common/ids.js';
import { LoginLimiter, LoginLockedError } from './login-limiter.js';
import { MfaService } from './mfa.service.js';
import { effectivePermissions } from '../rbac/permissions.js';

export interface ClientInfo {
  ip: string;
  userAgent: string | undefined;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: { id: string; email: string; name: string };
}

const SETUP_LOCK = 482_902;

@Injectable()
export class AuthService {
  readonly tokens: TokenService;
  readonly limiter: LoginLimiter;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) valkey: ValkeyService,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(MailService) private readonly mail: MailService,
  ) {
    this.tokens = new TokenService(env.JWT_SECRET);
    this.limiter = new LoginLimiter(valkey.client);
  }

  async setupRequired(): Promise<boolean> {
    return (await this.prisma.client.user.count()) === 0;
  }

  /**
   * Only when there are no users. An advisory lock prevents two concurrent setups; after
   * the first user, `setup_completed` is always returned.
   */
  async setup(
    input: { organizationName: string; name: string; email: string; password: string },
    client: ClientInfo,
  ): Promise<Session> {
    const passwordHash = await hashPassword(input.password);
    const email = input.email.toLowerCase();
    const user = await this.prisma.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${SETUP_LOCK})`;
      if ((await tx.user.count()) > 0) throw new DiRouterError('setup_completed');
      const org = await tx.organization.create({
        data: {
          id: prefixedId('org'),
          name: input.organizationName,
          slug: slugify(input.organizationName),
          // The setup organization is the operator's (sprint 3 billing).
          isPlatform: true,
        },
      });
      const created = await tx.user.create({
        data: { id: prefixedId('usr'), email, name: input.name, passwordHash },
      });
      await tx.membership.create({
        data: { id: prefixedId('mem'), userId: created.id, organizationId: org.id, role: 'OWNER' },
      });
      await tx.auditLog.create({
        data: {
          id: prefixedId('aud'),
          organizationId: org.id,
          actorUserId: created.id,
          action: 'setup.completed',
          targetType: 'organization',
          targetId: org.id,
          ip: client.ip,
        },
      });
      return created;
    });
    return this.#issue(user, prefixedId('fam'), client);
  }

  async login(
    email: string,
    password: string,
    client: ClientInfo,
    mfaCode?: string,
  ): Promise<Session> {
    const normalized = email.toLowerCase();
    const locked = await this.limiter.lockedFor(normalized, client.ip);
    if (locked !== undefined) throw lockedError(locked);
    const user = await this.prisma.client.user.findUnique({ where: { email: normalized } });
    const ok = await verifyPassword(user?.passwordHash, password);
    // A service account (card 23.6) has no password and can never sign in.
    if (!user || !ok || !user.isActive || user.deletedAt || user.isServiceAccount) {
      await this.limiter.failure(normalized, client.ip);
      // The tenth failure itself activates the lock.
      const now = await this.limiter.lockedFor(normalized, client.ip);
      if (now !== undefined) throw lockedError(now);
      throw new AuthenticationError('invalid_credentials');
    }
    if (await this.#passwordLoginDisabled(user.id)) {
      throw new DiRouterError('sso_required', {
        message: 'Password login is disabled for this organization; use single sign-on',
      });
    }
    if (await this.mfa.required(user.id)) {
      if (!mfaCode)
        throw new DiRouterError('mfa_required', {
          message: 'A second factor is required',
        });
      if (!(await this.mfa.check(user.id, mfaCode))) {
        // A wrong (or replayed) code counts like a wrong password: six digits must not be guessable
        // by whoever already knows the password.
        await this.limiter.failure(normalized, client.ip);
        const now = await this.limiter.lockedFor(normalized, client.ip);
        if (now !== undefined) throw lockedError(now);
        throw new AuthenticationError('invalid_credentials', {
          message: 'Invalid second factor',
        });
      }
    }
    await this.limiter.success(normalized);
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return this.#issue(user, prefixedId('fam'), client);
  }

  /**
   * Rotation: the current token is marked "used" and a new token is issued in the same family.
   * Presenting an already-used token means it was stolen: the whole family (all devices of that
   * session) is revoked and both sides must sign in again.
   */
  async refresh(token: string | undefined, client: ClientInfo): Promise<Session> {
    if (!token) throw new AuthenticationError('unauthenticated');
    const db = this.prisma.client;
    const row = await db.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefresh(token) },
    });
    if (!row) throw new AuthenticationError('unauthenticated');
    if (row.usedAt || row.revokedAt) {
      await this.#revokeFamily(row.familyId);
      throw new AuthenticationError('refresh_token_reused');
    }
    if (row.expiresAt.getTime() <= Date.now()) throw new AuthenticationError('unauthenticated');
    // The usedAt=null condition in the UPDATE itself: of two concurrent refreshes with one token, only one wins.
    const claimed = await db.refreshToken.updateMany({
      where: { id: row.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      await this.#revokeFamily(row.familyId);
      throw new AuthenticationError('refresh_token_reused');
    }
    const user = await db.user.findUnique({ where: { id: row.userId } });
    if (!user?.isActive || user.deletedAt) {
      await this.#revokeFamily(row.familyId);
      throw new AuthenticationError('unauthenticated');
    }
    return this.#issue(user, row.familyId, client);
  }

  /**
   * Accepting an invitation: if a user with the same email exists, that user's password is required (an account must not be taken over via the link
   * ); otherwise a new user is created with a name and password. The link is single-use.
   */
  async acceptInvitation(
    input: {
      token: string;
      name?: string | undefined;
      password: string;
      mfaCode?: string | undefined;
    },
    client: ClientInfo,
  ): Promise<Session> {
    const db = this.prisma.client;
    const invite = await db.invitation.findUnique({
      where: { tokenHash: hashInvite(input.token) },
    });
    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      invite.expiresAt.getTime() <= Date.now()
    )
      throw new DiRouterError('not_found', { message: 'Invitation is invalid or expired' });
    const existing = await db.user.findUnique({ where: { email: invite.email } });
    if (existing) {
      // This path issues a session for an existing account, so it is guarded exactly like login:
      // the same lockout and, when the account has MFA, the same second factor.
      const locked = await this.limiter.lockedFor(existing.email, client.ip);
      if (locked !== undefined) throw lockedError(locked);
      const fail = async (message?: string) => {
        await this.limiter.failure(existing.email, client.ip);
        return new AuthenticationError('invalid_credentials', message ? { message } : {});
      };
      if (
        !existing.isActive ||
        existing.deletedAt ||
        !(await verifyPassword(existing.passwordHash, input.password))
      )
        throw await fail();
      if (await this.mfa.required(existing.id)) {
        if (!input.mfaCode)
          throw new DiRouterError('mfa_required', { message: 'A second factor is required' });
        if (!(await this.mfa.check(existing.id, input.mfaCode)))
          throw await fail('Invalid second factor');
      }
    }
    if (!existing && !input.name)
      throw new DiRouterError('validation_failed', {
        message: 'name is required for a new account',
      });
    const passwordHash = existing ? undefined : await hashPassword(input.password);
    // The inviter gets the link back as well, so accepting it proves the address only when it was
    // delivered there by email. Without SMTP no address can ever be verified; then a verified
    // inviter vouches for the invitee, as before.
    const emailVerifiedAt = existing
      ? undefined
      : (await this.#invitationProvesEmail(invite))
        ? new Date()
        : null;
    const user = await db.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1)
        throw new DiRouterError('not_found', { message: 'Invitation is invalid or expired' });
      const u =
        existing ??
        (await tx.user.create({
          data: {
            id: prefixedId('usr'),
            email: invite.email,
            name: input.name ?? '',
            passwordHash: passwordHash ?? '',
            emailVerifiedAt: emailVerifiedAt ?? null,
          },
        }));
      await tx.membership.upsert({
        where: { userId_organizationId: { userId: u.id, organizationId: invite.organizationId } },
        create: {
          id: prefixedId('mem'),
          userId: u.id,
          organizationId: invite.organizationId,
          role: invite.role,
        },
        update: {},
      });
      await tx.auditLog.create({
        data: {
          id: prefixedId('aud'),
          organizationId: invite.organizationId,
          actorUserId: u.id,
          action: 'invitation.accepted',
          targetType: 'invitation',
          targetId: invite.id,
          ip: client.ip,
        },
      });
      return u;
    });
    return this.#issue(user, prefixedId('fam'), client);
  }

  async #invitationProvesEmail(invite: {
    emailSentAt: Date | null;
    invitedById: string;
  }): Promise<boolean> {
    if (invite.emailSentAt) return true;
    if (this.mail.enabled) return false;
    const inviter = await this.prisma.client.user.findUnique({
      where: { id: invite.invitedById },
      select: { emailVerifiedAt: true },
    });
    return Boolean(inviter?.emailVerifiedAt);
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const row = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefresh(token) },
    });
    if (row) await this.#revokeFamily(row.familyId);
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const db = this.prisma.client;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user || !(await verifyPassword(user.passwordHash, current)))
      throw new AuthenticationError('invalid_credentials');
    await db.$transaction([
      db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next) } }),
      // All sessions (other devices) are revoked; access tokens remain valid for at most 15 minutes.
      db.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  /** `onlyOrganizationId` is set for SSO sessions, which are valid in a single organization. */
  async me(userId: string, onlyOrganizationId?: string) {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      include: { memberships: { include: { organization: true, customRole: true } } },
    });
    if (!user || user.deletedAt) throw new AuthenticationError('unauthenticated');
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      // False only for a portal password sign-up that has not opened its link (card 23.4).
      emailVerified: user.emailVerifiedAt !== null,
      organizations: user.memberships
        .filter((m) => onlyOrganizationId === undefined || m.organizationId === onlyOrganizationId)
        .map((m) => ({
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          role: m.role,
          // Effective permissions (base role plus custom role) so the dashboard shows exactly
          // the controls the server will accept (card 14.3).
          permissions: [...effectivePermissions(m.role, m.customRole?.permissions ?? [])].sort(),
          isPlatform: m.organization.isPlatform,
        })),
    };
  }

  async #revokeFamily(familyId: string): Promise<void> {
    await this.prisma.client.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** New session after a passkey login; the method ends up in the `amr` claim. */
  async sessionFor(userId: string, client: ClientInfo, method: 'passkey'): Promise<Session> {
    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!user?.isActive || user.deletedAt) throw new AuthenticationError('unauthenticated');
    return this.#issue(user, newFamilyId({ amr: method }), client);
  }

  /**
   * Password login is disabled when the user belongs to an organization that enforces SSO and has an
   * enabled connection (card 14.2). Users who belong only to organizations without SSO keep password login.
   */
  async #passwordLoginDisabled(userId: string): Promise<boolean> {
    const row = await this.prisma.client.membership.findFirst({
      where: {
        userId,
        organization: {
          deletedAt: null,
          passwordLoginDisabled: true,
          ssoConnections: { some: { enabled: true } },
        },
      },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Issue a session for a user authenticated by an organization's identity provider (OIDC SSO, card
   * 14.2). The session is bound to that organization: an identity provider only vouches for its own
   * organization, so the token must not open the user's other organizations.
   */
  issueSsoSession(
    user: { id: string; email: string; name: string },
    organizationId: string,
    client: ClientInfo,
  ): Promise<Session> {
    return this.#issue(user, newFamilyId({ amr: 'sso', org: organizationId }), client);
  }

  /** Session for a user who just proved their password some other way (portal sign-up, card 19.5). */
  issueSession(user: { id: string; email: string; name: string }, client: ClientInfo) {
    return this.#issue(user, prefixedId('fam'), client);
  }

  /** The access token inherits how the session was opened from the refresh-token family. */
  async #issue(
    user: { id: string; email: string; name: string },
    familyId: string,
    client: ClientInfo,
  ): Promise<Session> {
    const origin = familyOrigin(familyId);
    const refresh = this.tokens.newRefreshToken();
    await this.prisma.client.refreshToken.create({
      data: {
        id: prefixedId('rt'),
        userId: user.id,
        familyId,
        tokenHash: refresh.hash,
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
        ip: client.ip,
        userAgent: client.userAgent?.slice(0, 512) ?? null,
      },
    });
    return {
      accessToken: await this.tokens.signAccess({
        sub: user.id,
        email: user.email,
        amr: origin.amr,
        ...(origin.org ? { org: origin.org } : {}),
        sid: familyId,
      }),
      expiresIn: ACCESS_TTL_SECONDS,
      refreshToken: refresh.token,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }
}

export { LoginLockedError };

function lockedError(ms: number): LoginLockedError {
  return new LoginLockedError(ms);
}
