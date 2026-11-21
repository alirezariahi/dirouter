/**
 * pgvector semantic cache (card 13.2).
 *
 * Entries are keyed by (organization, model, prompt hash) and matched by cosine similarity above a
 * threshold. Embeddings come from an OpenAI-compatible embeddings endpoint configured with
 * SEMANTIC_CACHE_EMBEDDING_URL; without it the cache is a miss and stores are ignored (never an error
 * on the inference path). The vector column is fixed at 1536 dimensions.
 */
import { createHash } from 'node:crypto';

import { prefixedId } from '@dirouter/shared';
import { Inject, Injectable, type Logger } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { LOGGER } from '../infra/tokens.js';
import type { OrgContext } from '../rbac/org.guard.js';

const DIMENSIONS = 1536;
/** How long a "table is missing" answer is trusted before the database is asked again. */
const UNAVAILABLE_RECHECK_MS = 60_000;

export interface SemanticStoreInput {
  organizationId: string;
  /** Entries are isolated per project (card 13.2). */
  projectId?: string | undefined;
  /** Overrides SEMANTIC_CACHE_EMBEDDING_MODEL for this project; must produce 1536 dimensions. */
  embeddingModel?: string | undefined;
  modelId: string;
  model: string;
  text: string;
  response: unknown;
  ttlSeconds: number;
}

const asVector = (values: number[]) => `[${values.join(',')}]`;
const promptHash = (organizationId: string, model: string, text: string) =>
  createHash('sha256').update(`${organizationId}\u0000${model}\u0000${text}`).digest('hex');
/** Embedding models are free text from settings; keep them to a safe, bounded identifier. */
const MODEL_NAME = /^[\w./:@-]{1,200}$/;

