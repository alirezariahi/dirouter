[English](gateway.md) · [فارسی](gateway.fa.md)

# MCP gateway

Cards 20.1 and 28.1 · code: `apps/gateway/src/mcp`, `apps/control-api/src/mcp`, `apps/worker/src/mcp-calls.ts`, `packages/shared/src/oauth-client.ts`, `scripts/mcp/stdio-bridge.mjs`

## What it does

On `/mcp` the gateway is an MCP server with the **Streamable HTTP** transport. It puts every MCP server the organization registered behind the same virtual key, permissions and logging as the models:

```bash
claude mcp add --transport http dirouter https://api.example.com/mcp \
  --header "Authorization: Bearer dr-xxxxxxxx-…"
```

- **Tools** carry the server prefix: `<slug>__<tool>` (for example `github__create_issue`). `tools/list` follows upstream pagination and each server's list is cached for 60 seconds. A broken server only loses its own items.
- **Resources and prompts** (card 28.1) pass through with the same namespacing:

  | method                     | what the client sees                                                                                    |
  | -------------------------- | ------------------------------------------------------------------------------------------------------- |
  | `resources/list`           | `name` becomes `<slug>__<name>`, `uri` becomes `<slug>+<uri>` (for example `github+repo://readme`)      |
  | `resources/templates/list` | `uriTemplate` becomes `<slug>+<template>`; a URI the client expands from it still starts with `<slug>+` |
  | `resources/read`           | `<slug>+<uri>` is routed to the server as `<uri>`; the URIs in `contents` come back prefixed            |
  | `prompts/list`             | `name` becomes `<slug>__<name>`                                                                         |
  | `prompts/get`              | routed by prefix; embedded resources in the messages come back with prefixed URIs                       |

  `+` is legal in a URI scheme and never appears in a slug, so the split is unambiguous. Resource links and embedded resources in `tools/call` results are rewritten the same way, so the client can read them through the gateway. `resources/subscribe` is not offered (the endpoint has no sessions). A server that does not implement resources or prompts (`-32601`) simply contributes none.

- **Key allowlist** (`mcpTools`): `server__tool`, `server__*` or `*`; empty means everything. Tools and prompts are matched by name: an item outside the allowlist is neither listed nor callable and is answered exactly like a missing one (`-32602 Unknown tool` / `Unknown prompt`). Resources and templates have no stable name to match, so they need the whole server (`server__*`, `*` or an empty list); otherwise `resources/read` answers `-32002 Resource not found`.
- **Log of every call:** organization, project, key, server, tool, masked arguments, outcome (`success`, `error`, `denied`) and latency. `resources/read` is logged as tool `resource:<uri>` and `prompts/get` as `prompt:<name>`. Masking happens in the gateway: keys such as password, token, secret, api_key, authorization and cookie become `***`, and long strings (over 200 characters), arrays and deep values are cut. Records go to the `mcp-calls` queue and the worker writes them to `mcp_tool_calls` (idempotent). Retention is `MCP_CALL_RETENTION_DAYS` days (default 90).
- **Identity forwarding:** with `forwardIdentity`, the headers `X-DiRouter-Organization-Id`, `X-DiRouter-Project-Id`, `X-DiRouter-Key-Id` and, when present, `X-DiRouter-User` (from the client request) go to the MCP server. They are not signed, so the MCP server should trust them only if nothing but the gateway can reach it.
- The endpoint is stateless: no session is issued, and `GET` and `DELETE` get 405.

## Upstream servers

