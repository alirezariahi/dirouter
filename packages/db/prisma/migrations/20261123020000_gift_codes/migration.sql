-- Sprint 3, card 19.3: gift and recharge codes.
-- CreateTable
CREATE TABLE "gift_code_batches" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_usd" DECIMAL(18,8) NOT NULL,
    "max_redemptions" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_code_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_codes" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "redemptions" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_code_redemptions" (
    "id" TEXT NOT NULL,
    "code_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "redeemed_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_code_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gift_codes_code_hash_key" ON "gift_codes"("code_hash");

-- CreateIndex
CREATE INDEX "gift_codes_batch_id_idx" ON "gift_codes"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_code_redemptions_transaction_id_key" ON "gift_code_redemptions"("transaction_id");

-- CreateIndex
CREATE INDEX "gift_code_redemptions_organization_id_idx" ON "gift_code_redemptions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_code_redemptions_code_id_organization_id_key" ON "gift_code_redemptions"("code_id", "organization_id");

-- AddForeignKey
ALTER TABLE "gift_codes" ADD CONSTRAINT "gift_codes_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gift_code_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_code_redemptions" ADD CONSTRAINT "gift_code_redemptions_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "gift_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_code_redemptions" ADD CONSTRAINT "gift_code_redemptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- The redemption cap is enforced by the database as well as by the conditional update.
ALTER TABLE "gift_code_batches" ADD CONSTRAINT "gift_code_batches_valid"
  CHECK ("amount_usd" > 0 AND "max_redemptions" >= 1 AND "kind" IN ('gift', 'recharge'));
