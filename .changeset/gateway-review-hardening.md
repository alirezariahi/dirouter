---
'@dirouter/gateway': patch
'@dirouter/providers': patch
'@dirouter/shared': patch
---

Harden the gateway's outbound calls:

- Vertex and Azure Entra ID token exchanges run on their own timeout, so a disconnecting client or a lost hedge no longer fails the shared exchange or cools down a healthy credential; a token the upstream rejects with 401/403 is dropped from the cache.
- MCP connection tests, live MCP upstream calls and A2A proxying go through the SSRF guard and no longer follow redirects.
- MCP OAuth discovery uses protected resource metadata only when it names the server (RFC 9728), follows a `resource_metadata` hint only on the server's origin, and keeps the discovered authorization server pinned.
- Request body capture uses BullMQ-safe job ids, so request ids with `:` or digits only are no longer dropped.
- A streamed A2A task that fails internally ends its SSE stream with a failed status instead of leaving it open.
