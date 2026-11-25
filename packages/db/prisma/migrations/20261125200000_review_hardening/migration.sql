-- Invitations remember whether their link was delivered by email: only then does accepting one
-- prove the invitee's address (the inviter always gets the link back as well).
ALTER TABLE "invitations" ADD COLUMN "email_sent_at" TIMESTAMPTZ(3);

-- Four-eyes approval: the person behind a change request made with a management token.
ALTER TABLE "change_requests" ADD COLUMN "requested_by_human_id" TEXT;

-- Catalog models that existed before catalog sync (20261125160000_catalog_sync) all got
-- price_override = false, including ones an organization had priced by hand. A row keeps
-- following the catalog only when its prices are exactly those of its synced catalog entry;
-- every other one (different prices, or an entry that exists only in the bundled catalog and
-- cannot be compared here) is marked as priced by hand, so no sync reprices it silently. An
-- administrator can switch a model back to the catalog price with "follow catalog".
WITH cutoff AS (
  SELECT COALESCE(
    (SELECT max("finished_at") FROM "_prisma_migrations"
      WHERE "migration_name" = '20261125160000_catalog_sync' AND "rolled_back_at" IS NULL),
    now()
  ) AS at
),
raw AS (
  SELECT
    c."key",
    c."pricing" ->> 'inputPerMTok' AS input,
    c."pricing" ->> 'outputPerMTok' AS output,
    c."pricing" ->> 'cacheReadPerMTok' AS cache_read,
    c."pricing" ->> 'cacheWritePerMTok' AS cache_write,
    c."pricing" ->> 'reasoningPerMTok' AS reasoning,
    c."pricing" ->> 'perImageUsd' AS image,
    c."pricing" ->> 'perMCharUsd' AS chars,
    c."pricing" ->> 'perSecondUsd' AS seconds,
    c."pricing" ->> 'batchDiscount' AS batch,
    CASE
      WHEN jsonb_typeof(c."pricing" -> 'tiers') = 'array' THEN c."pricing" -> 'tiers'
      ELSE '[]'::jsonb
    END AS tiers
  FROM "catalog_models" c
),
-- Only plain decimal strings are compared; anything else counts as "cannot compare".
catalog AS (
  SELECT
    r."key",
    r.tiers,
    CASE WHEN r.input ~ '^[0-9]+(\.[0-9]+)?$' THEN r.input::numeric END AS input,
    CASE WHEN r.output ~ '^[0-9]+(\.[0-9]+)?$' THEN r.output::numeric END AS output,
    CASE WHEN r.cache_read ~ '^[0-9]+(\.[0-9]+)?$' THEN r.cache_read::numeric END AS cache_read,
    CASE WHEN r.cache_write ~ '^[0-9]+(\.[0-9]+)?$' THEN r.cache_write::numeric END AS cache_write,
    CASE WHEN r.reasoning ~ '^[0-9]+(\.[0-9]+)?$' THEN r.reasoning::numeric END AS reasoning,
    CASE WHEN r.image ~ '^[0-9]+(\.[0-9]+)?$' THEN r.image::numeric END AS image,
    CASE WHEN r.chars ~ '^[0-9]+(\.[0-9]+)?$' THEN r.chars::numeric END AS chars,
    CASE WHEN r.seconds ~ '^[0-9]+(\.[0-9]+)?$' THEN r.seconds::numeric END AS seconds,
    CASE WHEN r.batch ~ '^[0-9]+(\.[0-9]+)?$' THEN r.batch::numeric END AS batch,
    (
      (r.input IS NOT NULL AND r.input !~ '^[0-9]+(\.[0-9]+)?$')
      OR (r.output IS NOT NULL AND r.output !~ '^[0-9]+(\.[0-9]+)?$')
      OR (r.cache_read IS NOT NULL AND r.cache_read !~ '^[0-9]+(\.[0-9]+)?$')
      OR (r.cache_write IS NOT NULL AND r.cache_write !~ '^[0-9]+(\.[0-9]+)?$')
      OR (r.reasoning IS NOT NULL AND r.reasoning !~ '^[0-9]+(\.[0-9]+)?$')
      OR (r.image IS NOT NULL AND r.image !~ '^[0-9]+(\.[0-9]+)?$')
      OR (r.chars IS NOT NULL AND r.chars !~ '^[0-9]+(\.[0-9]+)?$')
      OR (r.seconds IS NOT NULL AND r.seconds !~ '^[0-9]+(\.[0-9]+)?$')
      OR (r.batch IS NOT NULL AND r.batch !~ '^[0-9]+(\.[0-9]+)?$')
    ) AS unreadable
  FROM raw r
)
UPDATE "models" AS m
SET "price_override" = true
FROM cutoff
WHERE m."catalog_key" IS NOT NULL
  AND m."price_override" = false
  AND m."created_at" < cutoff.at
  AND NOT EXISTS (
    SELECT 1
    FROM catalog c
    WHERE c."key" = m."catalog_key"
      AND NOT c.unreadable
      AND c.input = m."input_price"
      AND c.output = m."output_price"
      AND c.cache_read IS NOT DISTINCT FROM m."cache_read_price"
      AND c.cache_write IS NOT DISTINCT FROM m."cache_write_price"
      AND c.reasoning IS NOT DISTINCT FROM m."reasoning_price"
      AND c.image IS NOT DISTINCT FROM m."image_price"
      AND c.chars IS NOT DISTINCT FROM m."char_price"
      AND c.seconds IS NOT DISTINCT FROM m."second_price"
      AND c.batch IS NOT DISTINCT FROM m."batch_discount"
      AND c.tiers = CASE
        WHEN jsonb_typeof(m."pricing_tiers") = 'array' THEN m."pricing_tiers"
        ELSE '[]'::jsonb
      END
  );
