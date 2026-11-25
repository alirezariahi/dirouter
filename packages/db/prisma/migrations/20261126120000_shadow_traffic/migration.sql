-- Sprint 5, card 32.4: shadow traffic policies and the shadow copies, billed apart from the
-- request log, the ledger and wallets.
CREATE TABLE "shadow_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "match" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "sample_rate" DECIMAL(5,4) NOT NULL,
    "daily_budget_usd" DECIMAL(18,8) NOT NULL,
    "project_id" TEXT,
    "timeout_ms" INTEGER NOT NULL DEFAULT 60000,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shadow_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shadow_requests" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "organization_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "primary_request_id" TEXT NOT NULL,
    "model_id" TEXT,
    "status" TEXT NOT NULL,
    "http_status" INTEGER NOT NULL,
    "error_code" TEXT,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_usd" DECIMAL(18,8) NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "primary_model" TEXT,
    "primary_status" INTEGER NOT NULL,
    "primary_latency_ms" INTEGER NOT NULL,
    "primary_cost_usd" DECIMAL(18,8) NOT NULL,

    CONSTRAINT "shadow_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shadow_policies_organization_id_idx" ON "shadow_policies"("organization_id");
CREATE INDEX "shadow_requests_organization_id_policy_id_created_at_idx" ON "shadow_requests"("organization_id", "policy_id", "created_at");

ALTER TABLE "shadow_policies" ADD CONSTRAINT "shadow_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
