-- Sprint 3, card 20.2: scope of a key on DiRouter's own MCP server.
-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "mcp_admin" TEXT NOT NULL DEFAULT 'none';


ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_mcp_admin_valid" CHECK ("mcp_admin" IN ('none', 'read', 'write'));
