# Upgrading to v1.1

From 1.0.x to 1.1.0. Coming from 0.x or the MVP, follow [upgrade-v1.md](upgrade-v1.md) first. What
1.1.0 adds is summarized in the root [CHANGELOG.md](../CHANGELOG.md); this page lists only what an
operator has to do or should know before the new images run.

## Before you start

1. **Back up PostgreSQL** and keep a copy of your `.env`, above all `MASTER_KEY` and `KEY_PEPPER`,
   as for every upgrade ([upgrade-v1.md](upgrade-v1.md)).
2. Verify the new images' signatures ([SECURITY.md](../SECURITY.md)). Images are now multi-arch
   manifest lists (linux/amd64 and linux/arm64); `docker pull` picks your host's architecture, and
   every architecture has its own signature and SBOM ([ci.md](ci.md)).
3. **Review guardrail policies with `action: block`** of type `secret` and `json_schema` (see
   below). They start blocking as soon as the new gateway runs.
4. Decide about **SMTP** and **catalog sync** (see below) if your installation has no outbound
   internet or no mail server.

## Upgrade

With Docker Compose:

```bash
TAG=1.1.0 docker compose pull
```

```bash
TAG=1.1.0 docker compose up -d
```

The `migrate` service applies the new migrations before control-api starts; with Helm, control-api's
init container does it ([helm.md](helm.md)). Nothing has to be run by hand. The 1.1.0 migrations:

