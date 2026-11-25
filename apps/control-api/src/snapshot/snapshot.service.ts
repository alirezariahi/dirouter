/**
 * Building and publishing the Config Snapshot (card 3.9).
 *
 * - Snapshot of the full configuration of all organizations for the gateway: providers with **encrypted** secrets, models,
 *   aliases, combos, keys (hash only), limits, and budgets. It contains no plaintext secrets.
 * - After each effective change (short debounce) it is rebuilt; if the checksum changed, a new version
 *   is stored in config_versions with an incrementing number and `dirouter:config:updated` is published on Valkey
 *   The gateway fetches the version upon receiving the message immediately (and every 2 seconds with an ETag).
 */
import { createHash } from 'node:crypto';

import {
  CONFIG_SNAPSHOT_SCHEMA_VERSION,
  ConfigSnapshot,
  type ConfigSnapshotInput,
  GatewaySettings,
  type ModelPricing,
  type RepairKind,
  RequestPolicy,
  ProviderDataPolicy,
  RoutingPolicy,
} from '@dirouter/contracts';
import type { Prisma } from '@dirouter/db';
import type { Logger } from '@dirouter/shared';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { LOGGER } from '../infra/tokens.js';

import { CONFIG_CHANNEL, REBUILD_CHANNEL } from './channels.js';

export { CONFIG_CHANNEL, REBUILD_CHANNEL };
const PERIODIC_MS = 30_000;
const LOCK = 482_903;
const KEEP_VERSIONS = 50;

const TYPE: Record<string, string> = {
  OPENAI: 'openai',
  AZURE_OPENAI: 'azure-openai',
  OPENAI_COMPATIBLE: 'openai-compatible',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
  BEDROCK: 'bedrock',
  VERTEX: 'vertex',
  COHERE: 'cohere',
  MISTRAL: 'mistral',
  VOYAGE: 'voyage',
  JINA: 'jina',
  ELEVENLABS: 'elevenlabs',
  DEEPGRAM: 'deepgram',
  FAL: 'fal',
  PLUGIN: 'plugin',
  MOCK: 'mock',
};
const STRATEGY: Record<
  string,
  'priority' | 'weighted' | 'round-robin' | 'latency' | 'cost' | 'least-used' | 'headroom'
> = {
  PRIORITY: 'priority',
  WEIGHTED: 'weighted',
  ROUND_ROBIN: 'round-robin',
  LATENCY: 'latency',
  COST: 'cost',
  LEAST_USED: 'least-used',
  HEADROOM: 'headroom',
};
const usd = (d: Prisma.Decimal | null | undefined) =>
  d === null || d === undefined ? undefined : d.toFixed(8).replace(/\.?0+$/, '') || '0';

/** A model's sale settings (card 19.4), omitted when it sells at cost. */
function saleOf(m: {
  saleMultiplier: Prisma.Decimal;
  salePerRequestUsd: Prisma.Decimal | null;
  saleCacheMultiplier: Prisma.Decimal;
}) {
  const multiplier = usd(m.saleMultiplier) ?? '1';
  const cacheMultiplier = usd(m.saleCacheMultiplier) ?? '0';
  const perRequestUsd = usd(m.salePerRequestUsd);
  if (multiplier === '1' && cacheMultiplier === '0' && perRequestUsd === undefined) return {};
  return { sale: { multiplier, cacheMultiplier, ...(perRequestUsd ? { perRequestUsd } : {}) } };
}

type Content = Omit<ConfigSnapshotInput, 'version' | 'generatedAt' | 'checksum'>;

/** Keys are sorted so the checksum only changes on a real change. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}

/**
 * A stored request policy (epic 31) as it goes into the snapshot; an empty or unreadable one is
 * left out, so a bad row never blocks publishing.
 */
function policyOf(value: unknown): { requestPolicy?: RequestPolicy } {
  const parsed = RequestPolicy.safeParse(value);
  return parsed.success && Object.keys(parsed.data).length > 0
    ? { requestPolicy: parsed.data }
    : {};
}

