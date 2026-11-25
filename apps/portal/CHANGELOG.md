# @dirouter/portal

## 1.1.0

### Minor Changes

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

### Patch Changes

- 6c60fc9: Safer dashboard forms and exports: the MCP tool allow-list refuses an empty selection in "only the selected tools" mode (an empty list means every tool); leaving the Playground aborts its running streams; CSV exports prefix text cells that a spreadsheet would run as a formula (amounts stay plain numbers) and the usage report uses the same exporter; dashboard and portal downloads click a link that is in the document and revoke its URL after the click.

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
