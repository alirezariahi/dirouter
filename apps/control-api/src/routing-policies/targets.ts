/**
 * Shared checks of the routing policies (sprint 5): a policy may only point at names the
 * organization can route to, and only at its own teams and projects.
 */
import { isAutoAlias } from '@dirouter/routing';
import { DiRouterError } from '@dirouter/shared';

import type { PrismaService } from '../infra/prisma.service.js';

type Db = PrismaService['client'];

export function invalid(message: string): DiRouterError {
  return new DiRouterError('invalid_request', { message, status: 400 });
}

/**
 * A name a key of this organization can request: its own model, alias or combo, a public
 * marketplace model or combo of the platform, or an `auto*` alias.
 */
export async function assertRoutableName(
  db: Db,
  organizationId: string,
  name: string,
  field: string,
  options: { ownOnly?: boolean; allowAuto?: boolean } = {},
): Promise<void> {
  if (options.allowAuto !== false && isAutoAlias(name)) return;
  const platform = options.ownOnly
    ? undefined
    : await db.organization.findFirst({ where: { isPlatform: true }, select: { id: true } });
  const [model, alias, combo] = await Promise.all([
    db.model.findFirst({
      where: {
        slug: name,
        deletedAt: null,
        OR: [
          { organizationId },
          ...(platform ? [{ organizationId: platform.id, isPublic: true }] : []),
        ],
      },
      select: { id: true },
    }),
    db.modelAlias.findFirst({ where: { organizationId, slug: name }, select: { id: true } }),
    db.combo.findFirst({
      where: {
        slug: name,
        deletedAt: null,
        OR: [
          { organizationId },
          ...(platform ? [{ organizationId: platform.id, isPublic: true }] : []),
        ],
      },
      select: { id: true },
    }),
  ]);
  if (!model && !alias && !combo)
    throw invalid(`${field}: '${name}' is not a model, alias or combo of this organization`);
}

export async function assertScope(
  db: Db,
  organizationId: string,
  scope: { teamId?: string | null | undefined; projectId?: string | null | undefined },
): Promise<void> {
  if (scope.teamId) {
    const team = await db.team.findFirst({
      where: { id: scope.teamId, organizationId },
      select: { id: true },
    });
    if (!team) throw invalid('teamId: no such team in this organization');
  }
  if (scope.projectId) {
    const project = await db.project.findFirst({
      where: { id: scope.projectId, organizationId },
      select: { id: true },
    });
    if (!project) throw invalid('projectId: no such project in this organization');
  }
}

export function notFound(what: string): DiRouterError {
  return new DiRouterError('not_found', { message: `${what} not found`, status: 404 });
}
