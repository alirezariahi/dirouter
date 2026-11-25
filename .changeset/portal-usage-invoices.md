---
'@dirouter/portal': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
---

Portal: a **Usage** page with cost and tokens per day, by model and by key and the latest requests
with the cost of each, and an **Invoices** page with the month so far, every issued invoice (net,
VAT, total) and its PDF download, plus the legal details printed on future invoices. The figures
come from the new `GET /orgs/{orgId}/usage` (at most 93 days): for prepaid customers they are the
wallet's usage debits, so they equal the wallet statement; for postpaid customers the request
log's prices.
