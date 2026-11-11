-- Monthly partitioning of request_log (card 3.2).
--
-- Partitions are created in a separate "partitions" schema so that Prisma (which only
-- manages the "public" schema) does not detect them as drift.
-- The worker calls dirouter_ensure_request_log_partitions(3) every hour so that
-- the current month's partition and the next three months' partitions always exist, and
-- dirouter_drop_request_log_partitions(<retention>) removes old partitions.

CREATE SCHEMA IF NOT EXISTS "partitions";

-- Default partition: if the month's partition is missing for any reason, the insert does not fail.
CREATE TABLE IF NOT EXISTS "partitions"."request_log_default"
  PARTITION OF "request_log" DEFAULT;

CREATE OR REPLACE FUNCTION dirouter_ensure_request_log_partitions(months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  month_start date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  part_start date;
  part_end date;
  part_name text;
  created integer := 0;
BEGIN
  FOR i IN 0..months_ahead LOOP
    part_start := (month_start + make_interval(months => i))::date;
    part_end := (part_start + interval '1 month')::date;
    part_name := format('request_log_%s', to_char(part_start, 'YYYY_MM'));
    IF to_regclass(format('partitions.%I', part_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE partitions.%I PARTITION OF public.request_log FOR VALUES FROM (%L) TO (%L)',
        part_name, part_start::timestamptz, part_end::timestamptz
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$;

-- Drops partitions older than retain_months months (the current month is not counted). Retention
-- applies to the raw log; rollup tables and the ledger are not deleted.
CREATE OR REPLACE FUNCTION dirouter_drop_request_log_partitions(retain_months integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff date := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => retain_months))::date;
  rec record;
  dropped integer := 0;
BEGIN
  FOR rec IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = 'public.request_log'::regclass
      AND n.nspname = 'partitions'
      AND c.relname ~ '^request_log_\d{4}_\d{2}$'
      AND to_date(substring(c.relname from '\d{4}_\d{2}$'), 'YYYY_MM') < cutoff
  LOOP
    EXECUTE format('DROP TABLE partitions.%I', rec.relname);
    dropped := dropped + 1;
  END LOOP;
  RETURN dropped;
END;
$$;

SELECT dirouter_ensure_request_log_partitions(3);