| transport          | behaviour                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `streamable-http`  | One POST per message; JSON or SSE answer. `Mcp-Session-Id` is kept, and a 404 starts one new initialization |
| `sse` (2024-11-05) | A long-lived GET announces the endpoint; requests are POSTed there and answers arrive on the stream         |
| stdio              | Not run by the gateway; see [the stdio decision](#decision-stdio-servers)                                   |

Each gateway replica keeps one connection per server. Changing the address, transport, headers or OAuth credential rebuilds it.

## OAuth 2.1 upstream authentication (card 28.1)

Besides fixed headers, a server can carry the organization's **shared OAuth credential** (`oauth` on the server). The gateway acts as an OAuth client following the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization):

1. **Discovery.** Protected resource metadata (RFC 9728): from the `resource_metadata` parameter of the server's `WWW-Authenticate` challenge, else `/.well-known/oauth-protected-resource/<path>`, else the root well-known URI. Then authorization server metadata (RFC 8414) at `/.well-known/oauth-authorization-server/<path>`, with the OpenID Connect fallbacks. The issuer in the metadata must match. `issuer` in the credential skips the first step, `tokenEndpoint` skips both.
2. **Tokens.** Always with the RFC 8707 `resource` indicator (the server URL, or the `resource` its metadata names). Client authentication is `client_secret_basic` unless the server only supports `client_secret_post` (or `tokenEndpointAuthMethod` says otherwise).
   - `client_credentials`: the client secret alone gets a token. If the server also hands out a refresh token, it is used first next time.
   - `authorization_code`: an administrator connects the server once (below); the gateway then lives on the refresh token.
3. **Automatic renewal.** A token is renewed shortly before it expires (a quarter of its lifetime, at most 60 seconds early), and at once when the server answers 401 (revoked or expired early): the request is retried once with a new token. A rotated refresh token replaces the old one.
4. **Several replicas.** With Valkey, replicas share the current access token and the newest refresh token (`mcp:oauth:at:*`, `mcp:oauth:rt:*`, encrypted with MASTER_KEY) and renew under a short lock (`mcp:oauth:lock:*`), so an authorization server that rotates refresh tokens never sees the same one twice. Without Valkey, every replica keeps its own tokens.
5. **SSRF.** In production (`NODE_ENV=production`), the discovered endpoints of customer organizations must resolve to public addresses (the same guard as providers, checked when connecting); redirects are not followed. The control-api checks the endpoints it calls against the alert-webhook policy.

The credential is stored encrypted (AAD `mcp-oauth:<id>`, column `mcp_servers.oauth_enc`) and is write-only: the API returns only `grantType`, `clientId`, `scope`, the endpoints, `hasClientSecret` and `connected`. Tokens never reach the database except the refresh token from the connection step.

### Connecting an authorization-code server

```bash
# 1. Store the credential (from the client registered at the authorization server).
curl -X PATCH …/orgs/$ORG/mcp/servers/$ID -d '{"oauth":{"grantType":"authorization_code","clientId":"…","clientSecret":"…","scope":"offline_access mcp"}}'
# 2. Get the authorization URL (PKCE S256, state sealed with MASTER_KEY, valid for 10 minutes).
curl -X POST …/orgs/$ORG/mcp/servers/$ID/oauth/authorize -d '{"redirectUri":"https://dash.example.com/mcp/callback"}'
# 3. Open authorizationUrl, approve, and send the code and state from the redirect back.
curl -X POST …/orgs/$ORG/mcp/servers/$ID/oauth/callback -d '{"code":"…","state":"…"}'
```

The callback refuses a state minted for another server, organization or older than 10 minutes, and an authorization server that issues no refresh token. Replacing the credential with the same client and authorization server (for example a new client secret) keeps the connection; `oauth: null` removes it.

Per-user OAuth (each end user's own token in a token vault) is not part of this card.

The authorization-code connection is **API-only** in v1.1: the dashboard's MCP page has no OAuth form or connect button, so store the credential and run the three calls above with a management token or an administrator's session.

## Decision: stdio servers

**Decision (card 28.1): the gateway never spawns stdio MCP servers, for any organization, the platform organization included.**

- Running a stdio server means running a process with the gateway's privileges, network and filesystem. In a multi-tenant gateway one tenant's server could read another tenant's traffic, the master key in memory or the provider keys. Isolating it properly (a sandbox per process, resource limits, image allowlists) is a separate product, not part of a routing gateway.
- Limiting it to the platform organization was considered. It would still put foreign code inside the data plane, which must stay small and restartable at any time, and it brings no ability the sidecar does not already give.
- **The supported way** is the stdio bridge as a separate sidecar that the operator controls: `node scripts/mcp/stdio-bridge.mjs --port 8765 -- npx -y <mcp-server>`, registered as `http://<sidecar>:8765/mcp` with the `streamable-http` transport. The bridge initializes the child once and rewrites ids so several gateways can share it. The sidecar runs in its own container, with its own limits and secrets, and is reachable only from the gateway network. In production a private address like this is allowed only for the platform organization (the control-api refuses it for everyone else), which keeps the sidecar an operator decision.

## Administration (control-api)

Permissions: `mcp:read` and `mcp:write`.

| method           | path                                                    | description                                                                              |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET/POST         | `/orgs/:orgId/mcp/servers`                              | `{name, slug, transport, url, headers?, oauth?, enabled?, forwardIdentity?, timeoutMs?}` |
| GET/PATCH/DELETE | `/orgs/:orgId/mcp/servers/:id`                          | `headers: null` and `oauth: null` remove them; leaving them out keeps them               |
| POST             | `/orgs/:orgId/mcp/servers/:id/oauth/authorize`          | `{redirectUri}` → `{authorizationUrl, state}`                                            |
| POST             | `/orgs/:orgId/mcp/servers/:id/oauth/callback`           | `{code, state}` → the server, `oauth.connected: true`                                    |
| GET              | `/orgs/:orgId/mcp/calls?limit&serverId&apiKeyId&status` | call log                                                                                 |

- Header values (for example `Authorization`) are encrypted with MASTER_KEY (AAD `mcp:<id>`) and never returned (only `hasHeaders`); the audit log records only "replaced/removed". The OAuth credential works the same way. In the snapshot both stay encrypted and the gateway decrypts them in memory.
- The URL is checked with the alert-webhook policy: in production only https and public addresses, except for the platform organization, which may register private addresses such as the stdio sidecar (card 28.1).
- `slug` is unique per organization, and the tool patterns of a key (`mcpTools`) are validated.

## Tests

- `apps/gateway/src/mcp/gateway.test.ts` against the fake MCP servers of mock-provider (`/mcp/:name`, `/mcp/:name-sse`, `/mcp-legacy/:name`): initialize, aggregation with pagination, allowlist, the three transports, identity forwarding only where configured, session renewal, masking and log, a broken server; resources (paged), templates, `resources/read` of a listed and an expanded URI, prompts with embedded resources, resource links in tool results, and the allowlist for resources and prompts.
- `apps/gateway/src/mcp/oauth.test.ts` against the mock's OAuth server (`/mcp-oauth/:name`, `/oauth`): discovery from the server URL, client credentials, renewal before expiry and after a revoked token (401), the refresh token of a client-credentials server, an authorization-code connection over three rotations, an unconnected server, sharing tokens between two gateways through Valkey (with `INTEGRATION_VALKEY_URL`), and the SSRF guard.
- `packages/shared/src/oauth-client.test.ts`: well-known URLs, the challenge parameter, the discovery order, the issuer check, client authentication.
- `apps/control-api/src/mcp/mcp.integration.test.ts`: encrypted headers and OAuth credential, the authorization-code connection (authorize, approve at the mock, callback, bad state), keeping the connection when the secret changes, snapshot, allowlist, log.
- `scripts/mcp/stdio-bridge.test.mjs`: the bridge over a small stdio server.
- e2e on compose: `node scripts/e2e/sprint-3.mjs 20.1` (real Claude Code) and `node scripts/e2e/sprint-4.mjs 28.1` (resources and prompts through the gateway, an OAuth-protected server registered through the control-api, and its token renewed after the mock revokes it).