@Injectable()
export class SnapshotService implements OnModuleInit, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined;
  #periodic: NodeJS.Timeout | undefined;
  #sub: ReturnType<ValkeyService['client']['duplicate']> | undefined;
  #running: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onModuleInit() {
    // The first version, or syncing with changes that happened during shutdown.
    await this.rebuild('startup').catch((error: unknown) => {
      this.logger.error({ err: error }, 'initial config snapshot failed');
    });
    // Safety net: direct DB changes (seed, tools) and key expiry; no version is built without a change.
    this.#periodic = setInterval(() => {
      this.schedule('periodic', 0);
    }, PERIODIC_MS);
    this.#periodic.unref();
    this.#sub = this.valkey.client.duplicate({
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    this.#sub.on('error', () => undefined);
    this.#sub.on('message', () => {
      this.schedule('rebuild requested', 0);
    });
    await this.#sub.subscribe(REBUILD_CHANNEL).catch(() => undefined);
  }

  onModuleDestroy() {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#periodic) clearInterval(this.#periodic);
    this.#sub?.disconnect();
  }

  /** Several consecutive changes produce one version. */
  schedule(reason: string, delayMs = 50): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.rebuild(reason).catch((error: unknown) => {
        this.logger.error({ err: error, reason }, 'config snapshot rebuild failed');
      });
    }, delayMs);
    this.#timer.unref();
  }

  async build(): Promise<Content> {
    const db = this.prisma.client;
    const [
      providers,
      models,
      combos,
      aliases,
      keys,
      projects,
      budgets,
      policies,
      guardrails,
      wallets,
      organizations,
      mcpServers,
      bodyCapture,
      routingRules,
      trafficSplits,
      shadowPolicies,
      routingPolicies,
    ] = await Promise.all([
      db.provider.findMany({
        where: { deletedAt: null },
        include: { credentials: true },
        orderBy: { id: 'asc' },
      }),
      db.model.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' } }),
      db.combo.findMany({
        where: { deletedAt: null },
        include: { targets: true },
        orderBy: { id: 'asc' },
      }),
      db.modelAlias.findMany({ orderBy: { id: 'asc' } }),
      // Revoked or expired keys are no longer needed; their absence means rejected.
      db.apiKey.findMany({
        where: { status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        orderBy: { id: 'asc' },
      }),
      db.project.findMany({ select: { id: true, teamId: true } }),
      db.budget.findMany({ orderBy: { id: 'asc' } }),
      db.rateLimitPolicy.findMany({ orderBy: { id: 'asc' } }),
      db.guardrailPolicy.findMany({ where: { enabled: true }, orderBy: { id: 'asc' } }),
      // Prepaid organizations (card 19.1): their keys carry the wallet to reserve credit from.
      db.wallet.findMany({
        where: { kind: 'CUSTOMER', organization: { prepaid: true, deletedAt: null } },
        select: { id: true, organizationId: true },
      }),
      // The platform and the customer groups (card 19.4).
      db.organization.findMany({
        where: { deletedAt: null, OR: [{ isPlatform: true }, { customerGroupId: { not: null } }] },
        select: { id: true, isPlatform: true, customerGroup: { select: { multiplier: true } } },
      }),
      db.mcpServer.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' } }),
      // Request body capture levels (card 24.1).
      db.bodyCaptureSetting.findMany({
        orderBy: [{ organizationId: 'asc' }, { scope: 'asc' }, { scopeId: 'asc' }],
      }),
      // Conditional routing rules (card 32.2).
      db.routingRule.findMany({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] }),
      // Canary and percentage traffic splits (card 32.3).
      db.trafficSplit.findMany({ orderBy: { id: 'asc' } }),
      // Shadow traffic (card 32.4).
      db.shadowPolicy.findMany({ orderBy: { id: 'asc' } }),
      // Routing policies (cards 32.1, 32.5 and 32.7).
      db.routingPolicySetting.findMany({
        orderBy: [{ organizationId: 'asc' }, { scope: 'asc' }, { scopeId: 'asc' }],
      }),
    ]);
    // Organizations that refuse unsupported parameters instead of dropping them (card 31.4).
    const strictParams = new Set(
      (
        await db.organization.findMany({
          where: { dropParams: false, deletedAt: null },
          select: { id: true },
        })
      ).map((o) => o.id),
    );
    const walletOf = new Map(wallets.map((w) => [w.organizationId, w.id]));
    const platformId = organizations.find((o) => o.isPlatform)?.id;
    const multiplierOf = new Map(
      organizations.flatMap((o) =>
        o.customerGroup ? [[o.id, usd(o.customerGroup.multiplier) ?? '1'] as const] : [],
      ),
    );
    const teamOf = new Map(projects.map((p) => [p.id, p.teamId]));
    const budgetsFor = (scope: string, id: string) =>
      budgets
        .filter((b) => b.scope === scope && b.scopeId === id)
        .map((b) => ({
          id: b.id,
          period: b.period === 'DAILY' ? ('daily' as const) : ('monthly' as const),
          ...(b.limitUsd ? { limitUsd: usd(b.limitUsd) } : {}),
          ...(b.limitTokens !== null ? { limitTokens: Number(b.limitTokens) } : {}),
          alertThresholds: b.alertThresholds,
        }));
    const rateLimit = (r: {
      rpm: number | null;
      tpm: number | null;
      maxConcurrency: number | null;
    }) =>
      r.rpm || r.tpm || r.maxConcurrency
        ? {
            rateLimit: {
              ...(r.rpm ? { requestsPerMinute: r.rpm } : {}),
              ...(r.tpm ? { tokensPerMinute: r.tpm } : {}),
              ...(r.maxConcurrency ? { maxConcurrency: r.maxConcurrency } : {}),
            },
          }
        : {};
    const modelIds = new Set(models.map((m) => m.id));
    const comboIds = new Set(combos.map((c) => c.id));

    return {
      schemaVersion: CONFIG_SNAPSHOT_SCHEMA_VERSION,
      providers: providers.map((p) => ({
        id: p.id,
        organizationId: p.organizationId,
        slug: p.slug,
        type: (TYPE[p.type] ?? 'openai-compatible') as never,
        name: p.name,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        options: p.options as Record<string, unknown>,
        ...(p.proxyUrl ? { proxy: { url: p.proxyUrl } } : {}),
        ...(p.timeouts ? { timeouts: p.timeouts as Record<string, number> } : {}),
        ...(p.maxConcurrency ? { maxConcurrency: p.maxConcurrency } : {}),
        // Region, retention and training use (card 32.5); an invalid stored value is left out.
        ...(ProviderDataPolicy.safeParse(p.dataPolicy).success && p.dataPolicy
          ? { dataPolicy: p.dataPolicy as ProviderDataPolicy }
          : {}),
        credentials: p.credentials
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((c) => ({
            id: c.id,
            name: c.name,
            secret: c.secretEnc,
            enabled: c.status === 'ACTIVE',
            weight: c.weight,
            headers: c.headers as Record<string, string>,
            ...(c.proxyUrl ? { proxy: { url: c.proxyUrl } } : {}),
          })),
      })),
      models: models.map((m) => ({
        id: m.id,
        organizationId: m.organizationId,
        slug: m.slug,
        providerId: m.providerId,
        upstreamModel: m.upstreamModel,
        enabled: m.enabled,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
        pricing: {
          inputPerMTok: usd(m.inputPrice) ?? '0',
          outputPerMTok: usd(m.outputPrice) ?? '0',
          ...(m.cacheReadPrice ? { cacheReadPerMTok: usd(m.cacheReadPrice) } : {}),
          ...(m.cacheWritePrice ? { cacheWritePerMTok: usd(m.cacheWritePrice) } : {}),
          ...(m.reasoningPrice ? { reasoningPerMTok: usd(m.reasoningPrice) } : {}),
          ...(m.imagePrice ? { perImageUsd: usd(m.imagePrice) } : {}),
          ...(m.charPrice ? { perMCharUsd: usd(m.charPrice) } : {}),
          ...(m.secondPrice ? { perSecondUsd: usd(m.secondPrice) } : {}),
          ...(m.requestPrice ? { perRequestUsd: usd(m.requestPrice) } : {}),
          ...(m.searchPrice ? { perSearchUsd: usd(m.searchPrice) } : {}),
          ...(m.audioInputPrice ? { audioInputPerMTok: usd(m.audioInputPrice) } : {}),
          ...(m.audioOutputPrice ? { audioOutputPerMTok: usd(m.audioOutputPrice) } : {}),
          // Context tiers and batch discount (card 27.5); the gateway prices tiers itself.
          ...(Array.isArray(m.pricingTiers) && m.pricingTiers.length > 0
            ? { tiers: m.pricingTiers as unknown as NonNullable<ModelPricing['tiers']> }
            : {}),
          ...(m.batchDiscount ? { batchDiscount: usd(m.batchDiscount) } : {}),
          // Flex and priority prices (card 31.5).
          ...(m.serviceTierPrices
            ? { serviceTiers: m.serviceTierPrices as NonNullable<ModelPricing['serviceTiers']> }
            : {}),
        },
        capabilities: m.capabilities as Record<string, boolean>,
        ...(m.isPublic && m.organizationId === platformId ? { public: true } : {}),
        ...saleOf(m),
        ...(m.deprecationDate
          ? { deprecationDate: m.deprecationDate.toISOString().slice(0, 10) }
          : {}),
        ...policyOf(m.requestPolicy),
      })),
      combos: combos
        .filter((c) => c.targets.some((t) => modelIds.has(t.modelId)))
        .map((c) => ({
          id: c.id,
          organizationId: c.organizationId,
          slug: c.slug,
          strategy: STRATEGY[c.strategy] ?? 'priority',
          targets: c.targets
            .filter((t) => modelIds.has(t.modelId))
            .sort((a, b) => a.order - b.order || a.modelId.localeCompare(b.modelId))
            .map((t) => ({ modelId: t.modelId, order: t.order, weight: t.weight })),
          ...(c.fallbackOn.length > 0 ? { fallbackOn: c.fallbackOn as never[] } : {}),
          retry: { maxAttempts: c.retryMaxAttempts },
          ...(c.timeouts ? { timeouts: c.timeouts as Record<string, number> } : {}),
          sticky: c.sticky,
          ...(c.hedging ? { hedging: c.hedging as Record<string, unknown> } : {}),
          ...(c.isPublic && c.organizationId === platformId ? { public: true } : {}),
        })),
      aliases: aliases
        .filter((a) =>
          a.modelId ? modelIds.has(a.modelId) : a.comboId ? comboIds.has(a.comboId) : false,
        )
        .map((a) => ({
          organizationId: a.organizationId,
          slug: a.slug,
          target: a.comboId
            ? { kind: 'combo' as const, comboId: a.comboId }
            : { kind: 'model' as const, modelId: a.modelId ?? '' },
          ...policyOf(a.requestPolicy),
        })),
      virtualKeys: keys.map((k) => {
        const walletId = walletOf.get(k.organizationId);
        return {
          id: k.id,
          hash: k.hash,
          prefix: k.prefix,
          organizationId: k.organizationId,
          teamId: teamOf.get(k.projectId) ?? null,
          projectId: k.projectId,
          enabled: true,
          expiresAt: k.expiresAt?.toISOString() ?? null,
          allowedModels: k.allowedModels,
          mcpTools: k.mcpTools,
          passthroughProviders: k.passthroughProviders,
          ipAllowlist: k.ipAllowlist,
          repair: k.repair.filter((r): r is RepairKind => r === 'json' || r === 'tools'),
          ...(strictParams.has(k.organizationId) ? { dropParams: false } : {}),
          ...rateLimit(k),
          budgets: budgetsFor('API_KEY', k.id),
          ...(walletId ? { walletId } : {}),
          ...(multiplierOf.has(k.organizationId)
            ? { priceMultiplier: multiplierOf.get(k.organizationId) ?? '1' }
            : {}),
        };
      }),
      limits: [
        ...policies
          .filter((p) => p.scope !== 'API_KEY')
          .map((p) => ({
            organizationId: p.organizationId,
            scope: p.scope === 'TEAM' ? ('team' as const) : ('project' as const),
            scopeId: p.scopeId,
            ...rateLimit(p),
            budgets: budgetsFor(p.scope, p.scopeId),
          })),
        // A project or team budget without a rate limit must also be included.
        ...[
          ...new Set(
            budgets
              .filter((b) => b.scope !== 'API_KEY')
              .map((b) => `${b.scope}|${b.scopeId}|${b.organizationId}`),
          ),
        ]
          .filter((k) => !policies.some((p) => `${p.scope}|${p.scopeId}|${p.organizationId}` === k))
          .map((k) => {
            const [scope = '', scopeId = '', organizationId = ''] = k.split('|');
            return {
              organizationId,
              scope: scope === 'TEAM' ? ('team' as const) : ('project' as const),
              scopeId,
              budgets: budgetsFor(scope, scopeId),
            };
          }),
      ],
      guardrails: guardrails.map((g) => ({
        id: g.id,
        organizationId: g.organizationId,
        name: g.name,
        enabled: g.enabled,
        stage: g.stage as 'request' | 'response' | 'both',
        type: g.type as never,
        action: g.action as never,
        config: g.config as Record<string, unknown>,
        ...(g.message ? { message: g.message } : {}),
        // Optional narrowing to one key or project; without these the policy covers the organization.
        ...(g.virtualKeyId ? { virtualKeyId: g.virtualKeyId } : {}),
        ...(g.projectId ? { projectId: g.projectId } : {}),
      })),
      settings: await this.gatewaySettings(),
      ...(platformId ? { platformOrganizationId: platformId } : {}),
      // MCP gateway (card 20.1); headers stay encrypted, the gateway decrypts them.
      mcpServers: mcpServers.map((m) => ({
        id: m.id,
        organizationId: m.organizationId,
        slug: m.slug,
        transport: m.transport as 'streamable-http' | 'sse' | 'a2a',
        url: m.url,
        enabled: m.enabled,
        ...(m.headersEnc ? { headers: m.headersEnc } : {}),
        ...(m.oauthEnc ? { oauth: m.oauthEnc } : {}),
        forwardIdentity: m.forwardIdentity,
        timeoutMs: m.timeoutMs,
      })),
      // Request body capture levels (card 24.1); absent while nobody has set one, so the image
      // (and its checksum) stays the same for instances that do not use the feature.
      ...(bodyCapture.length > 0
        ? {
            bodyCapture: bodyCapture.map((r) => ({
              organizationId: r.organizationId,
              scope: r.scope as 'organization' | 'project' | 'key',
              scopeId: r.scopeId,
              level: r.level as 'none' | 'metadata' | 'full',
            })),
          }
        : {}),
      // Routing rules (card 32.2); absent while nobody has one, like body capture above.
      ...(routingRules.length > 0
        ? {
            routingRules: routingRules.map((r) => ({
              id: r.id,
              organizationId: r.organizationId,
              name: r.name,
              enabled: r.enabled,
              priority: r.priority,
              ...(r.teamId ? { teamId: r.teamId } : {}),
              ...(r.projectId ? { projectId: r.projectId } : {}),
              condition: r.condition,
              action: r.action as never,
            })),
          }
        : {}),
      // Traffic splits (card 32.3); absent while nobody has one.
      ...(trafficSplits.length > 0
        ? {
            trafficSplits: trafficSplits.map((s) => ({
              id: s.id,
              organizationId: s.organizationId,
              name: s.name,
              enabled: s.enabled,
              version: s.version,
              match: s.match,
              stable: s.stable,
              canary: s.canary,
              canaryPercent: Number(s.canaryPercent),
              stickiness: s.stickiness as 'key' | 'session' | 'request',
              ...(s.autoRollback ? { autoRollback: s.autoRollback as never } : {}),
              state: s.state as 'active' | 'rolled_back',
            })),
          }
        : {}),
      // Shadow traffic policies (card 32.4); absent while nobody has one.
      ...(shadowPolicies.length > 0
        ? {
            shadowPolicies: shadowPolicies.map((p) => ({
              id: p.id,
              organizationId: p.organizationId,
              name: p.name,
              enabled: p.enabled,
              match: p.match,
              target: p.target,
              sampleRate: Number(p.sampleRate),
              dailyBudgetUsd: usd(p.dailyBudgetUsd) ?? '0',
              ...(p.projectId ? { projectId: p.projectId } : {}),
              timeoutMs: p.timeoutMs,
            })),
          }
        : {}),
      // Routing policies (cards 32.1, 32.5 and 32.7); absent while none is set, like bodyCapture.
      // A stored policy that no longer parses is left out rather than breaking the snapshot.
      ...(routingPolicies.length > 0
        ? {
            routingPolicies: routingPolicies.flatMap((r) => {
              const policy = RoutingPolicy.safeParse(r.policy);
              if (!policy.success) {
                this.logger.warn({ scope: r.scope, scopeId: r.scopeId }, 'invalid routing policy');
                return [];
              }
              return [
                {
                  organizationId: r.organizationId,
                  scope: r.scope as 'organization' | 'project' | 'key',
                  scopeId: r.scopeId,
                  ...policy.data,
                },
              ];
            }),
          }
        : {}),
    };
  }

  /**
   * Gateway-wide settings stored by the dashboard (single `gateway_settings` row). Read with raw SQL
   * so the snapshot keeps building even before the table exists (older database) or if the stored
   * JSON no longer matches the schema: in both cases the gateway falls back to its defaults.
   */
  async gatewaySettings(): Promise<ConfigSnapshotInput['settings']> {
    try {
      const rows = await this.prisma.client.$queryRaw<{ settings: unknown }[]>`
        SELECT "settings" FROM "gateway_settings" WHERE "id" = 'global' LIMIT 1`;
      const parsed = GatewaySettings.safeParse(rows[0]?.settings ?? {});
      if (parsed.success) return rows[0]?.settings ?? {};
      this.logger.warn(
        { issues: parsed.error.issues.slice(0, 5) },
        'stored gateway settings are invalid; using defaults',
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'gateway settings unavailable; using defaults');
    }
    return {};
  }

  /** A new version only if the content changed; returns the current version number. */
  rebuild(reason: string): Promise<number> {
    const run = this.#running.then(() => this.#rebuild(reason));
    this.#running = run.catch(() => undefined);
    return run;
  }

  async #rebuild(reason: string): Promise<number> {
    const content = stable(await this.build()) as Content;
    const checksum = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const db = this.prisma.client;
    const result = await db.$transaction(async (tx) => {
      // Multiple control-api replicas: only one builds a version at any moment.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${LOCK})`;
      const latest = await tx.configVersion.findFirst({ orderBy: { version: 'desc' } });
      if (latest?.checksum === checksum) return { version: latest.version, created: false };
      // A rolled-back or imported image stays published while the database is exactly as it was
      // when the image was pinned. Without this the periodic rebuild would undo a rollback within
      // 30 seconds. Any later change in the database lifts the pin and publishes from the database.
      if (latest) {
        const pinned = await tx.$queryRaw<{ base_checksum: string | null }[]>`
          SELECT "base_checksum" FROM "config_versions" WHERE "version" = ${latest.version}`;
        if (pinned[0]?.base_checksum === checksum)
          return { version: latest.version, created: false };
      }
      const row = await tx.configVersion.create({
        data: { checksum, reason, snapshot: {} },
      });
      const snapshot = ConfigSnapshot.parse({
        ...content,
        version: row.version,
        generatedAt: new Date().toISOString(),
        checksum,
      });
      await tx.configVersion.update({
        where: { version: row.version },
        data: { snapshot: snapshot as unknown as Prisma.InputJsonObject },
      });
      await tx.configVersion.deleteMany({
        where: { version: { lte: row.version - KEEP_VERSIONS } },
      });
      return { version: row.version, created: true };
    });
    if (result.created) {
      this.logger.info({ version: result.version, reason }, 'config snapshot published');
      await this.valkey.client
        .publish(CONFIG_CHANNEL, String(result.version))
        .catch((error: unknown) => {
          // The gateway always fetches the version via periodic polling (every 2 seconds).
          this.logger.warn({ err: error }, 'config:updated publish failed');
        });
    }
    return result.version;
  }

  async latest() {
    return this.prisma.client.configVersion.findFirst({ orderBy: { version: 'desc' } });
  }

  /**
   * Publish an explicit snapshot image (rollback or YAML import). The gateway only needs a newer
   * version with a valid image, so the image is re-versioned and stored as a new history row.
   */
  async publishSnapshot(snapshot: ConfigSnapshotInput, reason: string): Promise<number> {
    const checksum = createHash('sha256')
      .update(JSON.stringify(stable(snapshot)))
      .digest('hex');
    const db = this.prisma.client;
    // What the database would publish right now; stored with the pinned image (see #rebuild).
    const baseChecksum = createHash('sha256')
      .update(JSON.stringify(stable(await this.build())))
      .digest('hex');
    const row = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${LOCK})`;
      const created = await tx.configVersion.create({
        data: { checksum, reason, snapshot: {} },
      });
      await tx.$executeRaw`
        UPDATE "config_versions" SET "base_checksum" = ${baseChecksum}
        WHERE "version" = ${created.version}`;
      const image = ConfigSnapshot.parse({
        ...snapshot,
        version: created.version,
        generatedAt: new Date().toISOString(),
        checksum,
      });
      await tx.configVersion.update({
        where: { version: created.version },
        data: { snapshot: image as unknown as Prisma.InputJsonObject },
      });
      await tx.configVersion.deleteMany({
        where: { version: { lte: created.version - KEEP_VERSIONS } },
      });
      return created;
    });
    await this.valkey.client
      .publish(CONFIG_CHANNEL, String(row.version))
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'config:updated publish failed');
      });
    return row.version;
  }
}
