-- Sprint 3, card 20.3: external A2A agents share the MCP server registry (transport `a2a`).
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_transport_valid";
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_transport_valid"
  CHECK ("transport" IN ('streamable-http', 'sse', 'a2a'));
