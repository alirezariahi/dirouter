/**
 * Provider and credential (card 3.6). The secret is entered only once and encrypted with AES-256-GCM and
 * MASTER_KEY (AAD = credential ID), and is never returned in a response or log. The response
 * shows only `••••last4`. The connection test and model discovery go through the gateway (`/internal/providers/probe`)
 * so the same adapter, proxy, and timeout used for real traffic apply.
 */
import { DiRouterError, encrypt, keyVersionOf, prefixedId } from '@dirouter/shared';
import { Prisma } from '@dirouter/db';
import { Inject, Injectable } from '@nestjs/common';

import { slugify } from '../common/ids.js';
import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

export const PROVIDER_TYPES = [
  'openai',
  'azure-openai',
  'openai-compatible',
  'anthropic',
  'gemini',
] as const;
export type ProviderTypeName = (typeof PROVIDER_TYPES)[number];

const TO_DB = {
  openai: 'OPENAI',
  'azure-openai': 'AZURE_OPENAI',
  'openai-compatible': 'OPENAI_COMPATIBLE',
  anthropic: 'ANTHROPIC',
  gemini: 'GEMINI',
  mock: 'MOCK',
} as const;
const FROM_DB = Object.fromEntries(Object.entries(TO_DB).map(([k, v]) => [v, k])) as Record<
  string,
  ProviderTypeName
>;

/** Default baseUrl for official types; must be provided for compatible providers and Azure. */
const DEFAULT_BASE: Partial<Record<ProviderTypeName, string>> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

export interface TimeoutsInput {
  connectMs?: number | undefined;
  firstByteMs?: number | undefined;
  idleMs?: number | undefined;
  totalMs?: number | undefined;
}
export interface CredentialInput {
  name: string;
  secret: string;
  weight?: number | undefined;
  headers?: Record<string, string> | undefined;
  proxyUrl?: string | null | undefined;
}
export interface ProviderInput {
  name: string;
  slug?: string | undefined;
  type: ProviderTypeName;
  baseUrl?: string | undefined;
  enabled?: boolean | undefined;
  proxyUrl?: string | null | undefined;
  timeouts?: TimeoutsInput | null | undefined;
  options?: Record<string, unknown> | undefined;
  maxConcurrency?: number | null | undefined;
  credentials?: CredentialInput[] | undefined;
}

type ProviderRow = Awaited<ReturnType<ProvidersService['load']>>;

const mask = (last4: string) => `••••${last4}`;
const notFound = () => new DiRouterError('not_found');

