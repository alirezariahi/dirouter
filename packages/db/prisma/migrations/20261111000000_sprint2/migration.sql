-- Sprint 2: Bedrock/Vertex providers, new routing strategies, MFA/passkeys/SSO, custom roles,
-- guardrails, alerts and the pgvector semantic cache.

-- ───────────── Enums ─────────────

ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'bedrock';
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'vertex';

ALTER TYPE "ComboStrategy" ADD VALUE IF NOT EXISTS 'latency';
ALTER TYPE "ComboStrategy" ADD VALUE IF NOT EXISTS 'cost';
ALTER TYPE "ComboStrategy" ADD VALUE IF NOT EXISTS 'least-used';
ALTER TYPE "ComboStrategy" ADD VALUE IF NOT EXISTS 'headroom';

-- ───────────── Combos ─────────────

ALTER TABLE "combos" ADD COLUMN IF NOT EXISTS "sticky" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "combos" ADD COLUMN IF NOT EXISTS "hedging" JSONB;

-- ───────────── Security (cards 14.1–14.3) ─────────────

CREATE TABLE IF NOT EXISTS "user_mfa" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "backup_code_hashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "user_mfa_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_mfa_user_id_key" ON "user_mfa"("user_id");
ALTER TABLE "user_mfa" DROP CONSTRAINT IF EXISTS "user_mfa_user_id_fkey";
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "name" TEXT NOT NULL DEFAULT 'passkey',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "webauthn_credentials_credential_id_key" ON "webauthn_credentials"("credential_id");
CREATE INDEX IF NOT EXISTS "webauthn_credentials_user_id_idx" ON "webauthn_credentials"("user_id");
ALTER TABLE "webauthn_credentials" DROP CONSTRAINT IF EXISTS "webauthn_credentials_user_id_fkey";
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "sso_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_enc" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "default_role" "Role" NOT NULL DEFAULT 'MEMBER',
    "allowed_domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "sso_connections_organization_id_idx" ON "sso_connections"("organization_id");
ALTER TABLE "sso_connections" DROP CONSTRAINT IF EXISTS "sso_connections_organization_id_fkey";
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "custom_roles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "custom_roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "custom_roles_organization_id_name_key" ON "custom_roles"("organization_id", "name");
ALTER TABLE "custom_roles" DROP CONSTRAINT IF EXISTS "custom_roles_organization_id_fkey";
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────── Guardrails (card 15.1) ─────────────

CREATE TABLE IF NOT EXISTS "guardrail_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "stage" TEXT NOT NULL DEFAULT 'both',
    "type" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'block',
    "config" JSONB NOT NULL DEFAULT '{}',
    "message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "guardrail_policies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "guardrail_policies_organization_id_idx" ON "guardrail_policies"("organization_id");
ALTER TABLE "guardrail_policies" DROP CONSTRAINT IF EXISTS "guardrail_policies_organization_id_fkey";
ALTER TABLE "guardrail_policies" ADD CONSTRAINT "guardrail_policies_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────── Alerts (card 16.2) ─────────────

CREATE TABLE IF NOT EXISTS "notification_channels" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "notification_channels_organization_id_idx" ON "notification_channels"("organization_id");
ALTER TABLE "notification_channels" DROP CONSTRAINT IF EXISTS "notification_channels_organization_id_fkey";
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "alert_rules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "threshold" DECIMAL(18,8),
    "window_minutes" INTEGER NOT NULL DEFAULT 15,
    "channel_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "alert_rules_organization_id_idx" ON "alert_rules"("organization_id");
CREATE INDEX IF NOT EXISTS "alert_rules_channel_id_idx" ON "alert_rules"("channel_id");
ALTER TABLE "alert_rules" DROP CONSTRAINT IF EXISTS "alert_rules_organization_id_fkey";
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alert_rules" DROP CONSTRAINT IF EXISTS "alert_rules_channel_id_fkey";
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "alert_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "title" TEXT NOT NULL,
    "details" JSONB,
    "acknowledged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "alert_events_organization_id_created_at_idx" ON "alert_events"("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "alert_events_rule_id_idx" ON "alert_events"("rule_id");
