/**
 * ساخت و انتشار Config Snapshot (کارت ۳.۹).
 *
 * - snapshot کل پیکربندی همهٔ سازمان‌ها برای گیت‌وی: providerها با secret **رمزشده**، مدل‌ها،
 *   aliasها، comboها، کلیدها (فقط hash)، محدودیت‌ها و بودجه‌ها. هیچ secret بازی در آن نیست.
 * - بعد از هر تغییر مؤثر (debounce کوتاه) دوباره ساخته می‌شود؛ اگر checksum عوض شده باشد نسخهٔ
 *   تازه با شمارهٔ افزایشی در config_versions ذخیره و `dirouter:config:updated` روی Valkey
 *   منتشر می‌شود. گیت‌وی با دریافت پیام بی‌درنگ (و هر ۲ ثانیه با ETag) نسخه را می‌گیرد.
 */
import { createHash } from 'node:crypto';

import {
  CONFIG_SNAPSHOT_SCHEMA_VERSION,
  ConfigSnapshot,
  type ConfigSnapshotInput,
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
  MOCK: 'mock',
};
const STRATEGY: Record<string, 'priority' | 'weighted' | 'round-robin'> = {
  PRIORITY: 'priority',
  WEIGHTED: 'weighted',
  ROUND_ROBIN: 'round-robin',
};
const usd = (d: Prisma.Decimal | null | undefined) =>
  d === null || d === undefined ? undefined : d.toFixed(8).replace(/\.?0+$/, '') || '0';

type Content = Omit<ConfigSnapshotInput, 'version' | 'generatedAt' | 'checksum'>;

/** کلیدها مرتب می‌شوند تا checksum فقط با تغییر واقعی عوض شود. */
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
    // اولین نسخه یا هم‌گام شدن با تغییراتی که هنگام خاموشی رخ داده‌اند.
    await this.rebuild('startup').catch((error: unknown) => {
      this.logger.error({ err: error }, 'initial config snapshot failed');
    });
    // تور ایمنی: تغییر مستقیم DB (seed، ابزار) و انقضای کلیدها؛ بدون تغییر نسخه‌ای ساخته نمی‌شود.
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

  /** چند تغییر پشت سر هم یک نسخه می‌سازند. */
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
    const [providers, models, combos, aliases, keys, projects, budgets, policies] =
      await Promise.all([
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
        // کلیدهای ابطال‌شده یا منقضی‌شده دیگر لازم نیستند؛ نبودنشان یعنی رد.
        db.apiKey.findMany({
          where: { status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          orderBy: { id: 'asc' },
        }),
        db.project.findMany({ select: { id: true, teamId: true } }),
        db.budget.findMany({ orderBy: { id: 'asc' } }),
        db.rateLimitPolicy.findMany({ orderBy: { id: 'asc' } }),
      ]);
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
        type: (TYPE[p.type] ?? 'openai-compatible') as 'openai',
        name: p.name,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        options: p.options as Record<string, unknown>,
        ...(p.proxyUrl ? { proxy: { url: p.proxyUrl } } : {}),
        ...(p.timeouts ? { timeouts: p.timeouts as Record<string, number> } : {}),
        ...(p.maxConcurrency ? { maxConcurrency: p.maxConcurrency } : {}),
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
        },
        capabilities: m.capabilities as Record<string, boolean>,
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
        })),
      virtualKeys: keys.map((k) => ({
        id: k.id,
        hash: k.hash,
        prefix: k.prefix,
        organizationId: k.organizationId,
        teamId: teamOf.get(k.projectId) ?? null,
        projectId: k.projectId,
        enabled: true,
        expiresAt: k.expiresAt?.toISOString() ?? null,
        allowedModels: k.allowedModels,
        ipAllowlist: k.ipAllowlist,
        ...rateLimit(k),
        budgets: budgetsFor('API_KEY', k.id),
      })),
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
        // بودجهٔ پروژه یا تیم بدون rate limit هم باید برسد.
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
      settings: {},
    };
  }

  /** نسخهٔ تازه فقط اگر محتوا عوض شده باشد؛ برمی‌گرداند شمارهٔ نسخهٔ فعلی. */
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
      // چند replica از control-api: فقط یکی در هر لحظه نسخه می‌سازد.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${LOCK})`;
      const latest = await tx.configVersion.findFirst({ orderBy: { version: 'desc' } });
      if (latest?.checksum === checksum) return { version: latest.version, created: false };
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
          // گیت‌وی در هر صورت با poll دوره‌ای (۲ ثانیه) نسخه را می‌گیرد.
          this.logger.warn({ err: error }, 'config:updated publish failed');
        });
    }
    return result.version;
  }

  async latest() {
    return this.prisma.client.configVersion.findFirst({ orderBy: { version: 'desc' } });
  }
}
