-- Sprint 3, card 20.1: MCP gateway servers, per-key tool allowlist and the tool-call log.
-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "mcp_tools" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "mcp_servers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "headers_enc" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "forward_identity" BOOLEAN NOT NULL DEFAULT false,
    "timeout_ms" INTEGER NOT NULL DEFAULT 60000,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_tool_calls" (
    "id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "error_message" TEXT,
    "latency_ms" INTEGER NOT NULL,
    "gateway_instance" TEXT NOT NULL,

    CONSTRAINT "mcp_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_servers_organization_id_idx" ON "mcp_servers"("organization_id");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_organization_id_occurred_at_idx" ON "mcp_tool_calls"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_api_key_id_occurred_at_idx" ON "mcp_tool_calls"("api_key_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Live servers have unique tool prefixes within an organization.
CREATE UNIQUE INDEX "mcp_servers_org_slug_live_key" ON "mcp_servers"("organization_id", "slug") WHERE "deleted_at" IS NULL;
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_transport_valid" CHECK ("transport" IN ('streamable-http', 'sse'));