ALTER TABLE "alert_events" DROP CONSTRAINT IF EXISTS "alert_events_organization_id_fkey";
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alert_events" DROP CONSTRAINT IF EXISTS "alert_events_rule_id_fkey";
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────── Semantic cache (card 13.2) ─────────────
-- pgvector is optional at the database level: when the extension is missing (for example a plain
-- postgres image), the migration still succeeds and the semantic cache is simply unavailable.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector is not available (%); semantic_cache_entries will be skipped', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS "semantic_cache_entries" (
        "id" TEXT NOT NULL,
        "organization_id" TEXT NOT NULL,
        "model_id" TEXT NOT NULL,
        "model_slug" TEXT NOT NULL,
        "prompt_hash" TEXT NOT NULL,
        "text" TEXT NOT NULL,
        "embedding" vector(1536) NOT NULL,
        -- CanonicalResponse as produced by the provider adapter.
        "response" JSONB NOT NULL,
        "expires_at" TIMESTAMPTZ(3) NOT NULL,
        "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "semantic_cache_entries_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "semantic_cache_org_prompt_key" ON "semantic_cache_entries"("organization_id", "prompt_hash");
    CREATE INDEX IF NOT EXISTS "semantic_cache_expires_at_idx" ON "semantic_cache_entries"("expires_at");
    CREATE INDEX IF NOT EXISTS "semantic_cache_embedding_idx" ON "semantic_cache_entries"
        USING hnsw ("embedding" vector_cosine_ops);
  END IF;
END $$;

-- Custom roles attach to memberships.
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "custom_role_id" TEXT;
CREATE INDEX IF NOT EXISTS "memberships_custom_role_id_idx" ON "memberships"("custom_role_id");
ALTER TABLE "memberships" DROP CONSTRAINT IF EXISTS "memberships_custom_role_id_fkey";
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_custom_role_id_fkey"
    FOREIGN KEY ("custom_role_id") REFERENCES "custom_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Organization security policy, scoped guardrails and alert silence/dedup.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "mfa_required_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "password_login_disabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sso_connections" ADD COLUMN IF NOT EXISTS "group_role_map" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "guardrail_policies" ADD COLUMN IF NOT EXISTS "virtual_key_id" TEXT;
ALTER TABLE "guardrail_policies" ADD COLUMN IF NOT EXISTS "project_id" TEXT;
CREATE INDEX IF NOT EXISTS "guardrail_policies_virtual_key_id_idx" ON "guardrail_policies"("virtual_key_id");
CREATE INDEX IF NOT EXISTS "guardrail_policies_project_id_idx" ON "guardrail_policies"("project_id");
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "silence_minutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "alert_events" ADD COLUMN IF NOT EXISTS "dedup_key" TEXT;
ALTER TABLE "alert_events" ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMPTZ(3);
ALTER TABLE "alert_events" ADD COLUMN IF NOT EXISTS "delivery_error" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "alert_events_rule_id_dedup_key_key" ON "alert_events"("rule_id", "dedup_key");

-- Cache/compression/hedging analytics (cards 12.2, 13.x, 16.5).
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "cache_hit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "cache_kind" TEXT;
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "saved_input_tokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "hedge_attempts" INTEGER NOT NULL DEFAULT 0;

-- Historical provider uptime (card 12.3).
CREATE TABLE IF NOT EXISTS "provider_health_samples" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "credential_id" TEXT,
    "ok" BOOLEAN NOT NULL,
    "status" INTEGER,
    "latency_ms" INTEGER NOT NULL,
    "error_class" TEXT,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_health_samples_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "provider_health_samples_provider_id_checked_at_idx" ON "provider_health_samples"("provider_id", "checked_at");
CREATE INDEX IF NOT EXISTS "provider_health_samples_credential_id_checked_at_idx" ON "provider_health_samples"("credential_id", "checked_at");

-- The audit trail is append-only even for a compromised application role.
CREATE OR REPLACE FUNCTION "reject_audit_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "audit_logs_append_only" ON "audit_logs";
CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "reject_audit_mutation"();

-- Provider types for Sprint 2 adapters (card 11.3 and 11.4).
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'cohere';
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'mistral';
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'voyage';
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'jina';
