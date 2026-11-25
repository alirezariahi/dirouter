-- Sprint 5, card 33.3: limits of a key on one model, and input and output TPM apart.
-- AlterEnum
ALTER TYPE "LimitScope" ADD VALUE IF NOT EXISTS 'api_key_model';

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "input_tpm" INTEGER,
ADD COLUMN     "model_limits" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "output_tpm" INTEGER;

-- AlterTable
ALTER TABLE "rate_limit_policies" ADD COLUMN     "input_tpm" INTEGER,
ADD COLUMN     "output_tpm" INTEGER;

-- AlterTable
ALTER TABLE "usage_ledger" ADD COLUMN     "requested_model" TEXT;


