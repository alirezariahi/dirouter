/**
 * Audit rows for account-level security events (MFA, passkeys). The audit log is organization
 * scoped, so the event is recorded in every organization the user belongs to; each organization's
 * auditors then see changes to the second factors of their own members.
 */
import { prefixedId } from '@dirouter/shared';

import type { PrismaService } from '../infra/prisma.service.js';

export interface UserAuditEvent {
  userId: string;
  action: string;
  targetType: string;
  targetId: string;
  ip?: string | undefined;
  /** Never put secrets, codes or key material here. */
  diff?: Record<string, string | number | boolean | null>;
}

export async function auditUserEvent(prisma: PrismaService, event: UserAuditEvent): Promise<void> {
  const memberships = await prisma.client.membership.findMany({
    where: { userId: event.userId, organization: { deletedAt: null } },
    select: { organizationId: true },
  });
  if (memberships.length === 0) return;
  await prisma.client.auditLog.createMany({
    data: memberships.map((membership) => ({
      id: prefixedId('aud'),
      organizationId: membership.organizationId,
      actorUserId: event.userId,
      ...(event.ip ? { ip: event.ip } : {}),
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      ...(event.diff ? { diff: event.diff } : {}),
    })),
  });
}
