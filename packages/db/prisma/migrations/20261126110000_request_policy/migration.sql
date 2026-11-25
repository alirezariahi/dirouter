-- Request shaping per model and per alias (epic 31): `RequestPolicy` in @dirouter/contracts,
-- e.g. { "autoCache": true } for automatic prompt-cache breakpoints (card 31.3).
ALTER TABLE "models" ADD COLUMN "request_policy" JSONB;
ALTER TABLE "model_aliases" ADD COLUMN "request_policy" JSONB;
