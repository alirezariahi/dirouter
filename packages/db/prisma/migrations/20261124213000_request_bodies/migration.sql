-- Request body capture (card 24.1).
--
-- body_capture_settings: an explicit capture level per organization, project or virtual key.
-- request_bodies: what was captured, in DAILY partitions with a retention of its own
-- (REQUEST_BODY_RETENTION_DAYS in the worker), independent of request_log's monthly partitions.
-- Partitions live in the "partitions" schema like request_log's, so Prisma sees no drift.

-- CreateTable
CREATE TABLE "body_capture_settings" (
    "organization_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "body_capture_settings_pkey" PRIMARY KEY ("organization_id","scope","scope_id")
);

-- CreateTable
CREATE TABLE "request_bodies" (
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "inbound_api" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "request" TEXT,
    "request_truncated" BOOLEAN NOT NULL DEFAULT false,
    "response" TEXT,
    "response_truncated" BOOLEAN NOT NULL DEFAULT false,
    "streamed" BOOLEAN NOT NULL DEFAULT false,
    "redactions" INTEGER NOT NULL DEFAULT 0,
    "replay" JSONB,

    CONSTRAINT "request_bodies_pkey" PRIMARY KEY ("request_id","created_at")
) PARTITION BY RANGE ("created_at");

-- CreateIndex
CREATE INDEX "request_bodies_organization_id_created_at_idx" ON "request_bodies"("organization_id", "created_at");

CREATE SCHEMA IF NOT EXISTS "partitions";

-- Default partition: a row for a day without a partition is still written (and the retention
-- function trims it by date).
CREATE TABLE IF NOT EXISTS "partitions"."request_bodies_default"
  PARTITION OF "request_bodies" DEFAULT;

-- Creates today's partition and the next days_ahead days'. A day whose rows already sit in the
-- default partition cannot get its own partition; it is skipped with a notice and stays there.
CREATE OR REPLACE FUNCTION dirouter_ensure_request_body_partitions(days_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  day_start date := (now() AT TIME ZONE 'UTC')::date;
  part_start date;
  part_name text;
  created integer := 0;
BEGIN
  FOR i IN 0..days_ahead LOOP
    part_start := day_start + i;
    part_name := format('request_bodies_%s', to_char(part_start, 'YYYY_MM_DD'));
    IF to_regclass(format('partitions.%I', part_name)) IS NULL THEN
      BEGIN
        EXECUTE format(
          'CREATE TABLE partitions.%I PARTITION OF public.request_bodies FOR VALUES FROM (%L) TO (%L)',
          part_name, (part_start::timestamp AT TIME ZONE 'UTC'), ((part_start + 1)::timestamp AT TIME ZONE 'UTC')
        );
        created := created + 1;
      EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'request_bodies: % has rows in the default partition, skipped', part_name;
      END;
    END IF;
  END LOOP;
  RETURN created;
END;
$$;

-- Drops day partitions older than retain_days days (today is not counted) and trims the default
-- partition to the same cutoff. Returns the number of partitions dropped.
CREATE OR REPLACE FUNCTION dirouter_drop_request_body_partitions(retain_days integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff date := (now() AT TIME ZONE 'UTC')::date - retain_days;
  rec record;
  dropped integer := 0;
BEGIN
  FOR rec IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = 'public.request_bodies'::regclass
      AND n.nspname = 'partitions'
      AND c.relname ~ '^request_bodies_\d{4}_\d{2}_\d{2}$'
      AND to_date(substring(c.relname from '\d{4}_\d{2}_\d{2}$'), 'YYYY_MM_DD') < cutoff
  LOOP
    EXECUTE format('DROP TABLE partitions.%I', rec.relname);
    dropped := dropped + 1;
  END LOOP;
  DELETE FROM partitions.request_bodies_default
    WHERE created_at < (cutoff::timestamp AT TIME ZONE 'UTC');
  RETURN dropped;
END;
$$;

SELECT dirouter_ensure_request_body_partitions(3);
