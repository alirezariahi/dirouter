-- Sprint 5, card 32.8: cost tier, allowed and denied models of automatic routing per
-- organization and key, with an administrator's lock.
CREATE TABLE "auto_routing_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "cost_tier" TEXT,
    "allowed_models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "denied_models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "reasoning_effort" TEXT NOT NULL DEFAULT 'auto',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auto_routing_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auto_routing_policies_organization_id_scope_scope_id_key" ON "auto_routing_policies"("organization_id", "scope", "scope_id");

ALTER TABLE "auto_routing_policies" ADD CONSTRAINT "auto_routing_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
