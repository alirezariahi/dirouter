---
'@dirouter/dashboard': minor
'@dirouter/control-api': minor
---

Dashboard: a Billing section for the platform organization (members with `billing:read`; changes
need `billing:write`). Operators can list customers with their balances, open a wallet and its
statement, switch prepaid mode, record a manual credit or debit with a reason (kept in the audit
log as `billing.wallet_adjusted`, with an idempotency key against double posting), list and
reconcile payments, configure Zarinpal, Stripe, exchange rates, top-up limits and the portal, and
create gift-code batches with a CSV of the codes, see redemptions and revoke several batches at
once. `/auth/me` now returns `isPlatform` for each organization so the dashboard can show the
section only where the API serves it.
