# @dirouter/worker

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
- f5f07ea: Invoices are now Persian PDFs that can be given to an Iranian customer: right to left with joined
  letters, Vazirmatn embedded as a subset, Jalali dates, amounts in USD and rials at the rate recorded
  when the invoice was issued (and the total in tomans), the seller's and buyer's legal details
  (`GET`/`PUT /orgs/{orgId}/billing-profile`) and VAT on its own row. Set the rate with
  `tax.vatPercent` in the billing settings (default `0`): charges include VAT, and issuing an invoice
  splits the month's charges into net + VAT and books the VAT in the ledger (new system accounts
  `vat` and `receivable`; postpaid sales are now booked when invoiced). Invoice numbers stay gap-free
  and the database now refuses a skipped number and any edit or deletion of an issued invoice. Run the
  `invoice_tax_fields` migration; invoices issued before it keep no VAT.
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
- Updated dependencies [76398b4]
- Updated dependencies [5e39c70]
- Updated dependencies [cfbfa14]
- Updated dependencies [c253e17]
- Updated dependencies [8b325f7]
- Updated dependencies [219ddc9]
  - @dirouter/contracts@1.1.0
  - @dirouter/shared@1.1.0
  - @dirouter/model-catalog@1.1.0
  - @dirouter/db@1.1.0

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
  - @dirouter/shared@1.0.0