@Injectable()
export class SemanticCacheService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  #tablePresent = false;
  #checkedAt = 0;

  /**
   * The migration skips `semantic_cache_entries` when the pgvector extension is not installed,
   * so every query on it must be guarded. A positive answer is cached for the process lifetime;
   * a negative one is re-checked after a minute (the extension may be installed later).
   */
  async available(): Promise<boolean> {
    if (this.#tablePresent) return true;
    if (Date.now() - this.#checkedAt < UNAVAILABLE_RECHECK_MS) return false;
    try {
      const present = async () => {
        const rows = await this.prisma.client.$queryRaw<{ present: boolean }[]>`
          SELECT to_regclass('semantic_cache_entries') IS NOT NULL AS present`;
        return rows[0]?.present === true;
      };
      this.#tablePresent = await present();
      // The migration ran before pgvector was installed (the usual order: the image is switched
      // when someone first wants the semantic cache). Create the table now instead of leaving
      // the feature dead until a manual SQL session.
      if (!this.#tablePresent && this.enabled) {
        await this.#createSchema();
        this.#tablePresent = await present();
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'semantic cache availability check failed');
      this.#tablePresent = false;
    }
    this.#checkedAt = Date.now();
    return this.#tablePresent;
  }

  get enabled(): boolean {
    return Boolean(this.env.SEMANTIC_CACHE_EMBEDDING_URL);
  }

  /**
   * Same objects as the migrations create when pgvector is present from the start. Every
   * statement is idempotent; when the extension cannot be created (plain postgres image, or a
   * database role without the privilege) this logs once per recheck and changes nothing.
   */
  async #createSchema(): Promise<void> {
    try {
      await this.prisma.client.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (error) {
      this.logger.warn(
        { reason: error instanceof Error ? error.message.split('\n')[0] : 'unknown' },
        'semantic cache unavailable: the pgvector extension is not installed in PostgreSQL',
      );
      return;
    }
    const statements = [
      `CREATE TABLE IF NOT EXISTS "semantic_cache_entries" (
         "id" TEXT NOT NULL,
         "organization_id" TEXT NOT NULL,
         "project_id" TEXT NOT NULL DEFAULT '',
         "embedding_model" TEXT NOT NULL DEFAULT '',
         "model_id" TEXT NOT NULL,
         "model_slug" TEXT NOT NULL,
         "prompt_hash" TEXT NOT NULL,
         "text" TEXT NOT NULL,
         "embedding" vector(${String(DIMENSIONS)}) NOT NULL,
         "response" JSONB NOT NULL,
         "expires_at" TIMESTAMPTZ(3) NOT NULL,
         "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
         CONSTRAINT "semantic_cache_entries_pkey" PRIMARY KEY ("id")
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "semantic_cache_scope_prompt_key"
         ON "semantic_cache_entries"("organization_id", "project_id", "embedding_model", "prompt_hash")`,
      `CREATE INDEX IF NOT EXISTS "semantic_cache_scope_idx"
         ON "semantic_cache_entries"("organization_id", "project_id", "model_slug")`,
      `CREATE INDEX IF NOT EXISTS "semantic_cache_expires_at_idx"
         ON "semantic_cache_entries"("expires_at")`,
      `CREATE INDEX IF NOT EXISTS "semantic_cache_embedding_idx"
         ON "semantic_cache_entries" USING hnsw ("embedding" vector_cosine_ops)`,
    ];
    try {
      for (const statement of statements) await this.prisma.client.$executeRawUnsafe(statement);
      this.logger.warn('semantic cache table created (pgvector was installed after migration)');
    } catch (error) {
      this.logger.warn({ err: error }, 'could not create the semantic cache table');
    }
  }

  /** The embedding model used for a request: the per-project override or the configured default. */
  embeddingModelFor(override?: string): string {
    return override && MODEL_NAME.test(override)
      ? override
      : this.env.SEMANTIC_CACHE_EMBEDDING_MODEL;
  }

  async #embed(text: string, model: string): Promise<number[] | undefined> {
    const url = this.env.SEMANTIC_CACHE_EMBEDDING_URL;
    if (!url) return undefined;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.env.SEMANTIC_CACHE_EMBEDDING_KEY
            ? { authorization: `Bearer ${this.env.SEMANTIC_CACHE_EMBEDDING_KEY}` }
            : {}),
        },
        body: JSON.stringify({
          model,
          input: text.slice(0, 20_000),
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as {
        data?: { embedding?: unknown }[];
      };
      const embedding = body.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length !== DIMENSIONS) {
        this.logger.warn(
          { length: Array.isArray(embedding) ? embedding.length : 0 },
          'semantic cache embedding has the wrong dimension',
        );
        return undefined;
      }
      return embedding as number[];
    } catch {
      return undefined;
    }
  }

  async query(input: {
    organizationId: string;
    projectId?: string | undefined;
    embeddingModel?: string | undefined;
    model: string;
    text: string;
    threshold: number;
  }): Promise<{ hit: boolean; similarity?: number; modelId?: string; response?: unknown }> {
    if (!this.enabled || !(await this.available())) return { hit: false };
    const embeddingModel = this.embeddingModelFor(input.embeddingModel);
    const projectId = input.projectId ?? '';
    const embedding = await this.#embed(input.text, embeddingModel);
    if (!embedding) return { hit: false };
    const vector = asVector(embedding);
    const rows = await this.prisma.client.$queryRaw<
      { model_id: string; response: unknown; similarity: number }[]
    >`
      SELECT model_id, response, 1 - (embedding <=> ${vector}::vector) AS similarity
      FROM semantic_cache_entries
      WHERE organization_id = ${input.organizationId}
        AND project_id = ${projectId}
        AND embedding_model = ${embeddingModel}
        AND model_slug = ${input.model}
        AND expires_at > now()
      ORDER BY embedding <=> ${vector}::vector
      LIMIT 1`;
    const row = rows[0];
    if (!row || row.similarity < input.threshold) return { hit: false };
    return {
      hit: true,
      similarity: row.similarity,
      modelId: row.model_id,
      response: row.response,
    };
  }

  async store(input: SemanticStoreInput): Promise<void> {
    if (!this.enabled || !(await this.available())) return;
    const embeddingModel = this.embeddingModelFor(input.embeddingModel);
    const projectId = input.projectId ?? '';
    const embedding = await this.#embed(input.text, embeddingModel);
    if (!embedding) return;
    const hash = promptHash(input.organizationId, input.model, input.text);
    await this.prisma.client.$executeRaw`
      INSERT INTO semantic_cache_entries
        (id, organization_id, project_id, embedding_model, model_id, model_slug, prompt_hash, text,
         embedding, response, expires_at)
      VALUES (
        ${prefixedId('sc')}, ${input.organizationId}, ${projectId}, ${embeddingModel},
        ${input.modelId}, ${input.model}, ${hash},
        ${input.text.slice(0, 20_000)}, ${asVector(embedding)}::vector,
        ${JSON.stringify(input.response)}::jsonb,
        now() + (${Math.max(1, Math.min(input.ttlSeconds, 2_592_000))} || ' seconds')::interval
      )
      ON CONFLICT (organization_id, project_id, embedding_model, prompt_hash) DO UPDATE SET
        model_id = EXCLUDED.model_id,
        text = EXCLUDED.text,
        embedding = EXCLUDED.embedding,
        response = EXCLUDED.response,
        expires_at = EXCLUDED.expires_at,
        created_at = now()`;
  }

  async purgeExpired(): Promise<number> {
    if (!(await this.available())) return 0;
    const result = await this.prisma.client.$executeRaw`
      DELETE FROM semantic_cache_entries WHERE expires_at <= now()`;
    return result;
  }

  /** `available: false` (with zero counters) when the table does not exist, never a 500. */
  async stats(org: OrgContext) {
    if (!(await this.available()))
      return {
        available: false,
        enabled: false,
        embeddingModel: null,
        entries: 0,
        textBytes: 0,
        dimensions: DIMENSIONS,
      };
    const [row] = await this.prisma.client.$queryRaw<
      { entries: bigint | number; bytes: bigint | number }[]
    >`
      SELECT count(*) AS entries, coalesce(sum(length(text)), 0) AS bytes
      FROM semantic_cache_entries
      WHERE organization_id = ${org.organizationId} AND expires_at > now()`;
    return {
      available: true,
      enabled: this.enabled,
      embeddingModel: this.enabled ? this.env.SEMANTIC_CACHE_EMBEDDING_MODEL : null,
      entries: Number(row?.entries ?? 0),
      textBytes: Number(row?.bytes ?? 0),
      dimensions: DIMENSIONS,
    };
  }

  async purgeOrg(org: OrgContext): Promise<number> {
    if (!(await this.available())) return 0;
    const result = await this.prisma.client.$executeRaw`
      DELETE FROM semantic_cache_entries WHERE organization_id = ${org.organizationId}`;
    await this.prisma.client.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org.organizationId,
        actorUserId: org.userId,
        ...(org.ip ? { ip: org.ip } : {}),
        action: 'cache.semantic_purged',
        targetType: 'organization',
        targetId: org.organizationId,
        diff: { entries: result } as never,
      },
    });
    return result;
  }

  /** Prompt excerpts of other users: only for callers who may administer the cache. */
  async sample(org: OrgContext, limit: number) {
    if (!(await this.available())) return [];
    return this.prisma.client.$queryRaw<
      { id: string; model_slug: string; text: string; expires_at: Date; created_at: Date }[]
    >`
      SELECT id, model_slug, left(text, 200) AS text, expires_at, created_at
      FROM semantic_cache_entries
      WHERE organization_id = ${org.organizationId}
      ORDER BY created_at DESC
      LIMIT ${Math.max(1, Math.min(limit, 100))}`;
  }
}

export { DIMENSIONS, promptHash };
