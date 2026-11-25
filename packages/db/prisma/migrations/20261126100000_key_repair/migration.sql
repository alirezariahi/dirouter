-- Gateway repairs per key (card 31.1): `json` fixes broken JSON answers to a response_format
-- request, `tools` fixes unpaired or duplicated tool calls in the history. Empty = none.
ALTER TABLE "api_keys" ADD COLUMN "repair" TEXT[] DEFAULT ARRAY[]::TEXT[];
