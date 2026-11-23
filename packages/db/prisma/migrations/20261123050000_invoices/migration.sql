-- Sprint 3, card 19.6: monthly invoices.
-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "opening_usd" DECIMAL(18,8) NOT NULL,
    "closing_usd" DECIMAL(18,8) NOT NULL,
    "totals" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_period_idx" ON "invoices"("period");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_period_key" ON "invoices"("organization_id", "period");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "invoices" ADD CONSTRAINT "invoices_period_format" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
