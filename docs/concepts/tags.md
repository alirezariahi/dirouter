# Tags and cost centers (card 33.4)

Tags and cost centers attribute spend to a department, a product, a feature or a customer: every
request carries them into the request log, the ledger and the usage rollups, so the Analytics page
can group and filter by them and export the result, and budgets and rate limits can apply to them.

## Setting them

| source                      | tags                                              | cost center                        |
| --------------------------- | ------------------------------------------------- | ---------------------------------- |
| the key (`POST/PATCH keys`) | `tags: ["team:search", "prod"]`, on every request | `costCenter: "cc-42"`, the default |
| the request                 | `x-dirouter-tags: feature:summary,beta`           | `x-dirouter-cost-center: cc-17`    |

- A request's tags are the key's tags followed by the header's (comma separated; the header may be
  repeated), without duplicates and **at most 10**; the rest are dropped.
- The header's cost center replaces the key's.
- A tag or cost center is 1 to 64 letters, digits or `._:/-`, starting with a letter or digit
  (`team:search`, `customer/acme`). Invalid names in a request are ignored; the keys API refuses
  them with 422.

Names belong to the organization: `prod` of one organization and `prod` of another never share a
budget, a counter or a report row.

## Budgets and rate limits

The limits API takes `scope = tag` and `scope = cost_center` with the name as scope id (URL-encode
it in the path; `:` becomes `%3A`):

```json
PUT /api/v1/orgs/org_1/limits/tag/feature%3Asummary
{ "rpm": 600, "budgets": [{ "period": "monthly", "limitUsd": "300" }] }

PUT /api/v1/orgs/org_1/limits/cost_center/cc-42
{ "budgets": [{ "period": "yearly", "limitUsd": "20000" }] }
```

A tag's budget counts every request carrying the tag (a request with two tags counts for both), and
once it is used up those requests get `429 budget_exceeded`, e.g.
`Monthly tag budget exceeded (USD 300)`; requests without that tag go on. Cost centers work the same
way (`Yearly cost center budget exceeded …`). Both are request scopes of
`apps/gateway/src/spend-guard.ts`: no extra Valkey round trip, the usual fail-open or fail-closed
behaviour, four periods and alert thresholds. The worker reconciles them from `usage_ledger.tags`
and `usage_ledger.cost_center`, and `GET limits/usage` reports their spend per period.

The **Organization** page lists tags and cost centers that have limits; **Limit a tag or cost
center** opens the editor for any name.

## Reports

Usage is rolled up per tag and per cost center into `usage_dimension_hourly` and
`usage_dimension_daily`, next to end users (card 33.2). **Cardinality is bounded twice**: at most
10 tags per request, and at most 1000 values per organization, dimension and hour (and day), the
busiest first; the rest are summed as `__other__`. The request log keeps every tag of every request
for its retention, and `GET logs/:id` shows `tags` and `costCenter`.

| API                                                                      | returns                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `GET stats/dimensions?dimension=tag` (or `cost_center`)                  | usage per tag in the range                                    |
| `GET stats/dimensions?dimension=tag&value=feature:summary&groupBy=model` | that tag's usage by model (also `key`, `project`, `provider`) |
| `GET stats/analytics`                                                    | `byTag` and `byCostCenter`, the ten that cost most            |

On **Analytics**, "Usage by" switches between end user, tag and cost center; "Only this value"
filters to one tag (or cost center) and shows it by model; **Export CSV** saves the list shown.

## Verification

- `apps/gateway/src/tags.test.ts`: tag merging, the cap of 10, invalid names; with Valkey, a tag
  budget stops the requests carrying the tag (also through a key's default tags) and no others,
  not the same tag in another organization; a cost-center budget stops its requests; usage events
  carry both.
- `apps/worker/src/tags.integration.test.ts`: request log and ledger columns, usage per tag (a
  request counting for each tag) and per cost center, reconcile of a tag budget.
- `apps/control-api/src/stats/attribution.integration.test.ts`: tags on keys and in the snapshot,
  tag and cost-center limits and their usage, analytics by tag and one tag by model.
- `apps/dashboard/src/pages/end-users.test.tsx` and `scope-limits.test.tsx`: the analytics
  dimension switch, filter and CSV; limiting a tag by name.
