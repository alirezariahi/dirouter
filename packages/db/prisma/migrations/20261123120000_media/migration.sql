-- Media endpoints (card 21.1): image and audio providers, per-unit prices and the units consumed.
ALTER TYPE "ProviderType" ADD VALUE 'elevenlabs';
ALTER TYPE "ProviderType" ADD VALUE 'deepgram';
ALTER TYPE "ProviderType" ADD VALUE 'fal';

ALTER TABLE "models"
  ADD COLUMN "image_price" DECIMAL(18,8),
  ADD COLUMN "char_price" DECIMAL(18,8),
  ADD COLUMN "second_price" DECIMAL(18,8);

ALTER TABLE "request_log" ADD COLUMN "media" JSONB;
