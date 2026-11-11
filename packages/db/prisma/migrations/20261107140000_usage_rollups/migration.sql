-- Hourly and daily usage rollups (cards 3.2 and 6.5).
--
-- After writing each batch, the worker marks the changed hours and calls these functions for
-- those same hours/days. Each call recalculates the bucket from scratch and completely
-- (idempotent), so a late event or a repeated run does not double the numbers.
--
-- Latency histogram: 10 buckets with boundaries at 100, 250, 500, and 1000 milliseconds, 2.5, 5, 10, 30, and 60 seconds, and above.

CREATE OR REPLACE FUNCTION dirouter_latency_bucket(ms integer)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT width_bucket(ms, ARRAY[100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]) + 1 $$;

-- Element-wise sum of arrays (to build the daily histogram from hourly ones).
CREATE OR REPLACE FUNCTION dirouter_int_array_add(a integer[], b integer[])
RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN a IS NULL OR cardinality(a) = 0 THEN b
    WHEN b IS NULL OR cardinality(b) = 0 THEN a
    ELSE ARRAY(
      SELECT coalesce(a[i], 0) + coalesce(b[i], 0)
      FROM generate_series(1, greatest(cardinality(a), cardinality(b))) AS i
    )
  END
$$;

CREATE OR REPLACE AGGREGATE dirouter_int_array_sum(integer[]) (
  SFUNC = dirouter_int_array_add,
  STYPE = integer[],
  INITCOND = '{}'
);

-- Full calculation of one hour from request_log. model_slug is the model the client requested
-- (model, alias, or combo), and an empty provider_id means no provider responded.
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
    requests, errors, input_tokens, output_tokens, cache_read_tokens, cost_usd,
    latency_ms_sum, ttft_ms_sum, ttft_count, latency_hist
  )
  SELECT
    start_ts, organization_id, project_id, api_key_id, requested_model, coalesce(provider_id, ''),
    max(team_id),
    count(*)::int,
    count(*) FILTER (WHERE status <> 'success')::int,
    sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cost_usd),
    sum(latency_ms), coalesce(sum(ttft_ms), 0), count(ttft_ms)::int,
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
    requests, errors, input_tokens, output_tokens, cache_read_tokens, cost_usd,
    latency_ms_sum, ttft_ms_sum, ttft_count, latency_hist
  )
  SELECT
    day, organization_id, project_id, api_key_id, model_slug, provider_id, max(team_id),
    sum(requests)::int, sum(errors)::int, sum(input_tokens), sum(output_tokens),
    sum(cache_read_tokens), sum(cost_usd), sum(latency_ms_sum), sum(ttft_ms_sum),
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
    latency_ms_sum = EXCLUDED.latency_ms_sum,
    ttft_ms_sum = EXCLUDED.ttft_ms_sum,
    ttft_count = EXCLUDED.ttft_count,
    latency_hist = EXCLUDED.latency_hist;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
