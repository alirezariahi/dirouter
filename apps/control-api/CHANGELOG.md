# @dirouter/control-api

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
- 8136bf6: Dashboard billing, part two: set each platform model's sale multiplier, fixed price and cache
  share and publish it in the marketplace (a saved price applies to the next request), manage
  customer groups and assign customers to them, define and hide plans and see every subscription,
  list invoices by month with PDF download, ledger verification and the monthly run, and read the
  profit report for a range, a customer and a model with a CSV export whose figures are the
  endpoint's own. The API gains `GET billing/subscriptions`, optional `organizationId` and `model`
  filters on `GET billing/reports/profit` (with a `filters` echo; ledger figures stay platform-wide),
  and `customerGroupId` in `GET billing/wallets`.
- c006aee: Dashboard: a Billing section for the platform organization (members with `billing:read`; changes
  need `billing:write`). Operators can list customers with their balances, open a wallet and its
  statement, switch prepaid mode, record a manual credit or debit with a reason (kept in the audit
  log as `billing.wallet_adjusted`, with an idempotency key against double posting), list and
  reconcile payments, configure Zarinpal, Stripe, exchange rates, top-up limits and the portal, and
  create gift-code batches with a CSV of the codes, see redemptions and revoke several batches at
  once. `/auth/me` now returns `isPlatform` for each organization so the dashboard can show the
  section only where the API serves it.
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
- f5f07ea: Invoices are now Persian PDFs that can be given to an Iranian customer: right to left with joined
  letters, Vazirmatn embedded as a subset, Jalali dates, amounts in USD and rials at the rate recorded
  when the invoice was issued (and the total in tomans), the seller's and buyer's legal details
  (`GET`/`PUT /orgs/{orgId}/billing-profile`) and VAT on its own row. Set the rate with
  `tax.vatPercent` in the billing settings (default `0`): charges include VAT, and issuing an invoice
  splits the month's charges into net + VAT and books the VAT in the ledger (new system accounts
  `vat` and `receivable`; postpaid sales are now booked when invoiced). Invoice numbers stay gap-free
  and the database now refuses a skipped number and any edit or deletion of an issued invoice. Run the
  `invoice_tax_fields` migration; invoices issued before it keep no VAT.
- 8cc1c17: Live view over SSE: the gateway publishes each finished request (metadata only) on its
  organization's Valkey channel, control-api streams it at `GET /orgs/:orgId/stats/live/stream`, and
  the Live page shows it as soon as the gateway finishes the request. When the stream drops or cannot
  be opened, the page polls every second and keeps reconnecting.
- b8879c8: Sign-in sessions: `GET /auth/sessions` lists the signed-in user's active sessions with device,
  address and last activity; `DELETE /auth/sessions/{id}` ends one and
  `POST /auth/sessions/revoke-all` signs out everywhere else (or everywhere with
  `includeCurrent: true`). Administrators can list and end a member's sessions under
  `/orgs/{orgId}/members/{userId}/sessions`. Ending a session revokes its refresh token at once, and
  access tokens now carry their session id (`sid`), so they are refused as soon as their session is
  revoked, also after logout, a password change or a reused refresh token, instead of staying valid
  for up to 15 minutes. Every revocation is audited. The account page lists the sessions and the
  organization page has a "Sign out everywhere" button per member.
- d2b68cd: Management API tokens and service accounts: automation (CI, scripts, Terraform) can now call the
  management API without a user signing in. A service account is a non-human member of one
  organization with a role (`ADMIN`, `MEMBER` or `VIEWER`) and optional custom role; it can never
  sign in. Its tokens (`drm_…`, only the SHA-256 is stored, shown once) are scoped to permissions of
  the RBAC matrix, expire after 1 to 730 days or never, and can be limited to IP addresses or CIDR
  ranges. A request is allowed only when both the token's scopes and the account's current role grant
  the route's permission, so a read-only token cannot change anything; a revoked or expired token is
  refused on its next request. Managing service accounts and deciding change requests stay closed to
  tokens. Every use is audited as `management_token.used`. New tables `service_accounts` and
  `management_tokens` and the column `users.is_service_account` (migration
  `20261124230000_management_tokens`). The security page in the dashboard manages both.
- 48fcc59: New "MCP & agents" dashboard page: register and edit MCP servers and A2A agents (URL, transport,
  encrypted headers, identity forwarding), test the connection and discover tools, edit the tool
  allow-list of each virtual key, and read the tool-call log with server, key and status filters
  (masked arguments and latency). The connection test is the new
  `POST /orgs/:orgId/mcp/servers/:id/test`, run by the gateway with the same MCP client as traffic.
