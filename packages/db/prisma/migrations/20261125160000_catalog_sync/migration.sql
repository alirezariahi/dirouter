-- CreateEnum
CREATE TYPE "CatalogProposalStatus" AS ENUM ('pending', 'approved', 'rejected', 'superseded');

-- AlterTable
ALTER TABLE "models" ADD COLUMN     "batch_discount" DECIMAL(7,6),
ADD COLUMN     "deprecation_date" DATE,
ADD COLUMN     "price_override" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pricing_tiers" JSONB;

-- CreateTable
CREATE TABLE "catalog_models" (
    "key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "upstream_model" TEXT NOT NULL,
    "context_window" INTEGER,
    "max_output_tokens" INTEGER,
    "pricing" JSONB NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "deprecation_date" DATE,
    "mode" TEXT,
    "source" TEXT NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_models_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "catalog_price_proposals" (
    "id" TEXT NOT NULL,
    "catalog_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "current_pricing" JSONB,
    "proposed_pricing" JSONB NOT NULL,
    "change_factor" DECIMAL(12,4),
    "reason" TEXT NOT NULL,
    "status" "CatalogProposalStatus" NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "applied_models" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_price_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_sync_runs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sources" TEXT[],
    "mode" TEXT NOT NULL,
    "added" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "repriced" INTEGER NOT NULL DEFAULT 0,
    "proposed" INTEGER NOT NULL DEFAULT 0,
    "removed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "catalog_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_sync_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_sync_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_models_provider_upstream_model_idx" ON "catalog_models"("provider", "upstream_model");

-- CreateIndex
CREATE INDEX "catalog_price_proposals_status_created_at_idx" ON "catalog_price_proposals"("status", "created_at");

-- CreateIndex
CREATE INDEX "catalog_price_proposals_catalog_key_status_idx" ON "catalog_price_proposals"("catalog_key", "status");

-- CreateIndex
CREATE INDEX "catalog_sync_runs_started_at_idx" ON "catalog_sync_runs"("started_at");

