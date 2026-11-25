# @dirouter/shared

## 1.1.0

### Minor Changes

- 5e49aec: Alerts: `breaker_open` and `queue_length` rules work. The gateway writes breaker transitions to
  the Valkey hash `dirouter:breakers` and the worker counts the organization's open breakers;
  `queue_length` reads the size of the BullMQ usage queue and needs a threshold. Email channels send
  over SMTP with TLS (`SMTP_URL`, `SMTP_FROM`, now also read by the worker); a channel with a
  `webhookUrl` keeps using its HTTP relay. The control-api sends invitation emails and channel test
  messages through the same mailer, and the invitation response says whether the email went out
  (`emailSent`). The worker joins the `edge` network in Compose so it can reach SMTP servers and
  webhooks outside the host.
- 3a57a03: MCP gateway: resources, resource templates and prompts of upstream servers pass through with the same namespacing as tools (`<server>__<name>`, URIs `<server>+<uri>`), under the key allowlist and the call log. Upstream servers protected by OAuth 2.1 work with the organization's shared credential: endpoints discovered through RFC 9728 and RFC 8414, client credentials or an authorization code connection from the control-api, tokens renewed before expiry and after a 401, rotated refresh tokens shared between replicas through Valkey. stdio servers stay outside the gateway (decision recorded in docs/mcp/gateway.md); the platform organization may register private addresses such as the stdio sidecar (card 28.1).

### Patch Changes

- 5838d61: Harden the gateway's outbound calls:

  - Vertex and Azure Entra ID token exchanges run on their own timeout, so a disconnecting client or a lost hedge no longer fails the shared exchange or cools down a healthy credential; a token the upstream rejects with 401/403 is dropped from the cache.
  - MCP connection tests, live MCP upstream calls and A2A proxying go through the SSRF guard and no longer follow redirects.
  - MCP OAuth discovery uses protected resource metadata only when it names the server (RFC 9728), follows a `resource_metadata` hint only on the server's origin, and keeps the discovered authorization server pinned.
  - Request body capture uses BullMQ-safe job ids, so request ids with `:` or digits only are no longer dropped.
  - A streamed A2A task that fails internally ends its SSE stream with a failed status instead of leaving it open.

- Updated dependencies [5e49aec]
- Updated dependencies [1c129b4]
- Updated dependencies [daaa0ee]
- Updated dependencies [51e84e1]
- Updated dependencies [db53f8a]
- Updated dependencies [8cc1c17]
- Updated dependencies [3a57a03]
- Updated dependencies [76398b4]
- Updated dependencies [5e39c70]
- Updated dependencies [cfbfa14]
- Updated dependencies [c253e17]
- Updated dependencies [219ddc9]
  - @dirouter/contracts@1.1.0

## 1.0.0

### Major Changes

- DiRouter 1.0: the first stable release.

  - **Gateway:** OpenAI, Anthropic, Responses and Gemini APIs on one endpoint, with routing,
    fallback, hedging, circuit breakers, rate limits, budgets, caching, guardrails, auto routing,
    embeddings, images, speech and transcription, MCP and A2A.
  - **Billing:** prepaid wallets on a double-entry ledger, online top-ups, gift codes, sale prices
    and plans, invoices, and a self-service portal.
  - **Enterprise:** OIDC and SAML sign-in, SCIM provisioning, custom roles, audit log, four-eyes
    approval for sensitive changes, provider plugins.
  - **Operations:** signed images with SBOMs, a threat model, a Helm chart, HA compose, a
    documentation site and a reproducible benchmark.

  Upgrading from 0.x (the MVP) needs no manual data changes: see docs/upgrade-v1.md.

### Patch Changes

- Updated dependencies
  - @dirouter/contracts@1.0.0
