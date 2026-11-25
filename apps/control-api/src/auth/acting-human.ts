/**
 * The person behind a request. A dashboard session is that person; a management token (card 23.6)
 * acts as its service account, whose user is never verified by anyone, so checks that are about a
 * human (email verification, four-eyes approval) look at the person who created the token.
 */
import { DiRouterError } from '@dirouter/shared';

import type { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

type Db = PrismaService['client'];

/** The human acting: the session's user, or the creator of the management token (null if unknown). */
export async function actingHumanId(
  db: Db,
  ctx: Pick<OrgContext, 'userId' | 'tokenId'>,
): Promise<string | null> {
  if (!ctx.tokenId) return ctx.userId;
  const token = await db.managementToken.findUnique({
    where: { id: ctx.tokenId },
    select: { createdById: true },
  });
  return token?.createdById ?? null;
}

/**
 * Refuses the action while the acting person's email address is not verified (card 23.4). Only
 * portal sign-ups and users who joined through an invitation that was not delivered by email
 * start unverified. A management token whose creator cannot be resolved is refused as well.
 */
export async function requireVerifiedEmail(
  db: Db,
  ctx: Pick<OrgContext, 'userId' | 'tokenId'>,
  message: string,
): Promise<void> {
  const humanId = await actingHumanId(db, ctx);
  const user = humanId
    ? await db.user.findUnique({ where: { id: humanId }, select: { emailVerifiedAt: true } })
    : null;
  // A session user that no longer exists is stopped by the guards; only the token path can miss.
  if (ctx.tokenId ? !user?.emailVerifiedAt : user && !user.emailVerifiedAt)
    throw new DiRouterError('email_not_verified', { message });
}
