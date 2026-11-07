/**
 * احراز هویت داشبورد (کارت ۳.۴): ویزارد setup، ورود، چرخش refresh token با تشخیص
 * استفادهٔ دوباره، خروج و تغییر رمز.
 */
import { AuthenticationError, DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import {
  ACCESS_TTL_SECONDS,
  hashPassword,
  REFRESH_TTL_SECONDS,
  TokenService,
  verifyPassword,
} from './crypto.js';
import { hashInvite, slugify } from '../common/ids.js';
import { LoginLimiter } from './login-limiter.js';

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
  ) {
    this.tokens = new TokenService(env.JWT_SECRET);
    this.limiter = new LoginLimiter(valkey.client);
  }

  async setupRequired(): Promise<boolean> {
    return (await this.prisma.client.user.count()) === 0;
  }

  /**
   * فقط وقتی هیچ کاربری نیست. advisory lock جلوی دو setup هم‌زمان را می‌گیرد؛ بعد از
   * اولین کاربر همیشه `setup_completed` برمی‌گردد.
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

  async login(email: string, password: string, client: ClientInfo): Promise<Session> {
    const normalized = email.toLowerCase();
    const locked = await this.limiter.lockedFor(normalized, client.ip);
    if (locked !== undefined) throw lockedError(locked);
    const user = await this.prisma.client.user.findUnique({ where: { email: normalized } });
    const ok = await verifyPassword(user?.passwordHash, password);
    if (!user || !ok || !user.isActive || user.deletedAt) {
      await this.limiter.failure(normalized, client.ip);
      // دهمین شکست خودش قفل را فعال می‌کند.
      const now = await this.limiter.lockedFor(normalized, client.ip);
      if (now !== undefined) throw lockedError(now);
      throw new AuthenticationError('invalid_credentials');
    }
    await this.limiter.success(normalized);
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return this.#issue(user, prefixedId('fam'), client);
  }

  /**
   * چرخش: توکن فعلی «مصرف‌شده» علامت می‌خورد و توکن تازه در همان خانواده صادر می‌شود.
   * ارائهٔ توکنِ قبلاً مصرف‌شده یعنی کسی آن را دزدیده: کل خانواده (همهٔ دستگاه‌های آن
   * نشست) باطل می‌شود و هر دو طرف باید دوباره وارد شوند.
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
    // شرط usedAt=null در خود UPDATE: دو refresh هم‌زمان با یک توکن فقط یکی را برنده می‌کند.
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
   * پذیرش دعوت: اگر کاربری با همان ایمیل هست، رمز همان کاربر لازم است (حساب کسی با لینک
   * تصاحب نمی‌شود)؛ وگرنه کاربر تازه با نام و رمز ساخته می‌شود. لینک یک‌بارمصرف است.
   */
  async acceptInvitation(
    input: { token: string; name?: string | undefined; password: string },
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
    if (existing && !(await verifyPassword(existing.passwordHash, input.password)))
      throw new AuthenticationError('invalid_credentials');
    if (!existing && !input.name)
      throw new DiRouterError('validation_failed', {
        message: 'name is required for a new account',
      });
    const passwordHash = existing ? undefined : await hashPassword(input.password);
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
      // همهٔ نشست‌ها (دستگاه‌های دیگر) باطل می‌شوند؛ access tokenها حداکثر ۱۵ دقیقه می‌مانند.
      db.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  async me(userId: string) {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      include: { memberships: { include: { organization: true } } },
    });
    if (!user || user.deletedAt) throw new AuthenticationError('unauthenticated');
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      organizations: user.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
    };
  }

  async #revokeFamily(familyId: string): Promise<void> {
    await this.prisma.client.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async #issue(
    user: { id: string; email: string; name: string },
    familyId: string,
    client: ClientInfo,
  ): Promise<Session> {
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
      accessToken: await this.tokens.signAccess({ sub: user.id, email: user.email }),
      expiresIn: ACCESS_TTL_SECONDS,
      refreshToken: refresh.token,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }
}

/** 429 با کد login_locked؛ ProblemFilter از retryAfterMs هدر Retry-After می‌سازد. */
export class LoginLockedError extends DiRouterError {
  override readonly name = 'LoginLockedError';
  constructor(readonly retryAfterMs: number) {
    super('login_locked', { message: 'Too many failed login attempts; try again later' });
  }
}

function lockedError(ms: number): LoginLockedError {
  return new LoginLockedError(ms);
}
