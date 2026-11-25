# @dirouter/mock-provider

## 1.1.0

### Minor Changes

- 3d5c420: A2A 1.0 complete: `SendStreamingMessage` and `SubscribeToTask` over SSE (v0.3 `message/stream`, `tasks/resubscribe`), with the model's answer streamed as artifact updates and events shared between replicas through Valkey; `returnImmediately` and cancellation of running tasks; push notification config CRUD with webhooks guarded against SSRF and called with an ES256 signature over the exact body (public key at `/.well-known/jwks.json`), the configured `Authorization` and `X-A2A-Notification-Token`; Major.Minor `A2A-Version` negotiation from the header or query parameter. The Agent Card now advertises streaming and push notifications (card 28.2).
- 1c129b4: The model catalog and prices sync from external sources (LiteLLM's public price list by default, or an internal mirror) in a periodic worker job with validation, a diff and a truncation guard. New models appear in the catalog without a release; price changes become proposals that an operator approves in the dashboard (or apply automatically, configurable), and request costs keep the current price until then. Pricing gains context-length tiers, a batch discount and a deprecation date; organization models priced by hand are never repriced. Without internet the last good catalog stays in force (card 27.5).
- 51e84e1: New `moderation` guardrail: an OpenAI-compatible moderation model or a Llama Guard chat model judges requests and answers through the gateway, with per-category thresholds, a timeout and fail-open or fail-closed (card 23.2). `POST /v1/moderations` is served. Prompt-injection detection has English and Persian patterns measured on a labelled set of 100 samples and an optional classifier model (card 23.3).
- 3a57a03: MCP gateway: resources, resource templates and prompts of upstream servers pass through with the same namespacing as tools (`<server>__<name>`, URIs `<server>+<uri>`), under the key allowlist and the call log. Upstream servers protected by OAuth 2.1 work with the organization's shared credential: endpoints discovered through RFC 9728 and RFC 8414, client credentials or an authorization code connection from the control-api, tokens renewed before expiry and after a 401, rotated refresh tokens shared between replicas through Valkey. stdio servers stay outside the gateway (decision recorded in docs/mcp/gateway.md); the platform organization may register private addresses such as the stdio sidecar (card 28.1).
- 364d0cc: Vertex AI accepts a service-account JSON key as the credential and Azure OpenAI accepts Entra ID client credentials (`options.authMode: "entra"`). The gateway signs the JWT or runs the client-credentials grant, caches the access token per credential and refreshes it before expiry; token URLs can be overridden per provider. A failed token exchange cools down only that credential, never the whole provider. The mock provider serves both token endpoints and a Vertex route (card 27.4).
- cfbfa14: Prompt caching everywhere: `cache_control` breakpoints, with their TTL, are now kept on system
  blocks, tools, text, images, documents, `tool_use` and `tool_result` (before, only on text), and
  Bedrock gets them as Converse `cachePoint` blocks, including Anthropic's top-level automatic
  caching. Claude Code through a Bedrock provider now reads from the prompt cache. Bedrock usage is
  fixed to count cache reads and writes in the total input, as Converse reports them apart. The mock
  provider simulates prompt caching on its Bedrock route.
- 8657154: Structured output on Anthropic and Bedrock: `response_format` with `json_schema` or `json_object`
  is no longer dropped. Claude models with native structured outputs get `output_config.format`;
  older Claude models and Bedrock get a forced `dirouter_structured_output` tool, whose call is
  returned to the client as JSON text with `finish_reason: stop`, in streams too. Bedrock models that
  reject a forced tool get `output_config.format` through `additionalModelRequestFields`. The
  provider option `structuredOutput` (`native` or `tool`) overrides the choice. An Anthropic
  client's `output_config.format` now also reaches OpenAI and Gemini. The mock provider answers
  structured-output requests from the schema and serves the Bedrock Converse API.

### Patch Changes

- Updated dependencies [5e49aec]
- Updated dependencies [1c129b4]
- Updated dependencies [daaa0ee]
- Updated dependencies [5838d61]
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
  - @dirouter/shared@1.1.0

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
  - @dirouter/shared@1.0.0