| Migration                           | What it does                                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261124120000_invoice_tax_fields` | VAT fields on invoices, the `vat` and `receivable` system accounts, legal details, and triggers that refuse a skipped invoice number or any change to an issued invoice; invoices issued before it keep no VAT |
| `20261124160000_email_verification` | `users.email_verified_at` (existing users count as verified) and the `email_verifications` table                                                                                                               |
| `20261124213000_request_bodies`     | The daily-partitioned `request_bodies` table (body capture is off by default)                                                                                                                                  |
| `20261124230000_management_tokens`  | `service_accounts`, `management_tokens` and `users.is_service_account`                                                                                                                                         |
| `20261125100000_mcp_oauth`          | The encrypted OAuth credential of MCP servers                                                                                                                                                                  |
| `20261125160000_catalog_sync`       | Catalog sync tables, pricing tiers, batch discount, deprecation date and `models.price_override`                                                                                                               |
| `20261125200000_review_hardening`   | Invitation delivery time, the human behind a token's change request, and `price_override` for hand-priced models                                                                                               |

Migrations are forward-only, as before.

## Behaviour changes to review

### Guardrails

- **`secret` and `json_schema` policies are now enforced.** In 1.0.0 the gateway skipped both types
  without a word, although they could be created and passed the live test. From 1.1.0 they act on
  requests, answers and streams with their configured action. Check each such policy with
  `action: block` (for example with the live test, which now runs the gateway's own engine) before
  the new gateway takes traffic. `json_schema` schemas are validated when saved, so an invalid one
  can no longer be stored.
- **`prompt_injection` uses a new pattern set** (English and Persian, card 23.3), so an existing
  policy may match prompts the six English patterns of 1.0.0 did not.
- A blocking policy that judges the whole answer (`json_schema`, the new `moderation` type, an
  injection classifier) holds **every stream event** until the answer is complete. Streams under
  such a policy reach the client only at the end ([guardrails](concepts/guardrails.md)).
- A policy of a type the gateway does not know is logged and counted in
  `dirouter_gateway_guardrail_unknown_total`, never ignored silently.

### Sign-up, email and sessions

- **SMTP is required for portal password sign-up.** Without `SMTP_URL`, password sign-up is refused
  and `GET /portal/config` returns `passwordSignup: false`; OIDC sign-up still works. With SMTP, a
  new password account must open the emailed link before it can create API keys
  (`403 email_not_verified`) or receive the welcome credit
  ([auth](control-api/auth.md)).
- **Users created before 1.1.0 count as verified** (the migration fills `email_verified_at`).
- **Invitations:** when SMTP is configured, a user who accepts an invitation whose email was not
  delivered starts unverified. Without SMTP, the invitee counts as verified when the inviter is.
- Creating service accounts needs a verified address.
- **`TRUST_PROXY`** (control-api, default `1`: one hop, the bundled Traefik) replaces trusting every
  proxy for the client address. If control-api sits behind more proxies, for example a load
  balancer in front of Traefik, set the hop count or the proxy addresses, or the audit log, the
  sessions list and the per-IP sign-in limit see the proxy's address ([env-reference](env-reference.md)).
- **Organization administrators no longer see a member's session addresses or devices**; they can
  still list and end a member's sessions. The member session routes are closed to management
  tokens.
- Revoking a session (logout, password change, "sign out everywhere") now stops its access tokens at
  once. Open live streams re-check their session every 30 seconds and are capped at five per user.

### Catalog and prices

- **Catalog sync is on by default** and fetches LiteLLM's public price list
  (`model_prices_and_context_window.json` on GitHub raw) every 6 hours. The default mode is
  `manual`: a price change becomes a proposal that waits for an operator's approval, and request
  costs keep the current price until then. New models appear in the catalog without a release.
  Without internet the run fails and the last good catalog stays in force.
- **Air-gapped installations:** switch it off or point it at an internal mirror
  ([catalog-sync](catalog-sync.md)). The switch and the source list are in the dashboard's catalog
  sync settings for the platform organization (`PUT /orgs/{org}/catalog-sync/settings`). The
  environment defaults `CATALOG_SYNC_ENABLED` and `CATALOG_SYNC_SOURCES` (and the other
  `CATALOG_SYNC_*` settings) are read by the worker: with Compose set them in `.env`, with Helm in
  `worker.extraEnv`. Settings stored from the dashboard take precedence.
- **Hand-priced models are protected:** the `review_hardening` migration marks every catalog model
  whose prices differ from its catalog entry as `price_override`, so no sync reprices it. "Follow
  catalog" (`followCatalog: true`) switches a model back to the catalog price.
- The **batch discount** is stored and shown, but not applied: the gateway has no batch API.

### Billing

- **VAT** is `0` by default (`tax.vatPercent` in the billing settings), so invoices and charges do
  not change until you set it. Invoices issued before the upgrade keep no VAT.
- **Postpaid sales are booked to the ledger when invoiced**: issuing a postpaid invoice credits
  `revenue` (net) and `vat` against `receivable`. In the profit report, `ledger.revenueBookedUsd`
  therefore includes postpaid sales from the day their invoice is issued, and the new
  `vatCollectedUsd` and `receivableUsd` fields appear. The per-model cost and revenue figures still
  come from usage and do not change.

### Observability

- **The upstream span is renamed** from `gateway.upstream` to `{operation} {model}` (for example
  `chat gpt-4o`) and is now a CLIENT span with the GenAI semantic-convention attributes. The legacy
  `gateway.*` attributes are kept by default (`tracing.attributes: both`); set `legacy` to restore
  the old span names. Update trace queries and dashboards that match `gateway.upstream`
  ([observability](observability.md)).
- Request body capture is off by default. The previously unused `settings.logBodies: true` now means
  `full` capture as the instance default; remove it if you set it and do not want bodies stored
  ([request bodies](concepts/request-bodies.md)).

### Alerts

- **`queue_length` alert rules are platform-only.** The usage queue is shared by the whole
  deployment, so other organizations can no longer create such a rule (`403`), and the worker skips
  any that already exist outside the platform organization.
- Email channels without a `webhookUrl` now send over SMTP (`SMTP_URL`, `SMTP_FROM`, now read by the
  worker as well). Channel tests are rate-limited (one per channel per minute, ten per organization
  per hour).

### Images

- **control-api keeps js-tiktoken** in its image (the guardrail live test counts tokens like the
  gateway). Nothing to do; a custom image that pruned it must keep it.

## New, optional settings

All new environment variables have defaults; see [env-reference.md](env-reference.md). Worth
reviewing: `SMTP_URL` and `SMTP_FROM`, `TRUST_PROXY`, `CATALOG_SYNC_*`, `REQUEST_BODY_RETENTION_DAYS`.

## Rolling back

Restore the database backup and start the 1.0.x images. Migrations are forward-only.
