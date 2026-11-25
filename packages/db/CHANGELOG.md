# @dirouter/db

## 1.1.0

### Minor Changes

- 1c129b4: The model catalog and prices sync from external sources (LiteLLM's public price list by default, or an internal mirror) in a periodic worker job with validation, a diff and a truncation guard. New models appear in the catalog without a release; price changes become proposals that an operator approves in the dashboard (or apply automatically, configurable), and request costs keep the current price until then. Pricing gains context-length tiers, a batch discount and a deprecation date; organization models priced by hand are never repriced. Without internet the last good catalog stays in force (card 27.5).
- f5f07ea: Invoices are now Persian PDFs that can be given to an Iranian customer: right to left with joined
  letters, Vazirmatn embedded as a subset, Jalali dates, amounts in USD and rials at the rate recorded
  when the invoice was issued (and the total in tomans), the seller's and buyer's legal details
  (`GET`/`PUT /orgs/{orgId}/billing-profile`) and VAT on its own row. Set the rate with
  `tax.vatPercent` in the billing settings (default `0`): charges include VAT, and issuing an invoice
  splits the month's charges into net + VAT and books the VAT in the ledger (new system accounts
  `vat` and `receivable`; postpaid sales are now booked when invoiced). Invoice numbers stay gap-free
  and the database now refuses a skipped number and any edit or deletion of an issued invoice. Run the
  `invoice_tax_fields` migration; invoices issued before it keep no VAT.
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
- 3a57a03: MCP gateway: resources, resource templates and prompts of upstream servers pass through with the same namespacing as tools (`<server>__<name>`, URIs `<server>+<uri>`), under the key allowlist and the call log. Upstream servers protected by OAuth 2.1 work with the organization's shared credential: endpoints discovered through RFC 9728 and RFC 8414, client credentials or an authorization code connection from the control-api, tokens renewed before expiry and after a 401, rotated refresh tokens shared between replicas through Valkey. stdio servers stay outside the gateway (decision recorded in docs/mcp/gateway.md); the platform organization may register private addresses such as the stdio sidecar (card 28.1).
- 5e39c70: Portal sign-up verifies the email address. A password sign-up gets a one-time link by email
  (24 hours, only its hash is stored); until it is opened the account cannot create API keys
  (`403 email_not_verified`) and gets no welcome credit. `POST /portal/verify-email` opens the link,
  `POST /portal/verify-email/resend` sends a new one (rate limited per user); used and expired links
  are refused with `verification_link_invalid`. An OIDC sign-in with `email_verified: true` needs no
  link. Without `SMTP_URL`, password sign-up is refused and `GET /portal/config` says
  `passwordSignup: false`. Migration `email_verification` adds `users.email_verified_at` (existing
  accounts count as verified) and the `email_verifications` table; `GET /auth/me` returns
  `emailVerified`.
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
