-- Sprint 4, card 26.1: tax fields on invoices, legal details of the parties, VAT in the ledger,
-- and gap-free, immutable invoice numbering enforced by the database.

-- AlterTable
ALTER TABLE "invoices"
  ADD COLUMN "vat_percent" DECIMAL(5,2),
  ADD COLUMN "gross_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN "net_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN "vat_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN "exchange_rate_irr" DECIMAL(18,8),
  ADD COLUMN "seller" JSONB,
  ADD COLUMN "buyer" JSONB,
  ADD COLUMN "ledger_transaction_id" TEXT;

-- Invoices issued before this card carry no VAT: their taxable amount is net and gross alike.
UPDATE "invoices" SET
  "gross_usd" = CASE WHEN "basis" = 'prepaid'
    THEN -(COALESCE(("totals"->>'usage')::numeric, 0) + COALESCE(("totals"->>'plan')::numeric, 0))
    ELSE "closing_usd" END;
UPDATE "invoices" SET "net_usd" = "gross_usd";

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vat_percent_range"
  CHECK ("vat_percent" IS NULL OR ("vat_percent" >= 0 AND "vat_percent" < 100));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tax_adds_up"
  CHECK ("net_usd" + "vat_usd" = "gross_usd" AND "vat_usd" >= 0);

-- CreateTable
CREATE TABLE "billing_profiles" (
    "organization_id" TEXT NOT NULL,
    "party_type" TEXT NOT NULL DEFAULT 'legal',
    "legal_name" TEXT NOT NULL,
    "national_id" TEXT,
    "economic_code" TEXT,
    "registration_number" TEXT,
    "address" TEXT,
    "postal_code" TEXT,
    "phone" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_profiles_pkey" PRIMARY KEY ("organization_id")
);

-- AddForeignKey
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_party_type"
  CHECK ("party_type" IN ('legal', 'natural'));
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_digits"
  CHECK (("national_id" IS NULL OR "national_id" ~ '^[0-9]{10,11}$')
     AND ("economic_code" IS NULL OR "economic_code" ~ '^[0-9]{10,14}$')
     AND ("postal_code" IS NULL OR "postal_code" ~ '^[0-9]{10}$'));

-- System accounts for VAT payable and postpaid receivables.
INSERT INTO "wallets" ("id", "kind", "code", "updated_at") VALUES
  ('wal_system_vat', 'system', 'vat', CURRENT_TIMESTAMP),
  ('wal_system_receivable', 'system', 'receivable', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- Numbers are INV-<year>-<6 digits> and each one must be the next of its year: a skipped or reused
-- number fails the insert. The application numbers under an advisory lock; this is the backstop.
CREATE OR REPLACE FUNCTION "invoices_number_gap_free"() RETURNS trigger AS $$
DECLARE
  expected integer;
BEGIN
  IF NEW."number" !~ '^INV-[0-9]{4}-[0-9]{6}$' THEN
    RAISE EXCEPTION 'invoice number % is not INV-<year>-<6 digits>', NEW."number" USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(MAX(substr("number", 10)::integer), 0) + 1 INTO expected
    FROM "invoices" WHERE "number" LIKE substr(NEW."number", 1, 9) || '%';
  IF substr(NEW."number", 10)::integer <> expected THEN
    RAISE EXCEPTION 'invoice number % breaks the sequence (next is %)', NEW."number", expected
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "invoices_gap_free"
  BEFORE INSERT ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION "invoices_number_gap_free"();

-- An issued invoice is never edited or deleted, so no number can disappear from the sequence.
CREATE OR REPLACE FUNCTION "invoices_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'issued invoices cannot be changed or deleted' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "invoices_no_update_delete"
  BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION "invoices_immutable"();
