-- Sprint 5, card 32.2: conditional routing rules, and what the routing policies did to each request.
CREATE TABLE "routing_rules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL,
    "team_id" TEXT,
    "project_id" TEXT,
    "condition" TEXT NOT NULL,
    "action" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "routing_rules_organization_id_priority_idx" ON "routing_rules"("organization_id", "priority");

ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "request_log" ADD COLUMN "policy" JSONB;
