/**
 * DiRouter's own MCP server (card 20.2): agents ask about models, health, usage and budgets, and
 * simulate routing, with the same virtual key they send requests with.
 *
 * Access is explicit per key (`mcpAdmin`): `none` (default) is refused, `read` gets the read tools,
 * and only `write` sees and may call `create_api_key`. A key created this way lives in the same
 * project, never carries MCP admin access itself, cannot reach models the parent key cannot, and
 * expires (at most 90 days). Only owners and admins can grant `read` or `write`.
 */
import { BlockList, isIP } from 'node:net';

import { DiRouterError, hashApiKey, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { KeysService } from '../keys/keys.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { StatsService } from '../stats/stats.service.js';
import { WalletsService } from '../billing/wallets.service.js';

type KeyRow = NonNullable<Awaited<ReturnType<PrismaService['client']['apiKey']['findUnique']>>>;
type Scope = 'read' | 'write';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: Scope;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
}

export const ADMIN_TOOLS: ToolDef[] = [
  {
    name: 'list_models',
    description:
      'Models, aliases and combos this key can use, with their prices per million tokens.',
    inputSchema: { type: 'object', properties: {} },
    scope: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'health_status',
    description: 'Circuit-breaker state of the providers and models, and credentials in cooldown.',
    inputSchema: { type: 'object', properties: {} },
    scope: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'usage_summary',
    description:
      'Requests, tokens and cost of this key (or its project) over the last days, its budgets with what was spent, and the prepaid wallet balance.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
        scope: { type: 'string', enum: ['key', 'project'], default: 'key' },
      },
    },
    scope: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'simulate_route',
    description:
      'Which provider targets a request for a model would try right now, in order, and why others are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        estimatedInputTokens: { type: 'integer', minimum: 0 },
        maxOutputTokens: { type: 'integer', minimum: 1 },
      },
      required: ['model'],
    },
    scope: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_api_key',
    description:
      'Creates a new API key in the same project. It can use at most the models this key can, has no MCP admin access, and expires after expiresInDays (default 30, at most 90). The key is shown once.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        allowedModels: { type: 'array', items: { type: 'string' } },
        expiresInDays: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
      },
      required: ['name'],
    },
    scope: 'write',
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

export class AdminToolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const text = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

