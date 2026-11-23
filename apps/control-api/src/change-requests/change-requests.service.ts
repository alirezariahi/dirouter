/**
 * Change requests: the four-eyes principle for sensitive changes (card 22.2).
 *
 * When an organization turns on `changeApprovalRequired`, the sensitive operations registered here
 * do not run when asked. A pending request is recorded instead, and the change is applied
 * automatically once a second person approves it:
 *
 * - the requester can never approve their own request (cancelling it is allowed);
 * - the approver needs the operation's permission, and the change is applied as the approver, so
 *   every check of the operation (e.g. "no role above your own") applies to them too;
 * - a request is decided once: the status moves away from PENDING atomically before anything runs;
 * - requests expire after seven days.
 *
 * Operations register themselves (see `register`) from their own modules, so this module depends
 * on none of them.
 */
import { DiRouterError, ForbiddenError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { canAny, type Permission } from '../rbac/permissions.js';

export const CHANGE_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SensitiveOperation<P> {
  /** Permission the approver needs; the requester needed it to ask. */
  permission: Permission;
  /** Human-readable summary for the list, e.g. "Delete provider OpenAI". */
  describe(ctx: OrgContext, payload: P): Promise<string> | string;
  targetId?(payload: P): string | undefined;
  apply(ctx: OrgContext, payload: P): Promise<unknown>;
}

export interface Gate {
  /** The pending request when approval is required; undefined when the change may run now. */
  changeRequest?: ReturnType<ChangeRequestsService['view']>;
}

type Row = NonNullable<Awaited<ReturnType<PrismaService['client']['changeRequest']['findFirst']>>>;

@Injectable()
export class ChangeRequestsService {
  readonly #operations = new Map<string, SensitiveOperation<never>>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  get db() {
    return this.prisma.client;
  }

  register<P>(kind: string, operation: SensitiveOperation<P>): void {
    this.#operations.set(kind, operation);
  }

  view(row: Row) {
    return {
      id: row.id,
      kind: row.kind,
      targetId: row.targetId,
      summary: row.summary,
      payload: row.payload,
      status: row.status.toLowerCase(),
      requestedById: row.requestedById,
      decidedById: row.decidedById,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      reason: row.reason,
      error: row.error,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  #operation(kind: string) {
    const operation = this.#operations.get(kind);
    if (!operation) throw new Error(`unknown change request kind ${kind}`);
    return operation;
  }

  async approvalRequired(organizationId: string): Promise<boolean> {
    const org = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { changeApprovalRequired: true },
    });
    return org?.changeApprovalRequired === true;
  }

  /**
   * Called by a sensitive endpoint before it acts: records a request and returns it when the
   * organization requires approval; otherwise returns nothing and the endpoint goes ahead.
   */
  async gate(ctx: OrgContext, kind: string, payload: object): Promise<Gate> {
    if (!(await this.approvalRequired(ctx.organizationId))) return {};
    const operation = this.#operation(kind) as unknown as SensitiveOperation<object>;
    const id = prefixedId('chr');
    const summary = (await operation.describe(ctx, payload)).slice(0, 300);
    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.changeRequest.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          kind,
          targetId: operation.targetId?.(payload) ?? null,
          payload: payload as never,
          summary,
          requestedById: ctx.userId,
          expiresAt: new Date(Date.now() + CHANGE_REQUEST_TTL_MS),
        },
      });
      await tx.auditLog.create({
        data: this.#audit(ctx, 'change_request.created', id, { kind, summary }),
      });
      return created;
    });
    return { changeRequest: this.view(row) };
  }

  async list(ctx: OrgContext, status?: string) {
    await this.#expire(ctx.organizationId);
    const rows = await this.db.changeRequest.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(status ? { status: status.toUpperCase() as Row['status'] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => this.view(row));
  }

  async #expire(organizationId: string) {
    await this.db.changeRequest.updateMany({
      where: { organizationId, status: 'PENDING', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
  }

  async #pending(ctx: OrgContext, id: string) {
    await this.#expire(ctx.organizationId);
    const row = await this.db.changeRequest.findFirst({
      where: { id, organizationId: ctx.organizationId },
    });
    if (!row) throw new DiRouterError('not_found');
    if (row.status !== 'PENDING')
      throw new DiRouterError('conflict', {
        message: `This request is already ${row.status.toLowerCase()}`,
      });
    return row;
  }

  /** Moves a pending request to its decided state once; false when someone else was faster. */
  async #decide(row: Row, ctx: OrgContext, status: Row['status'], reason?: string) {
    const claimed = await this.db.changeRequest.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: {
        status,
        decidedById: ctx.userId,
        decidedAt: new Date(),
        ...(reason ? { reason: reason.slice(0, 500) } : {}),
      },
    });
    if (claimed.count !== 1)
      throw new DiRouterError('conflict', { message: 'This request was already decided' });
  }

  async approve(ctx: OrgContext, id: string) {
    const row = await this.#pending(ctx, id);
    if (row.requestedById === ctx.userId)
      throw new ForbiddenError('forbidden', {
        message: 'A change request must be approved by someone other than its requester',
      });
    const operation = this.#operation(row.kind);
    if (!canAny(ctx.role, ctx.customPermissions, operation.permission))
      throw new ForbiddenError('forbidden', {
        message: `Approving this change needs the ${operation.permission} permission`,
      });
    await this.#decide(row, ctx, 'APPLIED');
    try {
      await operation.apply(ctx, row.payload as never);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.changeRequest.update({
        where: { id },
        data: { status: 'FAILED', error: message.slice(0, 500) },
      });
      await this.db.auditLog.create({
        data: this.#audit(ctx, 'change_request.failed', id, { kind: row.kind, error: message }),
      });
      return this.view(await this.db.changeRequest.findUniqueOrThrow({ where: { id } }));
    }
    await this.db.auditLog.create({
      data: this.#audit(ctx, 'change_request.applied', id, {
        kind: row.kind,
        summary: row.summary,
        requestedById: row.requestedById,
      }),
    });
    return this.view(await this.db.changeRequest.findUniqueOrThrow({ where: { id } }));
  }

  /** Rejection by an approver, or cancellation by the requester. */
  async reject(ctx: OrgContext, id: string, reason?: string) {
    const row = await this.#pending(ctx, id);
    const own = row.requestedById === ctx.userId;
    if (!own && !canAny(ctx.role, ctx.customPermissions, this.#operation(row.kind).permission))
      throw new ForbiddenError('forbidden');
    await this.#decide(row, ctx, own ? 'CANCELLED' : 'REJECTED', reason);
    await this.db.auditLog.create({
      data: this.#audit(ctx, own ? 'change_request.cancelled' : 'change_request.rejected', id, {
        kind: row.kind,
        ...(reason ? { reason } : {}),
      }),
    });
    return this.view(await this.db.changeRequest.findUniqueOrThrow({ where: { id } }));
  }

  #audit(ctx: OrgContext, action: string, targetId: string, diff: object) {
    return {
      id: prefixedId('aud'),
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      ...(ctx.ip ? { ip: ctx.ip } : {}),
      action,
      targetType: 'change_request',
      targetId,
      diff: diff as never,
    };
  }
}
