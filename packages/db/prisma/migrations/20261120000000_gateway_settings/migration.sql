-- Gateway-wide runtime settings edited from the dashboard (cache, compression, tracing, session
-- affinity, health probes, breaker thresholds). A single row; the snapshot builder copies it into
-- ConfigSnapshot.settings so every replica receives changes through the normal config sync.
CREATE TABLE IF NOT EXISTS "gateway_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gateway_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gateway_settings_singleton" CHECK ("id" = 'global')
);

-- Semantic cache isolation (card 13.2): entries are scoped to a project and to the embedding model
-- that produced the vector, so projects never read each other's answers and vectors from different
-- embedding models are never compared. Existing rows keep '' and simply stop matching.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'semantic_cache_entries') THEN
    ALTER TABLE "semantic_cache_entries" ADD COLUMN IF NOT EXISTS "project_id" TEXT NOT NULL DEFAULT '';
    ALTER TABLE "semantic_cache_entries" ADD COLUMN IF NOT EXISTS "embedding_model" TEXT NOT NULL DEFAULT '';
    DROP INDEX IF EXISTS "semantic_cache_org_prompt_key";
    CREATE UNIQUE INDEX IF NOT EXISTS "semantic_cache_scope_prompt_key"
      ON "semantic_cache_entries"("organization_id", "project_id", "embedding_model", "prompt_hash");
    CREATE INDEX IF NOT EXISTS "semantic_cache_scope_idx"
      ON "semantic_cache_entries"("organization_id", "project_id", "model_slug");
  END IF;
END $$;

-- Pinned config versions (card 17.1): a rollback or import publishes an image that does not match
-- the database. `base_checksum` remembers the checksum of the database-built content at that
-- moment, so the periodic rebuild leaves the pinned version alone until the database changes.
ALTER TABLE "config_versions" ADD COLUMN IF NOT EXISTS "base_checksum" TEXT;
