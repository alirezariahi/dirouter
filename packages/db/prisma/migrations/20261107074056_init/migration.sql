-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('openai', 'azure-openai', 'openai-compatible', 'anthropic', 'gemini', 'mock');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ComboStrategy" AS ENUM ('priority', 'weighted', 'round-robin');

-- CreateEnum
CREATE TYPE "LimitScope" AS ENUM ('api_key', 'project', 'team');

-- CreateEnum
CREATE TYPE "BudgetPeriod" AS ENUM ('daily', 'monthly');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "team_id" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "allowed_models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ip_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rpm" INTEGER,
    "tpm" INTEGER,
    "max_concurrency" INTEGER,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "rotated_to_id" TEXT,
    "last_used_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ProviderType" NOT NULL,
    "base_url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "proxy_url" TEXT,
    "timeouts" JSONB,
    "options" JSONB NOT NULL DEFAULT '{}',
    "max_concurrency" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL,
    "last4" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "cooldown_until" TIMESTAMPTZ(3),
    "headers" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "models" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "upstream_model" TEXT NOT NULL,
    "display_name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "context_window" INTEGER,
    "max_output_tokens" INTEGER,
    "input_price" DECIMAL(18,8) NOT NULL,
    "output_price" DECIMAL(18,8) NOT NULL,
    "cache_read_price" DECIMAL(18,8),
    "cache_write_price" DECIMAL(18,8),
    "reasoning_price" DECIMAL(18,8),
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "catalog_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_aliases" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "model_id" TEXT,
    "combo_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "model_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combos" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "strategy" "ComboStrategy" NOT NULL DEFAULT 'priority',
    "fallback_on" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "retry_max_attempts" INTEGER NOT NULL DEFAULT 2,
    "timeouts" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "combos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combo_targets" (
    "id" TEXT NOT NULL,
    "combo_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "combo_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "scope" "LimitScope" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "period" "BudgetPeriod" NOT NULL,
    "limit_usd" DECIMAL(18,8),
    "limit_tokens" BIGINT,
    "alert_thresholds" INTEGER[] DEFAULT ARRAY[50, 80, 100]::INTEGER[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "scope" "LimitScope" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "rpm" INTEGER,
    "tpm" INTEGER,
    "max_concurrency" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limit_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_log" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "organization_id" TEXT NOT NULL,
    "team_id" TEXT,
    "project_id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "end_user" TEXT,
    "inbound_api" TEXT NOT NULL,
    "requested_model" TEXT NOT NULL,
    "model_id" TEXT,
    "provider_id" TEXT,
    "credential_id" TEXT,
    "stream" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "http_status" INTEGER NOT NULL,
    "error_code" TEXT,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "reasoning_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(18,8) NOT NULL,
    "usage_estimated" BOOLEAN NOT NULL DEFAULT false,
    "latency_ms" INTEGER NOT NULL,
    "ttft_ms" INTEGER,
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "config_version" INTEGER NOT NULL,
    "gateway_instance" TEXT NOT NULL,

    CONSTRAINT "request_log_pkey" PRIMARY KEY ("id","created_at")
) PARTITION BY RANGE ("created_at");

-- CreateTable
CREATE TABLE "usage_ledger" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "team_id" TEXT,
    "project_id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "cost_usd" DECIMAL(18,8) NOT NULL,
    "tokens" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_hourly" (
    "bucket" TIMESTAMPTZ(3) NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "model_slug" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "team_id" TEXT,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "latency_ms_sum" BIGINT NOT NULL DEFAULT 0,
    "ttft_ms_sum" BIGINT NOT NULL DEFAULT 0,
    "ttft_count" INTEGER NOT NULL DEFAULT 0,
    "latency_hist" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "usage_hourly_pkey" PRIMARY KEY ("bucket","organization_id","project_id","api_key_id","model_slug","provider_id")
);

