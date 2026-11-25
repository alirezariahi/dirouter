-- Sprint 5, card 32.3: canary and percentage traffic splits with versions.
CREATE TABLE "traffic_splits" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "match" TEXT NOT NULL,
    "stable" TEXT NOT NULL,
    "canary" TEXT NOT NULL,
    "canary_percent" DECIMAL(5,2) NOT NULL,
    "stickiness" TEXT NOT NULL DEFAULT 'key',
    "auto_rollback" JSONB,
    "state" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "traffic_splits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "traffic_split_versions" (
    "id" TEXT NOT NULL,
    "split_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_split_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "traffic_splits_organization_id_match_key" ON "traffic_splits"("organization_id", "match");
CREATE UNIQUE INDEX "traffic_split_versions_split_id_version_key" ON "traffic_split_versions"("split_id", "version");

ALTER TABLE "traffic_splits" ADD CONSTRAINT "traffic_splits_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "traffic_split_versions" ADD CONSTRAINT "traffic_split_versions_split_id_fkey" FOREIGN KEY ("split_id") REFERENCES "traffic_splits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The split comparison report reads the branch from request_log.policy.
CREATE INDEX "request_log_split_idx" ON "request_log" (("policy"->'split'->>'id'), "created_at") WHERE "policy" ? 'split';
