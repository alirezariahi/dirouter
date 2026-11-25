# MCP & agents page

Code: `apps/dashboard/src/pages/mcp.tsx` (form helpers in `src/lib/mcp.ts`, messages in
`src/i18n/mcp-page.ts`) · card 25.3 · route `/mcp`, in the "Routing" group of the sidebar.

The gateway serves the tools of every registered MCP server at `/mcp` (card 20.1) and registered
A2A agents at `/a2a/agents/<slug>` (card 20.3), both behind the virtual key. This page manages
both from the dashboard.

## Sections

| Section             | What it does                                                                                                                                                                                                        | API                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| MCP servers         | servers with transport `streamable-http` or `sse`: name, slug (tool prefix), URL, enabled, stored headers, identity forwarding; enable, disable, edit, delete                                                       | `GET/PATCH/DELETE mcp/servers[/:id]`               |
| A2A agents          | servers with transport `a2a` and their gateway address `/a2a/agents/<slug>`                                                                                                                                         | same                                               |
| Test connection     | per server or agent: latency and the discovered tools (`<slug>__<tool>`) or, for an agent, the skills of its card                                                                                                   | `POST mcp/servers/:id/test`                        |
| Register / edit     | name, slug, transport, URL, timeout, headers (`Name: value` per line), forward identity, enabled. Stored headers are never shown; on edit they are kept unless "replace" is ticked (an empty box then removes them) | `POST mcp/servers`, `PATCH mcp/servers/:id`        |
| Tool access per key | choose a key, then "All tools" (empty list) or "Only the selected tools": `<slug>__*` per server, discovered tools, and other patterns (`server__tool`, `server__*`, `*`)                                           | `PATCH keys/:id` with `mcpTools`                   |
| Tool-call log       | the last 100 calls, filtered by server, key and status (`success`, `error`, `denied`), with time, tool, latency, error and the masked arguments                                                                     | `GET mcp/calls?serverId=&apiKeyId=&status=&limit=` |

Writing (register, edit, test) needs `mcp:write`; without it the page is read-only. Saving the
allow-list needs `keys:write`.

## Connection test

`POST /orgs/:orgId/mcp/servers/:id/test` (permission `mcp:write`) sends the stored server, its
headers still encrypted, to the gateway (`POST /internal/mcp/probe`, internal token). The gateway
decrypts the headers in memory, opens a fresh connection with the same MCP client as real traffic
(Streamable HTTP or HTTP+SSE), and pages through `tools/list`. For an A2A agent it reads the agent
card (`/.well-known/agent-card.json` under the agent's path, then at the origin) and returns its
skills. The test works for disabled servers and before the snapshot with a new server has reached
the gateway.

```json
{ "ok": true, "latencyMs": 87, "tools": [{ "name": "search", "description": "Search the docs" }] }
```

An unreachable server is `ok: false` with an `error` text (HTTP 200); an unreachable gateway is
`503 service_unavailable`.

## Tests

- `apps/dashboard/src/pages/mcp.test.tsx`: registration body with headers and identity forwarding,
  header validation, test results for a server and an agent, allow-list saved from discovered
  tools, call log with masked arguments, latency and filters, read-only mode.
- `apps/gateway/src/mcp/probe.test.ts`: discovery over both transports with encrypted headers, an
  A2A card, an unreachable server, and the internal token.
- `apps/control-api/src/mcp/mcp.unit.test.ts`: what is sent to the gateway and error handling.
- `scripts/e2e/sprint-4.mjs` scenario `25.3` against the development stack.
