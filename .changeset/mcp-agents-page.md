---
'@dirouter/dashboard': minor
'@dirouter/control-api': minor
'@dirouter/gateway': minor
---

New "MCP & agents" dashboard page: register and edit MCP servers and A2A agents (URL, transport,
encrypted headers, identity forwarding), test the connection and discover tools, edit the tool
allow-list of each virtual key, and read the tool-call log with server, key and status filters
(masked arguments and latency). The connection test is the new
`POST /orgs/:orgId/mcp/servers/:id/test`, run by the gateway with the same MCP client as traffic.
