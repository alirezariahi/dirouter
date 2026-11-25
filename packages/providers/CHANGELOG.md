# @dirouter/providers

## 1.1.0

### Minor Changes

- daaa0ee: Documents and audio in translation: PDFs and other files (inline, by URL, as text or as a
  provider file id) and audio input are now part of the canonical model and travel between OpenAI
  Chat, Responses, Anthropic, Gemini, Vertex and Bedrock instead of being dropped. A destination
  that cannot carry a part answers with a 400 that names it, and nothing is sent upstream. The
  gateway routes such requests only to targets whose provider type and model can take them (new
  model capabilities `documents` and `audioInput`, set in the catalog for OpenAI, Anthropic and
  Gemini models; `false` excludes a model), and the `auto` aliases take them into account.
- 51e84e1: New `moderation` guardrail: an OpenAI-compatible moderation model or a Llama Guard chat model judges requests and answers through the gateway, with per-category thresholds, a timeout and fail-open or fail-closed (card 23.2). `POST /v1/moderations` is served. Prompt-injection detection has English and Persian patterns measured on a labelled set of 100 samples and an optional classifier model (card 23.3).
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
- Updated dependencies [8657154]
  - @dirouter/contracts@1.1.0
  - @dirouter/translator@1.1.0

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
  - @dirouter/translator@1.0.0
