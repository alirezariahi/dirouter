/**
 * MCP servers of an organization and the tool-call log (card 20.1). The gateway serves them under
 * /mcp; this service registers them (headers encrypted with MASTER_KEY, AAD `mcp:<id>`, never
 * returned), checks the URL against the outbound policy, and reads the calls the worker logged.
 */
import { encrypt } from '@dirouter/shared';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { checkOutboundUrl } from '../alerts/alert-url.js';
import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

export interface McpServerInput {
  name: string;
  slug: string;
  transport: 'streamable-http' | 'sse' | 'a2a';
  url: string;
  /** Replaces the stored headers; `null` removes them, absent keeps them. */
  headers?: Record<string, string> | null | undefined;
  enabled?: boolean | undefined;
  forwardIdentity?: boolean | undefined;
  timeoutMs?: number | undefined;
}

type Row = NonNullable<Awaited<ReturnType<PrismaService['client']['mcpServer']['findFirst']>>>;

export function mcpServerView(s: Row) {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    transport: s.transport,
    url: s.url,
    hasHeaders: s.headersEnc !== null,
    enabled: s.enabled,
    forwardIdentity: s.forwardIdentity,
    timeoutMs: s.timeoutMs,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

@Injectable()
export class McpService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  async #checkUrl(url: string) {
    // The gateway calls this address: same policy as alert webhooks (https and public addresses in
    // production; anything in development, where MCP servers run next door).
    const check = await checkOutboundUrl(url, { production: this.env.NODE_ENV === 'production' });
    if (!check.ok) throw new DiRouterError('validation_failed', { message: check.error });
  }

  async #audit(ctx: OrgContext, action: string, targetId: string, diff?: object) {
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        action,
        targetType: 'mcp_server',
        targetId,
        ...(diff ? { diff } : {}),
      },
    });
  }

  async #load(ctx: OrgContext, id: string) {
    const row = await this.db.mcpServer.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
    });
    if (!row) throw new DiRouterError('not_found', { message: 'MCP server not found' });
    return row;
  }

  async #slugFree(ctx: OrgContext, slug: string, except?: string) {
    const taken = await this.db.mcpServer.findFirst({
      where: {
        organizationId: ctx.organizationId,
        slug,
        deletedAt: null,
        NOT: { id: except ?? '' },
      },
      select: { id: true },
    });
    if (taken)
      throw new DiRouterError('conflict', { message: `MCP server '${slug}' already exists` });
  }

  async list(ctx: OrgContext) {
    const rows = await this.db.mcpServer.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      orderBy: { slug: 'asc' },
    });
    return rows.map(mcpServerView);
  }

  async get(ctx: OrgContext, id: string) {
    return mcpServerView(await this.#load(ctx, id));
  }

  async create(ctx: OrgContext, input: McpServerInput) {
    await this.#checkUrl(input.url);
    await this.#slugFree(ctx, input.slug);
    const id = prefixedId('mcp');
    await this.db.mcpServer.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        name: input.name,
        slug: input.slug,
        transport: input.transport,
        url: input.url,
        headersEnc: input.headers
          ? encrypt(this.env.MASTER_KEY, JSON.stringify(input.headers), `mcp:${id}`)
          : null,
        enabled: input.enabled ?? true,
        forwardIdentity: input.forwardIdentity ?? false,
        timeoutMs: input.timeoutMs ?? 60_000,
      },
    });
    await this.#audit(ctx, 'mcp_server.created', id, { slug: input.slug, url: input.url });
    return this.get(ctx, id);
  }

  async update(ctx: OrgContext, id: string, input: Partial<McpServerInput>) {
    const row = await this.#load(ctx, id);
    if (input.url !== undefined) await this.#checkUrl(input.url);
    if (input.slug !== undefined && input.slug !== row.slug)
      await this.#slugFree(ctx, input.slug, id);
    await this.db.mcpServer.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.transport !== undefined ? { transport: input.transport } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.headers !== undefined
          ? {
              headersEnc: input.headers
                ? encrypt(this.env.MASTER_KEY, JSON.stringify(input.headers), `mcp:${id}`)
                : null,
            }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.forwardIdentity !== undefined ? { forwardIdentity: input.forwardIdentity } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      },
    });
    // Header values are secrets: the audit trail records that they changed, not what they are.
    const { headers, ...rest } = input;
    await this.#audit(ctx, 'mcp_server.updated', id, {
      ...rest,
      ...(headers !== undefined ? { headers: headers ? 'replaced' : 'removed' } : {}),
    });
    return this.get(ctx, id);
  }

  async remove(ctx: OrgContext, id: string) {
    await this.#load(ctx, id);
    await this.db.mcpServer.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
    await this.#audit(ctx, 'mcp_server.deleted', id);
  }

  /**
   * Connection test and tool discovery (card 25.3). The gateway runs it with the same MCP client as
   * real traffic; the headers travel encrypted and are only decrypted there. Works for disabled
   * servers and before the snapshot carrying a new server has been loaded.
   */
  async test(ctx: OrgContext, id: string) {
    const row = await this.#load(ctx, id);
    const res = await fetch(
      `${this.env.GATEWAY_INTERNAL_URL.replace(/\/+$/, '')}/internal/mcp/probe`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.env.INTERNAL_TOKEN}`,
        },
        body: JSON.stringify({
          server: {
            id: row.id,
            organizationId: row.organizationId,
            slug: row.slug,
            transport: row.transport,
            url: row.url,
            enabled: row.enabled,
            ...(row.headersEnc ? { headers: row.headersEnc } : {}),
            forwardIdentity: row.forwardIdentity,
            timeoutMs: row.timeoutMs,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    ).catch((error: unknown) => {
      throw new DiRouterError('service_unavailable', {
        message: 'Gateway is not reachable',
        cause: error,
      });
    });
    if (!res.ok)
      throw new DiRouterError('service_unavailable', {
        message: `Gateway probe failed (${String(res.status)})`,
      });
    const result = (await res.json()) as {
      ok: boolean;
      latencyMs: number;
      tools?: { name: string; description?: string }[];
      agentName?: string;
      error?: string;
    };
    return {
      ok: result.ok,
      latencyMs: result.latencyMs,
      tools: result.tools ?? [],
      ...(result.agentName ? { agentName: result.agentName } : {}),
      ...(result.error ? { error: result.error.slice(0, 500) } : {}),
    };
  }

  async calls(
    ctx: OrgContext,
    q: {
      limit: number;
      serverId?: string | undefined;
      apiKeyId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    const rows = await this.db.mcpToolCall.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(q.serverId ? { serverId: q.serverId } : {}),
        ...(q.apiKeyId ? { apiKeyId: q.apiKeyId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: q.limit,
    });
    return rows.map((c) => ({
      id: c.id,
      occurredAt: c.occurredAt.toISOString(),
      apiKeyId: c.apiKeyId,
      projectId: c.projectId,
      serverId: c.serverId,
      tool: c.tool,
      arguments: c.arguments,
      status: c.status,
      errorMessage: c.errorMessage,
      latencyMs: c.latencyMs,
    }));
  }
}
