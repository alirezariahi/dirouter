-- Native provider pass-through (card 30.7): providers a key may call through /passthrough/{provider}/*;
-- provider slugs or '*'. Empty (the default) keeps pass-through off for the key.
ALTER TABLE "api_keys" ADD COLUMN "passthrough_providers" TEXT[] DEFAULT ARRAY[]::TEXT[];
