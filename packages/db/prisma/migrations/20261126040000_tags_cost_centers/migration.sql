-- Sprint 5, card 33.4: tags and cost centers on keys, requests and the ledger, with budgets and
-- usage per tag and cost center.
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LimitScope" ADD VALUE IF NOT EXISTS 'tag';
ALTER TYPE "LimitScope" ADD VALUE IF NOT EXISTS 'cost_center';

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "cost_center" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "request_log" ADD COLUMN     "cost_center" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "usage_ledger" ADD COLUMN     "cost_center" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];



-- Attribution rows now also carry every tag of a request and its cost center (the rollups in
-- 20261126020000_end_users stay as they are, with the same cap of 1000 values per hour).
CREATE OR REPLACE FUNCTION dirouter_dimension_rows(start_ts timestamptz, end_ts timestamptz)
RETURNS TABLE (
  organization_id text, dimension text, value text, project_id text, api_key_id text,
  model_slug text, provider_id text, failed boolean, input_tokens integer, output_tokens integer,
  cost_usd numeric, charge_usd numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT r.organization_id, d.dimension, d.value, r.project_id, r.api_key_id, r.requested_model,
         coalesce(r.provider_id, ''), r.status <> 'success', r.input_tokens, r.output_tokens,
         r.cost_usd, r.charge_usd
  FROM request_log r
  CROSS JOIN LATERAL (
    SELECT 'end_user'::text AS dimension, r.end_user AS value WHERE r.end_user IS NOT NULL
    UNION ALL
    SELECT 'tag', t FROM unnest(r.tags) AS t
    UNION ALL
    SELECT 'cost_center', r.cost_center WHERE r.cost_center IS NOT NULL
  ) d
  WHERE r.created_at >= start_ts AND r.created_at < end_ts
$$;
