---
'@dirouter/contracts': minor
'@dirouter/shared': minor
'@dirouter/db': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': patch
'@dirouter/mock-provider': minor
---

MCP gateway: resources, resource templates and prompts of upstream servers pass through with the same namespacing as tools (`<server>__<name>`, URIs `<server>+<uri>`), under the key allowlist and the call log. Upstream servers protected by OAuth 2.1 work with the organization's shared credential: endpoints discovered through RFC 9728 and RFC 8414, client credentials or an authorization code connection from the control-api, tokens renewed before expiry and after a 401, rotated refresh tokens shared between replicas through Valkey. stdio servers stay outside the gateway (decision recorded in docs/mcp/gateway.md); the platform organization may register private addresses such as the stdio sidecar (card 28.1).