- 3a57a03: MCP gateway: resources, resource templates and prompts of upstream servers pass through with the same namespacing as tools (`<server>__<name>`, URIs `<server>+<uri>`), under the key allowlist and the call log. Upstream servers protected by OAuth 2.1 work with the organization's shared credential: endpoints discovered through RFC 9728 and RFC 8414, client credentials or an authorization code connection from the control-api, tokens renewed before expiry and after a 401, rotated refresh tokens shared between replicas through Valkey. stdio servers stay outside the gateway (decision recorded in docs/mcp/gateway.md); the platform organization may register private addresses such as the stdio sidecar (card 28.1).
- 0e5bac0: The playground streams: up to four models side by side, each with its time to first token, tool
  calls, the gateway's `x-dirouter-*` headers, latency, tokens and cost. Requests can carry tool
  definitions, an image, `max_tokens`, `top_p`, `reasoning_effort` and `response_format`. New
  `POST /orgs/:orgId/playground/stream` answers `text/event-stream` (`meta`, `ttft`, `chunk`,
  `error`, `end`).
- 5e39c70: Portal sign-up verifies the email address. A password sign-up gets a one-time link by email
  (24 hours, only its hash is stored); until it is opened the account cannot create API keys
  (`403 email_not_verified`) and gets no welcome credit. `POST /portal/verify-email` opens the link,
  `POST /portal/verify-email/resend` sends a new one (rate limited per user); used and expired links
  are refused with `verification_link_invalid`. An OIDC sign-in with `email_verified: true` needs no
  link. Without `SMTP_URL`, password sign-up is refused and `GET /portal/config` says
  `passwordSignup: false`. Migration `email_verification` adds `users.email_verified_at` (existing
  accounts count as verified) and the `email_verifications` table; `GET /auth/me` returns
  `emailVerified`.
- 95b7042: Portal: a **Usage** page with cost and tokens per day, by model and by key and the latest requests
  with the cost of each, and an **Invoices** page with the month so far, every issued invoice (net,
  VAT, total) and its PDF download, plus the legal details printed on future invoices. The figures
  come from the new `GET /orgs/{orgId}/usage` (at most 93 days): for prepaid customers they are the
  wallet's usage debits, so they equal the wallet statement; for postpaid customers the request
  log's prices.
- c253e17: Request bodies: the gateway can now keep a request's body and answer per organization, project or
  virtual key (`none`, `metadata` or `full`; off by default). Bodies are masked by the `redact`
  guardrail policies and by the credential patterns before they leave the gateway, cut at
  `settings.bodyCapture.maxBytes`, sent over their own `request-bodies` queue (never with usage
  events) and kept in the daily-partitioned `request_bodies` table for `REQUEST_BODY_RETENTION_DAYS`
  (default 7), independent of the request log. The Log Explorer shows the payload to members with
  the new `logs:bodies` permission (OWNER and ADMIN), and **Replay in playground** runs the stored
  conversation again with any model. The previously unused `settings.logBodies` now means `full` as
  the instance default. Migration `20261124213000_request_bodies`.
- eaf37fe: Team and project limits can now be set: `GET/PUT/DELETE /orgs/:orgId/limits/:scope/:scopeId`
  writes RPM, TPM, concurrency and daily or monthly budgets with alert thresholds for a team or
  project, and `GET /orgs/:orgId/limits/usage` reports what each team and project spent today and
  this month. Budget changes go through change requests when four-eyes approval is on. The
  Organization page edits the limits and the Cost page shows the current usage.

### Patch Changes

- 8b325f7: Security review fixes. Alert channel tests are limited to one per channel per minute and ten per
  organization per hour (429 with `Retry-After`), an email test needs a verified sender, and its
  subject is fixed. A change request made with a management token records the person behind the
  token, who cannot approve it, and neither can the creator of the requesting service account.
  Creating service accounts needs a verified email address, keys created with a management token
  check the token's creator, and users who accept an invitation that was not delivered by email start
  unverified. Open live streams re-check the session, membership or token every 30 seconds and are
  capped at five per user. `TRUST_PROXY` (default one hop, the bundled Traefik) replaces trusting
  every proxy for the client address. Organization administrators no longer see a member's session
  addresses or devices, and the member session routes are closed to management tokens. Catalog price
  proposals are claimed atomically before they are applied; a migration marks catalog models that were
  priced by hand before catalog sync as overridden; `queue_length` alert rules are kept to the
  platform organization.
- Updated dependencies [5e49aec]
- Updated dependencies [1c129b4]
- Updated dependencies [daaa0ee]
- Updated dependencies [5838d61]
- Updated dependencies [51e84e1]
- Updated dependencies [db53f8a]
- Updated dependencies [f5f07ea]
- Updated dependencies [8cc1c17]
- Updated dependencies [d2b68cd]
- Updated dependencies [3a57a03]
- Updated dependencies [364d0cc]
- Updated dependencies [76398b4]
- Updated dependencies [5e39c70]
- Updated dependencies [cfbfa14]
- Updated dependencies [c253e17]
- Updated dependencies [8b325f7]
- Updated dependencies [219ddc9]
- Updated dependencies [8657154]
  - @dirouter/contracts@1.1.0
  - @dirouter/shared@1.1.0
  - @dirouter/model-catalog@1.1.0
  - @dirouter/db@1.1.0
  - @dirouter/providers@1.1.0

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
  - @dirouter/db@1.0.0
  - @dirouter/model-catalog@1.0.0
  - @dirouter/providers@1.0.0
  - @dirouter/shared@1.0.0
