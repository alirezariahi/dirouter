-- Sprint 3, card 20.4: the auto-routing decision of each request.
ALTER TABLE "request_log" ADD COLUMN "routing" JSONB;