-- CreateTable
CREATE TABLE "usage_daily" (
    "bucket" DATE NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "model_slug" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "team_id" TEXT,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "latency_ms_sum" BIGINT NOT NULL DEFAULT 0,
    "ttft_ms_sum" BIGINT NOT NULL DEFAULT 0,
    "ttft_count" INTEGER NOT NULL DEFAULT 0,
    "latency_hist" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("bucket","organization_id","project_id","api_key_id","model_slug","provider_id")
);

-- CreateTable
CREATE TABLE "config_versions" (
    "version" SERIAL NOT NULL,
    "checksum" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_versions_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "diff" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_organization_id_idx" ON "memberships"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_organization_id_key" ON "memberships"("user_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_idx" ON "invitations"("organization_id");

-- CreateIndex
CREATE INDEX "invitations_invited_by_id_idx" ON "invitations"("invited_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_organization_id_slug_key" ON "teams"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "projects_team_id_idx" ON "projects"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_slug_key" ON "projects"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_rotated_to_id_key" ON "api_keys"("rotated_to_id");

-- CreateIndex
CREATE INDEX "api_keys_organization_id_idx" ON "api_keys"("organization_id");

-- CreateIndex
CREATE INDEX "api_keys_project_id_idx" ON "api_keys"("project_id");

-- CreateIndex
CREATE INDEX "api_keys_created_by_id_idx" ON "api_keys"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "providers_organization_id_slug_key" ON "providers"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "credentials_provider_id_idx" ON "credentials"("provider_id");

-- CreateIndex
CREATE INDEX "models_provider_id_idx" ON "models"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "models_organization_id_slug_key" ON "models"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "model_aliases_model_id_idx" ON "model_aliases"("model_id");

-- CreateIndex
CREATE INDEX "model_aliases_combo_id_idx" ON "model_aliases"("combo_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_aliases_organization_id_slug_key" ON "model_aliases"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "combos_organization_id_slug_key" ON "combos"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "combo_targets_model_id_idx" ON "combo_targets"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "combo_targets_combo_id_model_id_key" ON "combo_targets"("combo_id", "model_id");

-- CreateIndex
CREATE INDEX "budgets_organization_id_idx" ON "budgets"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_scope_scope_id_period_key" ON "budgets"("scope", "scope_id", "period");

-- CreateIndex
CREATE INDEX "rate_limit_policies_organization_id_idx" ON "rate_limit_policies"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_policies_scope_scope_id_key" ON "rate_limit_policies"("scope", "scope_id");

-- CreateIndex
CREATE INDEX "request_log_project_id_created_at_idx" ON "request_log"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "request_log_api_key_id_created_at_idx" ON "request_log"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "request_log_organization_id_created_at_idx" ON "request_log"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "request_log_status_idx" ON "request_log"("status");

-- CreateIndex
CREATE UNIQUE INDEX "usage_ledger_request_id_key" ON "usage_ledger"("request_id");

-- CreateIndex
CREATE INDEX "usage_ledger_organization_id_occurred_at_idx" ON "usage_ledger"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_ledger_project_id_occurred_at_idx" ON "usage_ledger"("project_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_ledger_api_key_id_occurred_at_idx" ON "usage_ledger"("api_key_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_ledger_team_id_occurred_at_idx" ON "usage_ledger"("team_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_hourly_organization_id_bucket_idx" ON "usage_hourly"("organization_id", "bucket");

-- CreateIndex
CREATE INDEX "usage_daily_organization_id_bucket_idx" ON "usage_daily"("organization_id", "bucket");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_idx" ON "audit_logs"("actor_user_id");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_rotated_to_id_fkey" FOREIGN KEY ("rotated_to_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "providers" ADD CONSTRAINT "providers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "models" ADD CONSTRAINT "models_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "models" ADD CONSTRAINT "models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combos" ADD CONSTRAINT "combos_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_targets" ADD CONSTRAINT "combo_targets_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_targets" ADD CONSTRAINT "combo_targets_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_limit_policies" ADD CONSTRAINT "rate_limit_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
