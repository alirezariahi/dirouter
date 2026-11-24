/**
 * Sign-in sessions (card 23.5). A session is one refresh-token family: it starts at login and
 * survives every rotation. Revoking it revokes the whole family, so its refresh token stops working
 * at once, and the access tokens it issued (they carry the family as `sid`) are refused by
 * AccessGuard on their next request instead of living out their 15 minutes.
 */
import { DiRouterError } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import { auditUserEvent } from './user-audit.js';

export interface SessionView {
  id: string;
  /** Short human label parsed from the user agent, e.g. "Firefox on Linux". */
  device: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  /** How the session was opened: password, passkey or single sign-on. */
  method: 'pwd' | 'passkey' | 'sso';
  current: boolean;
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*Safari\//, 'Safari'],
  [/^curl\//, 'curl'],
  [/\bnode\b|undici/i, 'Node.js'],
];
const SYSTEMS: [RegExp, string][] = [
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];

/** "Chrome on macOS", "Firefox", "Unknown device": enough to recognise one's own devices. */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device';
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? 'Unknown device';
}

function methodOf(familyId: string): SessionView['method'] {
  if (familyId.startsWith('fampk_')) return 'passkey';
  if (familyId.startsWith('famsso_')) return 'sso';
  return 'pwd';
}

@Injectable()
export class SessionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  get #db() {
    return this.prisma.client;
  }

  /** Whether the session `sid` still has a refresh token that was not revoked. */
  async isActive(sid: string): Promise<boolean> {
    const row = await this.#db.refreshToken.findFirst({
      where: { familyId: sid, revokedAt: null },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Active sessions of a user, most recent first. The head of each family (the one refresh token
   * that is neither used nor revoked nor expired) carries the latest address and user agent; it is
   * written on every refresh, so its creation time is the session's last activity.
   */
  async list(userId: string, currentSid?: string): Promise<SessionView[]> {
    const now = new Date();
    const heads = await this.#db.refreshToken.findMany({
      where: { userId, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (heads.length === 0) return [];
    const started = await this.#db.refreshToken.groupBy({
      by: ['familyId'],
      where: { userId, familyId: { in: heads.map((h) => h.familyId) } },
      _min: { createdAt: true },
    });
    const startedAt = new Map(started.map((row) => [row.familyId, row._min.createdAt]));
    const seen = new Set<string>();
    const sessions: SessionView[] = [];
    for (const head of heads) {
      // Two heads in one family only happen in the instant of a refresh race; show it once.
      if (seen.has(head.familyId)) continue;
      seen.add(head.familyId);
      sessions.push({
        id: head.familyId,
        device: describeDevice(head.userAgent),
        userAgent: head.userAgent,
        ip: head.ip,
        createdAt: (startedAt.get(head.familyId) ?? head.createdAt).toISOString(),
        lastActiveAt: head.createdAt.toISOString(),
        expiresAt: head.expiresAt.toISOString(),
        method: methodOf(head.familyId),
        current: head.familyId === currentSid,
      });
    }
    return sessions;
  }

  /** Revokes one session of `userId`; 404 when it is not theirs or already over. */
  async revoke(userId: string, sessionId: string, ip?: string): Promise<void> {
    const revoked = await this.#db.refreshToken.updateMany({
      where: { userId, familyId: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) throw new DiRouterError('not_found');
    await auditUserEvent(this.prisma, {
      userId,
      action: 'session.revoked',
      targetType: 'session',
      targetId: sessionId,
      ip,
    });
  }

  /**
   * "Sign out everywhere": revokes every session of the user, or every one except `keepSid`.
   * Returns how many sessions were ended. `audit: false` is for callers that record the event
   * themselves (an administrator ending a member's sessions is audited in that organization).
   */
  async revokeAll(
    userId: string,
    options: { keepSid?: string | undefined; ip?: string | undefined; audit?: boolean },
  ) {
    const where = {
      userId,
      revokedAt: null,
      ...(options.keepSid ? { familyId: { not: options.keepSid } } : {}),
    };
    const families = await this.#db.refreshToken.findMany({
      where: { ...where, usedAt: null, expiresAt: { gt: new Date() } },
      select: { familyId: true },
      distinct: ['familyId'],
    });
    await this.#db.refreshToken.updateMany({ where, data: { revokedAt: new Date() } });
    if (options.audit !== false)
      await auditUserEvent(this.prisma, {
        userId,
        action: 'session.revoked_all',
        targetType: 'user',
        targetId: userId,
        ip: options.ip,
        diff: { sessions: families.length, keptCurrent: Boolean(options.keepSid) },
      });
    return { revoked: families.length };
  }
}