@Injectable()
export class AdminMcpService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StatsService) private readonly stats: StatsService,
    @Inject(KeysService) private readonly keys: KeysService,
    @Inject(WalletsService) private readonly wallets: WalletsService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  /** The calling key, if it is active, unexpired, allowed from this address and has MCP access. */
  async authenticate(rawKey: string | undefined, ip: string): Promise<KeyRow> {
    if (!rawKey) throw new DiRouterError('unauthenticated', { message: 'Missing API key' });
    const key = await this.db.apiKey.findUnique({
      where: { hash: hashApiKey(rawKey, this.env.KEY_PEPPER) },
    });
    if (key?.status !== 'ACTIVE') throw new DiRouterError('invalid_api_key');
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now())
      throw new DiRouterError('api_key_expired');
    if (key.ipAllowlist.length > 0) {
      const list = new BlockList();
      for (const entry of key.ipAllowlist) {
        const [address = '', prefix] = entry.split('/');
        const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
        if (prefix) list.addSubnet(address, Number(prefix), family);
        else list.addAddress(address, family);
      }
      const address = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
      if (!list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4'))
        throw new DiRouterError('forbidden', { message: 'IP address not allowed for this key' });
    }
    if (key.mcpAdmin !== 'read' && key.mcpAdmin !== 'write')
      throw new DiRouterError('forbidden', {
        message:
          'This key has no access to the DiRouter MCP server; an owner or admin can grant it',
      });
    return key;
  }

  tools(key: KeyRow) {
    return ADMIN_TOOLS.filter((t) => t.scope === 'read' || key.mcpAdmin === 'write').map(
      ({ scope: _scope, ...tool }) => tool,
    );
  }

  #ctx(key: KeyRow): OrgContext {
    // Read tools only look at the organization; create_api_key acts for the parent key's creator.
    return { organizationId: key.organizationId, userId: key.createdById ?? '', role: 'MEMBER' };
  }

  async call(key: KeyRow, name: string, args: Record<string, unknown>) {
    const tool = ADMIN_TOOLS.find((t) => t.name === name);
    // A write tool without write access looks exactly like an unknown tool.
    if (!tool || (tool.scope === 'write' && key.mcpAdmin !== 'write'))
      throw new AdminToolError(-32602, `Unknown tool: ${name}`);
    switch (tool.name) {
      case 'list_models':
        return text(await this.#models(key));
      case 'health_status':
        return text(await this.stats.runtimeHealth(this.#ctx(key)));
      case 'usage_summary':
        return text(await this.#usage(key, args));
      case 'simulate_route':
        return text(await this.#simulate(key, args));
      default:
        return text(await this.#createKey(key, args));
    }
  }

  async #models(key: KeyRow) {
    const platform = await this.db.organization.findFirst({
      where: { isPlatform: true, deletedAt: null },
      select: { id: true },
    });
    const orgs = [
      key.organizationId,
      ...(platform && platform.id !== key.organizationId ? [platform.id] : []),
    ];
    const [models, aliases, combos] = await Promise.all([
      this.db.model.findMany({
        where: {
          organizationId: { in: orgs },
          enabled: true,
          deletedAt: null,
          OR: [{ organizationId: key.organizationId }, { isPublic: true }],
        },
        orderBy: { slug: 'asc' },
      }),
      this.db.modelAlias.findMany({ where: { organizationId: key.organizationId } }),
      this.db.combo.findMany({
        where: {
          organizationId: { in: orgs },
          deletedAt: null,
          OR: [{ organizationId: key.organizationId }, { isPublic: true }],
        },
        select: { slug: true, strategy: true },
      }),
    ]);
    const allowed = (slug: string) =>
      key.allowedModels.length === 0 || key.allowedModels.includes(slug);
    const scale = (price: { toNumber(): number }, multiplier: { toNumber(): number }) =>
      (price.toNumber() * multiplier.toNumber()).toFixed(6);
    // Own names win over marketplace ones, as in the router.
    const seen = new Set<string>();
    return {
      models: models
        .sort(
          (a, b) =>
            Number(b.organizationId === key.organizationId) -
            Number(a.organizationId === key.organizationId),
        )
        .filter((m) => allowed(m.slug) && !seen.has(m.slug) && seen.add(m.slug))
        .map((m) => ({
          name: m.slug,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          capabilities: m.capabilities,
          priceUsd: m.salePerRequestUsd
            ? { perRequest: m.salePerRequestUsd.toFixed(6) }
            : {
                inputPerMTok: scale(m.inputPrice, m.saleMultiplier),
                outputPerMTok: scale(m.outputPrice, m.saleMultiplier),
              },
        })),
      aliases: aliases.filter((a) => allowed(a.slug)).map((a) => a.slug),
      combos: combos
        .filter((c) => allowed(c.slug))
        .map((c) => ({ name: c.slug, strategy: c.strategy.toLowerCase() })),
    };
  }

  async #usage(key: KeyRow, args: Record<string, unknown>) {
    const days = Math.min(90, Math.max(1, Number(args.days ?? 30) || 30));
    const scope = args.scope === 'project' ? 'project' : 'key';
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const ctx = this.#ctx(key);
    const [overview, budgets, wallet] = await Promise.all([
      this.stats.overview(
        ctx,
        { from, to },
        scope === 'key' ? { apiKeyId: key.id } : { projectId: key.projectId },
      ),
      this.stats.budgetStatus(ctx),
      this.wallets.summary(key.organizationId),
    ]);
    return {
      scope,
      days,
      usage: {
        requests: overview.requests,
        errors: overview.errors,
        inputTokens: overview.inputTokens,
        outputTokens: overview.outputTokens,
        costUsd: overview.costUsd,
        latencyP95Ms: overview.latencyP95Ms,
      },
      budgets: budgets.filter(
        (b) =>
          (b.scope === 'key' && b.scopeId === key.id) ||
          (b.scope === 'project' && b.scopeId === key.projectId),
      ),
      wallet:
        wallet.prepaid && wallet.wallet
          ? { balanceUsd: wallet.wallet.balanceUsd, availableUsd: wallet.wallet.availableUsd }
          : null,
    };
  }

  async #simulate(key: KeyRow, args: Record<string, unknown>) {
    if (typeof args.model !== 'string' || !args.model)
      throw new AdminToolError(-32602, 'model is required');
    return this.stats.simulateRoute(this.#ctx(key), {
      model: args.model,
      virtualKeyId: key.id,
      ...(typeof args.estimatedInputTokens === 'number'
        ? { estimatedInputTokens: args.estimatedInputTokens }
        : {}),
      ...(typeof args.maxOutputTokens === 'number'
        ? { maxOutputTokens: args.maxOutputTokens }
        : {}),
    });
  }

  async #createKey(key: KeyRow, args: Record<string, unknown>) {
    if (!key.createdById)
      throw new AdminToolError(
        -32603,
        'This key has no owner to act for; create keys from the dashboard',
      );
    const name = typeof args.name === 'string' ? args.name.trim().slice(0, 100) : '';
    if (!name) throw new AdminToolError(-32602, 'name is required');
    const requested = Array.isArray(args.allowedModels)
      ? args.allowedModels.filter((m): m is string => typeof m === 'string')
      : [];
    // Never wider than the parent: a restricted parent passes on its restriction.
    if (key.allowedModels.length > 0 && requested.some((m) => !key.allowedModels.includes(m)))
      throw new AdminToolError(-32602, "allowedModels must be a subset of this key's models");
    const allowedModels = requested.length > 0 ? requested : key.allowedModels;
    const days = Math.min(90, Math.max(1, Number(args.expiresInDays ?? 30) || 30));
    const created = await this.keys.create(this.#ctx(key), {
      name,
      projectId: key.projectId,
      allowedModels,
      mcpAdmin: 'none',
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    });
    // Outside /orgs/… the automatic rebuild does not run: publish so the gateway knows the key.
    this.snapshots.schedule('mcp create_api_key');
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: key.organizationId,
        actorUserId: key.createdById,
        action: 'mcp_admin.key_created',
        targetType: 'api_key',
        targetId: created.id,
        diff: { viaKeyId: key.id, name, allowedModels, expiresInDays: days },
      },
    });
    return {
      id: created.id,
      key: created.key,
      prefix: created.prefix,
      expiresAt: created.expiresAt,
      allowedModels,
    };
  }
}
