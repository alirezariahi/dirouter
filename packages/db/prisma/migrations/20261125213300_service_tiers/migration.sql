-- Service tiers (card 31.5): flex and priority prices per model, and the tier each request was
-- priced at.
ALTER TABLE "models" ADD COLUMN "service_tier_prices" JSONB;
ALTER TABLE "request_log" ADD COLUMN "service_tier" TEXT;

-- Models that follow the catalog get the tier prices of their catalog entry right away.
UPDATE "models" AS m
SET "service_tier_prices" = c."pricing" -> 'serviceTiers'
FROM "catalog_models" AS c
WHERE m."catalog_key" = c."key"
  AND m."price_override" = false
  AND c."pricing" ? 'serviceTiers';