@Injectable()
export class ProvidersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get db() {
    return this.prisma.client;
  }

  #keyring() {
    return this.env.MASTER_KEY;
  }

  #encrypt(id: string, secret: string) {
    const secretEnc = encrypt(this.#keyring(), secret, id);
    return { secretEnc, keyVersion: keyVersionOf(secretEnc), last4: secret.slice(-4) };
  }

  /** Public shape: no secret or ciphertext field is exposed. */
  view(p: ProviderRow) {
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      type: FROM_DB[p.type] ?? 'openai-compatible',
      baseUrl: p.baseUrl,
      enabled: p.enabled,
      proxyUrl: p.proxyUrl ? maskUrl(p.proxyUrl) : null,
      timeouts: p.timeouts ?? null,
      options: p.options,
      maxConcurrency: p.maxConcurrency,
      credentials: p.credentials.map((c) => ({
        id: c.id,
        name: c.name,
        secret: mask(c.last4),
        weight: c.weight,
        status: c.status,
        cooldownUntil: c.cooldownUntil?.toISOString() ?? null,
        headers: Object.keys((c.headers ?? {}) as object),
        proxyUrl: c.proxyUrl ? maskUrl(c.proxyUrl) : null,
      })),
      createdAt: p.createdAt.toISOString(),
    };
  }

  async load(ctx: OrgContext, id: string) {
    const p = await this.db.provider.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
      include: { credentials: { orderBy: { createdAt: 'asc' } } },
    });
    if (!p) throw notFound();
    return p;
  }

  async list(ctx: OrgContext) {
    const rows = await this.db.provider.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      include: { credentials: { orderBy: { createdAt: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((p) => this.view(p));
  }

  async create(ctx: OrgContext, input: ProviderInput) {
    const baseUrl = input.baseUrl ?? DEFAULT_BASE[input.type];
    if (!baseUrl)
      throw new DiRouterError('validation_failed', {
        message: `baseUrl is required for ${input.type}`,
      });
    const id = prefixedId('prv');
    await this.db.$transaction(async (tx) => {
      await tx.provider.create({
        data: {
          id,
          organizationId: ctx.organizationId,
          slug: input.slug ?? slugify(input.name),
          name: input.name,
          type: TO_DB[input.type],
          baseUrl,
          enabled: input.enabled ?? true,
          proxyUrl: input.proxyUrl ?? null,
          ...(input.timeouts ? { timeouts: input.timeouts as Prisma.InputJsonObject } : {}),
          options: (input.options ?? {}) as Prisma.InputJsonObject,
          maxConcurrency: input.maxConcurrency ?? null,
        },
      });
      for (const c of input.credentials ?? []) {
        const cid = prefixedId('cred');
        await tx.credential.create({
          data: {
            id: cid,
            providerId: id,
            name: c.name,
            ...this.#encrypt(cid, c.secret),
            weight: c.weight ?? 1,
            headers: c.headers ?? {},
            proxyUrl: c.proxyUrl ?? null,
          },
        });
      }
      await this.#audit(tx, ctx, 'provider.created', 'provider', id, {
        name: input.name,
        type: input.type,
      });
    });
    return this.view(await this.load(ctx, id));
  }

  async update(
    ctx: OrgContext,
    id: string,
    input: Partial<Omit<ProviderInput, 'credentials' | 'type'>>,
  ) {
    await this.load(ctx, id);
    await this.db.provider.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.proxyUrl !== undefined ? { proxyUrl: input.proxyUrl } : {}),
        ...(input.timeouts !== undefined
          ? {
              timeouts:
                input.timeouts === null
                  ? Prisma.DbNull
                  : (input.timeouts as Prisma.InputJsonObject),
            }
          : {}),
        ...(input.options !== undefined
          ? { options: input.options as Prisma.InputJsonObject }
          : {}),
        ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
      },
    });
    await this.#audit(this.db, ctx, 'provider.updated', 'provider', id, redactInput(input));
    return this.view(await this.load(ctx, id));
  }

  async remove(ctx: OrgContext, id: string) {
    await this.load(ctx, id);
    await this.db.provider.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false, slug: `deleted-${id}` },
    });
    await this.#audit(this.db, ctx, 'provider.deleted', 'provider', id);
  }

  async addCredential(ctx: OrgContext, providerId: string, c: CredentialInput) {
    await this.load(ctx, providerId);
    const cid = prefixedId('cred');
    await this.db.credential.create({
      data: {
        id: cid,
        providerId,
        name: c.name,
        ...this.#encrypt(cid, c.secret),
        weight: c.weight ?? 1,
        headers: c.headers ?? {},
        proxyUrl: c.proxyUrl ?? null,
      },
    });
    await this.#audit(this.db, ctx, 'credential.created', 'credential', cid, {
      providerId,
      name: c.name,
    });
    return this.view(await this.load(ctx, providerId));
  }

  async updateCredential(
    ctx: OrgContext,
    providerId: string,
    credentialId: string,
    c: Partial<CredentialInput> & { status?: 'ACTIVE' | 'DISABLED' | undefined },
  ) {
    const p = await this.load(ctx, providerId);
    if (!p.credentials.some((x) => x.id === credentialId)) throw notFound();
    await this.db.credential.update({
      where: { id: credentialId },
      data: {
        ...(c.name !== undefined ? { name: c.name } : {}),
        ...(c.secret !== undefined ? this.#encrypt(credentialId, c.secret) : {}),
        ...(c.weight !== undefined ? { weight: c.weight } : {}),
        ...(c.headers !== undefined ? { headers: c.headers } : {}),
        ...(c.proxyUrl !== undefined ? { proxyUrl: c.proxyUrl } : {}),
        ...(c.status !== undefined ? { status: c.status } : {}),
      },
    });
    await this.#audit(
      this.db,
      ctx,
      c.secret ? 'credential.rotated' : 'credential.updated',
      'credential',
      credentialId,
      {
        ...redactInput(c),
      },
    );
    return this.view(await this.load(ctx, providerId));
  }

  async removeCredential(ctx: OrgContext, providerId: string, credentialId: string) {
    const p = await this.load(ctx, providerId);
    if (!p.credentials.some((x) => x.id === credentialId)) throw notFound();
    await this.db.credential.delete({ where: { id: credentialId } });
    await this.#audit(this.db, ctx, 'credential.deleted', 'credential', credentialId, {
      providerId,
    });
  }

  /** Contract ProviderConfig shape, with an encrypted secret; for the gateway probe (and the snapshot in 3.9). */
  toConfig(p: ProviderRow) {
    return {
      id: p.id,
      organizationId: p.organizationId,
      slug: p.slug,
      type: FROM_DB[p.type] ?? 'openai-compatible',
      name: p.name,
      baseUrl: p.baseUrl,
      enabled: p.enabled,
      options: p.options as Record<string, unknown>,
      ...(p.proxyUrl ? { proxy: { url: p.proxyUrl } } : {}),
      ...(p.timeouts ? { timeouts: p.timeouts as TimeoutsInput } : {}),
      ...(p.maxConcurrency ? { maxConcurrency: p.maxConcurrency } : {}),
      credentials: p.credentials.map((c) => ({
        id: c.id,
        name: c.name,
        secret: c.secretEnc,
        enabled: c.status === 'ACTIVE',
        weight: c.weight,
        headers: c.headers as Record<string, string>,
        ...(c.proxyUrl ? { proxy: { url: c.proxyUrl } } : {}),
      })),
    };
  }

  async #probe(ctx: OrgContext, providerId: string, credentialId?: string) {
    const p = await this.load(ctx, providerId);
    if (credentialId && !p.credentials.some((c) => c.id === credentialId)) throw notFound();
    const res = await fetch(
      `${this.env.GATEWAY_INTERNAL_URL.replace(/\/+$/, '')}/internal/providers/probe`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.env.INTERNAL_TOKEN}`,
        },
        body: JSON.stringify({
          provider: this.toConfig(p),
          ...(credentialId ? { credentialId } : {}),
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
      status?: number;
      latencyMs: number;
      error?: { class: string; message: string };
      models: { id: string; catalog?: { key: string; contextWindow?: number; pricing: unknown } }[];
    };
    return { provider: p, result };
  }

  async test(ctx: OrgContext, providerId: string, credentialId?: string) {
    const { result } = await this.#probe(ctx, providerId, credentialId);
    return {
      ok: result.ok,
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.error ? { error: result.error } : {}),
      modelCount: result.models.length,
    };
  }

  /** Upstream models; those not yet in the organization's catalog are suggested. */
  async discover(ctx: OrgContext, providerId: string) {
    const { provider, result } = await this.#probe(ctx, providerId);
    const known = new Set(
      (
        await this.db.model.findMany({
          where: { organizationId: ctx.organizationId, providerId: provider.id, deletedAt: null },
          select: { upstreamModel: true },
        })
      ).map((m) => m.upstreamModel),
    );
    return {
      ok: result.ok,
      latencyMs: result.latencyMs,
      ...(result.error ? { error: result.error } : {}),
      models: result.models.map((m) => ({
        upstreamModel: m.id,
        inCatalog: known.has(m.id),
        suggested: !known.has(m.id),
        ...(m.catalog ? { catalog: m.catalog } : {}),
      })),
    };
  }

  async #audit(
    db: Pick<PrismaService['client'], 'auditLog'>,
    ctx: OrgContext,
    action: string,
    targetType: string,
    targetId: string,
    diff?: object,
  ) {
    await db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action,
        targetType,
        targetId,
        ...(diff ? { diff } : {}),
      },
    });
  }
}

/** The audit log also does not record the secret or the proxy password. */
function redactInput(input: object): object {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'secret') out[k] = '[REDACTED]';
    else if (k === 'proxyUrl' && typeof v === 'string') out[k] = maskUrl(v);
    else out[k] = v;
  }
  return out;
}

export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '[invalid url]';
  }
}
