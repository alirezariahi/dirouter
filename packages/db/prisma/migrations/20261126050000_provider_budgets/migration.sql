-- Sprint 5, card 32.6: budgets per upstream provider and credential, quota windows and the
-- credential strategy of a provider.
-- AlterEnum


ALTER TYPE "LimitScope" ADD VALUE IF NOT EXISTS 'provider_account';
ALTER TYPE "LimitScope" ADD VALUE IF NOT EXISTS 'credential';

-- AlterTable
ALTER TABLE "credentials" ADD COLUMN     "quota_windows" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "providers" ADD COLUMN     "credential_strategy" TEXT NOT NULL DEFAULT 'weighted';

-- AlterTable
ALTER TABLE "usage_ledger" ADD COLUMN     "credential_id" TEXT;


ALTER TABLE "providers" ADD CONSTRAINT "providers_credential_strategy_valid"
  CHECK ("credential_strategy" IN ('weighted', 'fill-first', 'reset-aware'));
