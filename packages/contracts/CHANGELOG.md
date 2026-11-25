# @dirouter/contracts

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
- 1c129b4: The model catalog and prices sync from external sources (LiteLLM's public price list by default, or an internal mirror) in a periodic worker job with validation, a diff and a truncation guard. New models appear in the catalog without a release; price changes become proposals that an operator approves in the dashboard (or apply automatically, configurable), and request costs keep the current price until then. Pricing gains context-length tiers, a batch discount and a deprecation date; organization models priced by hand are never repriced. Without internet the last good catalog stays in force (card 27.5).
- daaa0ee: Documents and audio in translation: PDFs and other files (inline, by URL, as text or as a
  provider file id) and audio input are now part of the canonical model and travel between OpenAI
  Chat, Responses, Anthropic, Gemini, Vertex and Bedrock instead of being dropped. A destination
  that cannot carry a part answers with a 400 that names it, and nothing is sent upstream. The
  gateway routes such requests only to targets whose provider type and model can take them (new
  model capabilities `documents` and `audioInput`, set in the catalog for OpenAI, Anthropic and
  Gemini models; `false` excludes a model), and the `auto` aliases take them into account.
- 51e84e1: New `moderation` guardrail: an OpenAI-compatible moderation model or a Llama Guard chat model judges requests and answers through the gateway, with per-category thresholds, a timeout and fail-open or fail-closed (card 23.2). `POST /v1/moderations` is served. Prompt-injection detection has English and Persian patterns measured on a labelled set of 100 samples and an optional classifier model (card 23.3).
- db53f8a: Guardrails: `secret` and `json_schema` policies are now enforced by the gateway on requests,
  answers and streams. Before this release the gateway skipped both types without a word, although
  they could be created and passed the live test; review existing `secret` and `json_schema`
  policies with `action: block` before upgrading. The live test now runs the gateway's own engine,
  `json_schema` schemas are validated when saved, and a policy of an unknown type is logged and
  counted in `dirouter_gateway_guardrail_unknown_total` instead of being ignored silently.
- 8cc1c17: Live view over SSE: the gateway publishes each finished request (metadata only) on its
  organization's Valkey channel, control-api streams it at `GET /orgs/:orgId/stats/live/stream`, and
  the Live page shows it as soon as the gateway finishes the request. When the stream drops or cannot
  be opened, the page polls every second and keeps reconnecting.
- 3a57a03: MCP gateway: resources, resource templates and prompts of upstream servers pass through with the same namespacing as tools (`<server>__<name>`, URIs `<server>+<uri>`), under the key allowlist and the call log. Upstream servers protected by OAuth 2.1 work with the organization's shared credential: endpoints discovered through RFC 9728 and RFC 8414, client credentials or an authorization code connection from the control-api, tokens renewed before expiry and after a 401, rotated refresh tokens shared between replicas through Valkey. stdio servers stay outside the gateway (decision recorded in docs/mcp/gateway.md); the platform organization may register private addresses such as the stdio sidecar (card 28.1).
- 76398b4: OpenTelemetry: gateway spans now follow the GenAI semantic conventions (v1.41.0): each upstream
  attempt is a CLIENT span named `{operation} {model}` with `gen_ai.operation.name`,
  `gen_ai.provider.name`, request and response model, finish reasons and token usage, so Langfuse,
  Phoenix or Datadog show it as an LLM call without a custom mapping. The original `gateway.*`
  names are kept by default (`tracing.attributes: both`); `gen_ai` drops them and `legacy` restores
  the previous span names. New `tracing.metrics` and `tracing.logs` settings export the metrics
  registry (with `gen_ai.client.token.usage` and `gen_ai.client.operation.duration`) and the log
  lines over OTLP/HTTP. The upstream span is no longer named `gateway.upstream` unless `legacy` is
  chosen; update trace queries that match that name.
- 5e39c70: Portal sign-up verifies the email address. A password sign-up gets a one-time link by email
  (24 hours, only its hash is stored); until it is opened the account cannot create API keys
  (`403 email_not_verified`) and gets no welcome credit. `POST /portal/verify-email` opens the link,
  `POST /portal/verify-email/resend` sends a new one (rate limited per user); used and expired links
  are refused with `verification_link_invalid`. An OIDC sign-in with `email_verified: true` needs no
  link. Without `SMTP_URL`, password sign-up is refused and `GET /portal/config` says
  `passwordSignup: false`. Migration `email_verification` adds `users.email_verified_at` (existing
  accounts count as verified) and the `email_verifications` table; `GET /auth/me` returns
  `emailVerified`.
- cfbfa14: Prompt caching everywhere: `cache_control` breakpoints, with their TTL, are now kept on system
  blocks, tools, text, images, documents, `tool_use` and `tool_result` (before, only on text), and
  Bedrock gets them as Converse `cachePoint` blocks, including Anthropic's top-level automatic
  caching. Claude Code through a Bedrock provider now reads from the prompt cache. Bedrock usage is
  fixed to count cache reads and writes in the total input, as Converse reports them apart. The mock
  provider simulates prompt caching on its Bedrock route.
- c253e17: Request bodies: the gateway can now keep a request's body and answer per organization, project or
  virtual key (`none`, `metadata` or `full`; off by default). Bodies are masked by the `redact`
  guardrail policies and by the credential patterns before they leave the gateway, cut at
  `settings.bodyCapture.maxBytes`, sent over their own `request-bodies` queue (never with usage
  events) and kept in the daily-partitioned `request_bodies` table for `REQUEST_BODY_RETENTION_DAYS`
  (default 7), independent of the request log. The Log Explorer shows the payload to members with
  the new `logs:bodies` permission (OWNER and ADMIN), and **Replay in playground** runs the stored
  conversation again with any model. The previously unused `settings.logBodies` now means `full` as
  the instance default. Migration `20261124213000_request_bodies`.

### Patch Changes

- 219ddc9: A blocking whole-answer guardrail (json_schema, moderation, injection classifier) now holds every stream event until the answer is complete, so text after a tool call or in a later block is judged too; an answer too long to judge is blocked, and a moderation or classifier policy with no verdict in traffic follows its fail mode.

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
