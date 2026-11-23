-- Sprint 3, card 20.5: coding-agent profiles.
-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "main_model" TEXT NOT NULL,
    "fast_model" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_profiles_organization_id_name_key" ON "agent_profiles"("organization_id", "name");

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_tool_valid" CHECK ("tool" IN ('claude-code', 'codex', 'opencode', 'gemini-cli', 'aider', 'env'));
