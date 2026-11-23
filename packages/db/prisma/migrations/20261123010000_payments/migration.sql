-- Sprint 3, card 19.2: online top-ups (Zarinpal, Stripe) and operator billing settings.
-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'expired');

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "amount_usd" DECIMAL(18,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "exchange_rate" DECIMAL(24,8) NOT NULL,
    "provider_ref" TEXT,
    "provider_tx_id" TEXT,
    "return_url" TEXT,
    "failure_reason" TEXT,
    "transaction_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_created_at_idx" ON "payments"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_provider_ref_key" ON "payments"("provider", "provider_ref");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_singleton" CHECK ("id" = 'global');
ALTER TABLE "payments" ADD CONSTRAINT "payments_positive" CHECK ("amount_usd" > 0 AND "amount_minor" > 0 AND "exchange_rate" > 0);
