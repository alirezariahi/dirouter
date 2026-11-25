-- Shared OAuth 2.1 credential of an upstream MCP server (card 28.1), encrypted with MASTER_KEY.
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_enc" TEXT;
