-- Sprint 5, card 33.2: end users of an organization's own product, with limits, budgets,
-- blocking and usage per end user.
-- AlterEnum
ALTER TYPE "LimitScope" ADD VALUE IF NOT EXISTS 'end_user';

-- AlterTable
ALTER TABLE "usage_ledger" ADD COLUMN     "end_user" TEXT;


-- CreateTable
CREATE TABLE "end_users" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "end_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_dimension_hourly" (
    "bucket" TIMESTAMPTZ(3) NOT NULL,
    "organization_id" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "model_slug" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "charge_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,

    CONSTRAINT "usage_dimension_hourly_pkey" PRIMARY KEY ("bucket","organization_id","dimension","value","project_id","api_key_id","model_slug","provider_id")
);

-- CreateTable
CREATE TABLE "usage_dimension_daily" (
    "bucket" DATE NOT NULL,
    "organization_id" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "model_slug" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "charge_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,

    CONSTRAINT "usage_dimension_daily_pkey" PRIMARY KEY ("bucket","organization_id","dimension","value","project_id","api_key_id","model_slug","provider_id")
);

-- CreateIndex
CREATE INDEX "end_users_organization_id_last_seen_at_idx" ON "end_users"("organization_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "end_users_organization_id_external_id_key" ON "end_users"("organization_id", "external_id");

-- CreateIndex
CREATE INDEX "usage_dimension_hourly_organization_id_dimension_bucket_idx" ON "usage_dimension_hourly"("organization_id", "dimension", "bucket");

-- CreateIndex
CREATE INDEX "usage_dimension_daily_organization_id_dimension_bucket_idx" ON "usage_dimension_daily"("organization_id", "dimension", "bucket");


-- Attribution rows of one time range: one row per request and dimension. Card 33.4 adds tags and
-- cost centers by replacing this function; the rollups below stay as they are.
CREATE OR REPLACE FUNCTION dirouter_dimension_rows(start_ts timestamptz, end_ts timestamptz)
RETURNS TABLE (
  organization_id text, dimension text, value text, project_id text, api_key_id text,
  model_slug text, provider_id text, failed boolean, input_tokens integer, output_tokens integer,
  cost_usd numeric, charge_usd numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT r.organization_id, 'end_user', r.end_user, r.project_id, r.api_key_id, r.requested_model,
         coalesce(r.provider_id, ''), r.status <> 'success', r.input_tokens, r.output_tokens,
         r.cost_usd, r.charge_usd
  FROM request_log r
  WHERE r.created_at >= start_ts AND r.created_at < end_ts AND r.end_user IS NOT NULL
$$;

-- One hour of usage per dimension value. At most 1000 values per organization and dimension keep
-- their own rows (the busiest); the rest are summed as `__other__`, so a product with millions of
-- end users (or a client sending random tags) cannot blow up the table. Recomputed from scratch.
CREATE OR REPLACE FUNCTION dirouter_rollup_dimensions_hour(at_hour timestamptz)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  start_ts timestamptz := date_trunc('hour', at_hour, 'UTC');
  affected integer;
BEGIN
  DELETE FROM usage_dimension_hourly WHERE bucket = start_ts;
  INSERT INTO usage_dimension_hourly (
    bucket, organization_id, dimension, value, project_id, api_key_id, model_slug, provider_id,
    requests, errors, input_tokens, output_tokens, cost_usd, charge_usd
  )
  WITH src AS (
    SELECT * FROM dirouter_dimension_rows(start_ts, start_ts + interval '1 hour')
  ), ranked AS (
    SELECT s.organization_id, s.dimension, s.value,
           row_number() OVER (PARTITION BY s.organization_id, s.dimension
                              ORDER BY count(*) DESC, s.value) AS rank
    FROM src s
    GROUP BY s.organization_id, s.dimension, s.value
  )
  SELECT start_ts, s.organization_id, s.dimension,
         CASE WHEN k.rank <= 1000 THEN s.value ELSE '__other__' END,
         s.project_id, s.api_key_id, s.model_slug, s.provider_id,
         count(*)::int, (count(*) FILTER (WHERE s.failed))::int,
         sum(s.input_tokens), sum(s.output_tokens), sum(s.cost_usd), sum(s.charge_usd)
  FROM src s
  JOIN ranked k ON k.organization_id = s.organization_id AND k.dimension = s.dimension
               AND k.value = s.value
  GROUP BY 2, 3, 4, 5, 6, 7, 8;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- One day (UTC) from the hourly table, with the same cap.
CREATE OR REPLACE FUNCTION dirouter_rollup_dimensions_day(day date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  start_ts timestamptz := day::timestamp AT TIME ZONE 'UTC';
  affected integer;
BEGIN
  DELETE FROM usage_dimension_daily WHERE bucket = day;
  INSERT INTO usage_dimension_daily (
    bucket, organization_id, dimension, value, project_id, api_key_id, model_slug, provider_id,
    requests, errors, input_tokens, output_tokens, cost_usd, charge_usd
  )
  WITH src AS (
    SELECT * FROM usage_dimension_hourly
    WHERE bucket >= start_ts AND bucket < start_ts + interval '1 day'
  ), ranked AS (
    SELECT s.organization_id, s.dimension, s.value,
           row_number() OVER (PARTITION BY s.organization_id, s.dimension
                              ORDER BY s.value = '__other__', sum(s.requests) DESC, s.value) AS rank
    FROM src s
    GROUP BY s.organization_id, s.dimension, s.value
  )
  SELECT day, s.organization_id, s.dimension,
         CASE WHEN k.rank <= 1000 THEN s.value ELSE '__other__' END,
         s.project_id, s.api_key_id, s.model_slug, s.provider_id,
         sum(s.requests)::int, sum(s.errors)::int, sum(s.input_tokens), sum(s.output_tokens),
         sum(s.cost_usd), sum(s.charge_usd)
  FROM src s
  JOIN ranked k ON k.organization_id = s.organization_id AND k.dimension = s.dimension
               AND k.value = s.value
  GROUP BY 2, 3, 4, 5, 6, 7, 8;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
