-- Sprint 3, card 19.4: sale pricing, customer groups, plans and the marketplace.
-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'past_due', 'cancelled');

-- AlterTable
ALTER TABLE "combos" ADD COLUMN     "is_public" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "models" ADD COLUMN     "is_public" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sale_cache_multiplier" DECIMAL(14,8) NOT NULL DEFAULT 0,
ADD COLUMN     "sale_multiplier" DECIMAL(14,8) NOT NULL DEFAULT 1,
ADD COLUMN     "sale_per_request_usd" DECIMAL(18,8);

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "customer_group_id" TEXT;

-- AlterTable
ALTER TABLE "request_log" ADD COLUMN     "charge_usd" DECIMAL(18,8) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "usage_daily" ADD COLUMN     "charge_usd" DECIMAL(18,8) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "usage_hourly" ADD COLUMN     "charge_usd" DECIMAL(18,8) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "customer_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "multiplier" DECIMAL(14,8) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_usd" DECIMAL(18,8) NOT NULL,
    "included_usd" DECIMAL(18,8) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "used_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_groups_name_key" ON "customer_groups"("name");

-- CreateIndex
CREATE UNIQUE INDEX "plans_name_key" ON "plans"("name");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organization_id_key" ON "subscriptions"("organization_id");

-- CreateIndex
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_period_end_idx" ON "subscriptions"("status", "period_end");

-- CreateIndex
CREATE INDEX "organizations_customer_group_id_idx" ON "organizations"("customer_group_id");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_customer_group_id_fkey" FOREIGN KEY ("customer_group_id") REFERENCES "customer_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_multiplier_positive" CHECK ("multiplier" > 0);
ALTER TABLE "plans" ADD CONSTRAINT "plans_amounts_valid" CHECK ("price_usd" >= 0 AND "included_usd" >= 0);
ALTER TABLE "models" ADD CONSTRAINT "models_sale_valid"
  CHECK ("sale_multiplier" >= 0 AND "sale_cache_multiplier" >= 0
         AND ("sale_per_request_usd" IS NULL OR "sale_per_request_usd" >= 0));
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_period_valid" CHECK ("period_end" > "period_start");

-- Before sale pricing existed, every request was charged at cost.
UPDATE "request_log" SET "charge_usd" = "cost_usd" WHERE "charge_usd" = 0 AND "cost_usd" <> 0;
UPDATE "usage_hourly" SET "charge_usd" = "cost_usd" WHERE "charge_usd" = 0 AND "cost_usd" <> 0;
UPDATE "usage_daily" SET "charge_usd" = "cost_usd" WHERE "charge_usd" = 0 AND "cost_usd" <> 0;

-- Rollups also sum what customers were charged (profit report, card 19.6).
CREATE OR REPLACE FUNCTION dirouter_rollup_hour(at_hour timestamptz)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  start_ts timestamptz := date_trunc('hour', at_hour, 'UTC');
  affected integer;
BEGIN
  INSERT INTO usage_hourly AS u (
    bucket, organization_id, project_id, api_key_id, model_slug, provider_id, team_id,
    requests, errors, input_tokens, output_tokens, cache_read_tokens, cost_usd, charge_usd,
    latency_ms_sum, ttft_ms_sum, ttft_count, latency_hist
  )
  SELECT
    start_ts, organization_id, project_id, api_key_id, requested_model, coalesce(provider_id, ''),
    max(team_id),
    count(*)::int,
    count(*) FILTER (WHERE status <> 'success')::int,
    sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cost_usd),
    sum(charge_usd), sum(latency_ms), coalesce(sum(ttft_ms), 0), count(ttft_ms)::int,
    ARRAY[
      count(*) FILTER (WHERE b = 1)::int,
      count(*) FILTER (WHERE b = 2)::int,
      count(*) FILTER (WHERE b = 3)::int,
      count(*) FILTER (WHERE b = 4)::int,
      count(*) FILTER (WHERE b = 5)::int,
      count(*) FILTER (WHERE b = 6)::int,
      count(*) FILTER (WHERE b = 7)::int,
      count(*) FILTER (WHERE b = 8)::int,
      count(*) FILTER (WHERE b = 9)::int,
      count(*) FILTER (WHERE b = 10)::int
    ]
  FROM (
    SELECT *, dirouter_latency_bucket(latency_ms) AS b
    FROM request_log
    WHERE created_at >= start_ts AND created_at < start_ts + interval '1 hour'
  ) r
  GROUP BY organization_id, project_id, api_key_id, requested_model, coalesce(provider_id, '')
  ON CONFLICT (bucket, organization_id, project_id, api_key_id, model_slug, provider_id) DO UPDATE SET
    team_id = EXCLUDED.team_id,
    requests = EXCLUDED.requests,
    errors = EXCLUDED.errors,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_read_tokens = EXCLUDED.cache_read_tokens,
    cost_usd = EXCLUDED.cost_usd,
    charge_usd = EXCLUDED.charge_usd,
    latency_ms_sum = EXCLUDED.latency_ms_sum,
    ttft_ms_sum = EXCLUDED.ttft_ms_sum,
    ttft_count = EXCLUDED.ttft_count,
    latency_hist = EXCLUDED.latency_hist;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- Full calculation of one day (UTC) from the hourly table.
CREATE OR REPLACE FUNCTION dirouter_rollup_day(day date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  start_ts timestamptz := day::timestamp AT TIME ZONE 'UTC';
  affected integer;
BEGIN
  INSERT INTO usage_daily AS u (
    bucket, organization_id, project_id, api_key_id, model_slug, provider_id, team_id,
    requests, errors, input_tokens, output_tokens, cache_read_tokens, cost_usd, charge_usd,
    latency_ms_sum, ttft_ms_sum, ttft_count, latency_hist
  )
  SELECT
    day, organization_id, project_id, api_key_id, model_slug, provider_id, max(team_id),
    sum(requests)::int, sum(errors)::int, sum(input_tokens), sum(output_tokens),
    sum(cache_read_tokens), sum(cost_usd), sum(charge_usd), sum(latency_ms_sum), sum(ttft_ms_sum),
    sum(ttft_count)::int, dirouter_int_array_sum(latency_hist)
  FROM usage_hourly
  WHERE bucket >= start_ts AND bucket < start_ts + interval '1 day'
  GROUP BY organization_id, project_id, api_key_id, model_slug, provider_id
  ON CONFLICT (bucket, organization_id, project_id, api_key_id, model_slug, provider_id) DO UPDATE SET
    team_id = EXCLUDED.team_id,
    requests = EXCLUDED.requests,
    errors = EXCLUDED.errors,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_read_tokens = EXCLUDED.cache_read_tokens,
    cost_usd = EXCLUDED.cost_usd,
    charge_usd = EXCLUDED.charge_usd,
    latency_ms_sum = EXCLUDED.latency_ms_sum,
    ttft_ms_sum = EXCLUDED.ttft_ms_sum,
    ttft_count = EXCLUDED.ttft_count,
    latency_hist = EXCLUDED.latency_hist;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
