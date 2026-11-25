-- Routing by data policy and region (card 32.5): what each provider does with request data, and
-- the planning decision (data policy, removed targets) kept with every request log entry.
ALTER TABLE "providers" ADD COLUMN "data_policy" JSONB;
ALTER TABLE "request_log" ADD COLUMN "route_decision" JSONB;
