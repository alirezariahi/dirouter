/**
 * Request bodies (card 24.1): capture levels per organization, project and virtual key, and the
 * stored payload of one request for the Log Explorer. Everything here needs `logs:bodies`; the
 * gateway reads the levels from the snapshot, so every change is followed by a rebuild.
 */
import { BodyCaptureLevel, BodyCaptureScope, DEFAULT_BODY_MAX_BYTES } from '@dirouter/contracts';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

export const CaptureLevelBody = z.object({
  scope: BodyCaptureScope,
  /** The organization's own id for `organization`, otherwise a project or key id. */
  scopeId: z.string().min(1).max(100),
  /** `inherit` removes the explicit level. */
  level: z.union([BodyCaptureLevel, z.literal('inherit')]),
});
export type CaptureLevelBody = z.infer<typeof CaptureLevelBody>;

const DAY = 86_400_000;

@Injectable()
export class BodiesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
  ) {}

  get #db() {
    return this.prisma.client;
  }

  /** Explicit levels of this organization and the instance defaults they fall back to. */
  async levels(org: OrgContext) {
    const [rules, settings] = await Promise.all([
      this.#db.bodyCaptureSetting.findMany({
        where: { organizationId: org.organizationId },
        orderBy: [{ scope: 'asc' }, { scopeId: 'asc' }],
      }),
      this.snapshots.gatewaySettings(),
    ]);
    const s = settings as {
      logBodies?: boolean;
      bodyCapture?: { defaultLevel?: string; maxBytes?: number };
    };
    return {
      defaultLevel: s.bodyCapture?.defaultLevel ?? (s.logBodies === true ? 'full' : 'none'),
      maxBytes: s.bodyCapture?.maxBytes ?? DEFAULT_BODY_MAX_BYTES,
      rules: rules.map((r) => ({
        scope: r.scope,
        scopeId: r.scopeId,
        level: r.level,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  async setLevel(org: OrgContext, body: CaptureLevelBody) {
    await this.#ownScope(org, body.scope, body.scopeId);
    const id = {
      organizationId: org.organizationId,
      scope: body.scope,
      scopeId: body.scopeId,
    };
    if (body.level === 'inherit') {
      await this.#db.bodyCaptureSetting.deleteMany({ where: id });
    } else {
      await this.#db.bodyCaptureSetting.upsert({
        where: { organizationId_scope_scopeId: id },
        create: { ...id, level: body.level, updatedById: org.userId },
        update: { level: body.level, updatedById: org.userId },
      });
    }
    await this.#db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org.organizationId,
        actorUserId: org.userId,
        ...(org.ip ? { ip: org.ip } : {}),
        action: 'body_capture.updated',
        targetType: body.scope,
        targetId: body.scopeId,
        diff: { level: body.level },
      },
    });
    const version = await this.snapshots.rebuild('body capture level changed');
    return { ...body, configVersion: version };
  }

  /** The scope must exist inside this organization; anything else reads as not found. */
  async #ownScope(org: OrgContext, scope: CaptureLevelBody['scope'], scopeId: string) {
    const found =
      scope === 'organization'
        ? scopeId === org.organizationId
        : scope === 'project'
          ? (await this.#db.project.count({
              where: { id: scopeId, organizationId: org.organizationId, deletedAt: null },
            })) > 0
          : (await this.#db.apiKey.count({
              where: { id: scopeId, organizationId: org.organizationId },
            })) > 0;
    if (!found) throw new DiRouterError('not_found', { message: `${scope} not found` });
  }

  /**
   * The stored body of one request. The log entry gives the time, so only the partitions of that
   * day are read; a body is only ever returned inside its own organization.
   */
  async body(org: OrgContext, requestId: string) {
    const log = await this.#db.requestLog.findFirst({
      where: { id: requestId, organizationId: org.organizationId },
      select: { createdAt: true },
    });
    const around = log?.createdAt.getTime();
    const row = await this.#db.requestBody.findFirst({
      where: {
        requestId,
        organizationId: org.organizationId,
        // The body may be written before its log entry; without one, search the whole retention.
        ...(around !== undefined
          ? { createdAt: { gte: new Date(around - DAY), lte: new Date(around + DAY) } }
          : {}),
      },
    });
    if (!row) throw new DiRouterError('not_found', { message: 'No stored body for this request' });
    return {
      requestId: row.requestId,
      createdAt: row.createdAt.toISOString(),
      inboundApi: row.inboundApi,
      level: row.level,
      metadata: row.metadata,
      request: row.request,
      requestTruncated: row.requestTruncated,
      response: row.response,
      responseTruncated: row.responseTruncated,
      streamed: row.streamed,
      redactions: row.redactions,
      replay: row.replay ?? null,
    };
  }
}
