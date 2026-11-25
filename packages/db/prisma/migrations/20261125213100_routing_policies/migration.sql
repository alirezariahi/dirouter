-- Routing policies per organization, project or key (card 32.1): provider preferences an
-- administrator sets and whether the client may override them.
CREATE TABLE "routing_policies" (
    "organization_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "routing_policies_pkey" PRIMARY KEY ("organization_id","scope","scope_id")
);
