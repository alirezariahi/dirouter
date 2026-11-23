-- Sprint 3, card 19.1: prepaid wallets and a double-entry ledger.
-- CreateEnum
CREATE TYPE "WalletKind" AS ENUM ('customer', 'system');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "is_platform" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "prepaid" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "kind" "WalletKind" NOT NULL,
    "organization_id" TEXT,
    "code" TEXT,
    "balance_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_entries" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "amount_usd" DECIMAL(18,8) NOT NULL,
    "balance_after" DECIMAL(18,8),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_organization_id_key" ON "wallets"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_code_key" ON "wallets"("code");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_idempotency_key_key" ON "wallet_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_transactions_kind_created_at_idx" ON "wallet_transactions"("kind", "created_at");

-- CreateIndex
CREATE INDEX "wallet_entries_wallet_id_created_at_idx" ON "wallet_entries"("wallet_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_entries_transaction_id_idx" ON "wallet_entries"("transaction_id");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "wallet_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A customer wallet can never go below zero; system wallets are counter-accounts and may.
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_customer_non_negative"
  CHECK ("kind" = 'system' OR "balance_usd" >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_owner_matches_kind"
  CHECK (("kind" = 'customer' AND "organization_id" IS NOT NULL AND "code" IS NULL)
      OR ("kind" = 'system' AND "organization_id" IS NULL AND "code" IS NOT NULL));
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_non_zero" CHECK ("amount_usd" <> 0);

-- Double-entry invariant: at commit, the entries of every touched transaction sum to zero and a
-- transaction has at least two legs. Deferred, so the legs can be inserted one by one.
CREATE OR REPLACE FUNCTION "wallet_transaction_balanced"() RETURNS trigger AS $$
DECLARE
  total NUMERIC;
  legs INTEGER;
BEGIN
  SELECT COALESCE(SUM("amount_usd"), 0), COUNT(*) INTO total, legs
    FROM "wallet_entries" WHERE "transaction_id" = NEW."transaction_id";
  IF total <> 0 OR legs < 2 THEN
    RAISE EXCEPTION 'wallet transaction % is unbalanced (sum %, legs %)', NEW."transaction_id", total, legs
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "wallet_entries_balanced"
  AFTER INSERT OR UPDATE ON "wallet_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "wallet_transaction_balanced"();

-- The ledger is append-only: corrections are new transactions, never edits.
CREATE OR REPLACE FUNCTION "wallet_entries_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet entries are append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "wallet_entries_no_update_delete"
  BEFORE UPDATE OR DELETE ON "wallet_entries"
  FOR EACH ROW EXECUTE FUNCTION "wallet_entries_append_only"();

-- System wallets.
INSERT INTO "wallets" ("id", "kind", "code", "updated_at") VALUES
  ('wal_system_revenue', 'system', 'revenue', CURRENT_TIMESTAMP),
  ('wal_system_funding', 'system', 'funding', CURRENT_TIMESTAMP),
  ('wal_system_promo', 'system', 'promo', CURRENT_TIMESTAMP),
  ('wal_system_writeoff', 'system', 'writeoff', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- The organization created by the setup wizard (the oldest one) is the operator.
UPDATE "organizations" SET "is_platform" = true
 WHERE "id" = (SELECT "id" FROM "organizations" WHERE "deleted_at" IS NULL ORDER BY "created_at", "id" LIMIT 1);
