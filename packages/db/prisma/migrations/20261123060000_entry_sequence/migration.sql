-- Sprint 3, card 19.6: exact statement order of customer wallet entries. Postings commit in lock
-- order, which created_at (the transaction start time) does not follow; the wallet version after
-- each posting does.
ALTER TABLE "wallet_entries" ADD COLUMN "sequence" INTEGER;
CREATE INDEX "wallet_entries_wallet_id_sequence_idx" ON "wallet_entries"("wallet_id", "sequence");

-- Existing entries get their order of creation within each wallet. The ledger is append-only, so
-- its triggers are suspended for this one backfill (it writes `sequence` only, never amounts).
ALTER TABLE "wallet_entries" DISABLE TRIGGER "wallet_entries_no_update_delete";
ALTER TABLE "wallet_entries" DISABLE TRIGGER "wallet_entries_balanced";
UPDATE "wallet_entries" e SET "sequence" = n.seq
  FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "wallet_id" ORDER BY "created_at", "id") AS seq
          FROM "wallet_entries" WHERE "balance_after" IS NOT NULL) n
 WHERE e."id" = n."id";
ALTER TABLE "wallet_entries" ENABLE TRIGGER "wallet_entries_balanced";
ALTER TABLE "wallet_entries" ENABLE TRIGGER "wallet_entries_no_update_delete";
