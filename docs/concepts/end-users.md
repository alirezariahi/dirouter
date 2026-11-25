[English](end-users.md) · [فارسی](end-users.fa.md)

# End users (card 33.2)

A product built on DiRouter usually has users of its own. DiRouter calls them **end users**: it
does not log them in, it only takes the id the product sends with each request, so the product can
give each of its users a budget and a rate limit, block one, and see what each one costs.

## Naming the end user in a request

| where                        | example                                   |
| ---------------------------- | ----------------------------------------- |
| header `x-dirouter-end-user` | `x-dirouter-end-user: cust_42`            |
| OpenAI body field `user`     | `{"model": "…", "user": "cust_42", …}`    |
| Anthropic `metadata.user_id` | `{"metadata": {"user_id": "cust_42"}, …}` |
| Responses API `user`         | `{"model": "…", "user": "cust_42", …}`    |

The header wins when both are present; embeddings, images and audio take the header or their
`user` field. The id is trimmed and kept as is (case matters) when it has 1 to 256 characters and no
control characters; `*` is reserved. A request with no valid id has no end user: end-user limits do
not apply to it, and its usage is not attributed.

The organization's own ids are scoped to the organization: `alice` of one organization and `alice`
of another never share a limit, a counter or a report row.

## Limits and budgets

End-user limits go through the limits API with `scope = end_user`:

| `scopeId`        | meaning                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `*`              | the **defaults**: every end user gets this rate limit and these budgets, each on counters of its own   |
| an end user's id | that end user's own limits; its own rate limit and its own budgets replace the defaults field by field |

```json
PUT /api/v1/orgs/org_1/limits/end_user/*
{ "rpm": 20, "budgets": [{ "period": "daily", "limitUsd": "1" }] }

PUT /api/v1/orgs/org_1/limits/end_user/cust_42
{ "rpm": 200, "budgets": [{ "period": "monthly", "limitUsd": "100" }] }
```

Ids with characters such as `/` or `|` must be URL-encoded in the path. Budgets have the same four
periods as every other budget (daily, weekly, monthly, yearly), alert thresholds, and the
four-eyes approval of card 22.2.

On the request path (`apps/gateway/src/spend-guard.ts`) the end user is one more request scope, so
it costs no extra Valkey round trip:

- an exhausted end-user budget answers `429 budget_exceeded`, e.g.
  `Daily end user budget exceeded (USD 1)`, with `Retry-After` until the next period; other end
  users, and requests without an end user, are not affected;
- a full end-user rate window answers `429 rate_limited`,
  `Rate limit exceeded for end user (requests)`;
- default budgets are counted per end user on `dirouter:budget:<budget id>:eu:<end user>:<period>`,
  and the worker's `budget-reconcile` job rebuilds those counters from the ledger
  (`usage_ledger.end_user`) per end user.

## Blocking

`PUT /api/v1/orgs/:org/end-users/:endUser` with `{"blocked": true}` blocks an end user (it need not
have been seen yet); every request naming it gets `403 end_user_blocked` (OpenAI and Anthropic
`permission_error`) before anything is counted. `{"blocked": false}` lets it back in. Both are
audited (`end_user.blocked`, `end_user.unblocked`) and reach the gateway with the next snapshot.

## The end-user list and its usage

The worker records every end user a request names in `end_users` (first and last time seen), and
rolls usage up per end user into `usage_dimension_hourly` and `usage_dimension_daily`
(`dimension = 'end_user'`). Each organization keeps at most **1000 end users per hour** (and per
day) as rows of their own, the busiest first; the rest are summed as `__other__`, so a product with
millions of users cannot blow up the tables. The raw request log keeps every id for its retention.

| Method and path                                 | Permission   | What it returns                                                                        |
| ----------------------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `GET end-users?search=&blocked=&limit=&offset=` | `usage:read` | end users, most recent first, with this month's requests and cost                      |
| `GET end-users/:endUser`                        | `usage:read` | one end user with its own limits and the last 30 days of usage                         |
| `PUT end-users/:endUser`                        | `org:write`  | blocks or unblocks it                                                                  |
| `GET stats/dimensions?dimension=end_user`       | `usage:read` | usage per end user in a range (`value=` and `groupBy=model` for one end user by model) |

`GET stats/analytics` also returns `byEndUser`, the ten end users that cost most.

## Dashboard

- **End users** (Govern): the defaults every end user gets, the list with search and a status
  filter, block and unblock, and per end user its last 30 days and its own limits.
- **Analytics**: "Usage by end user", ranked by cost, a click shows that end user by model, and the
  list exports as CSV.

## Verification

- `apps/gateway/src/end-users.test.ts`: header and body attribution; with Valkey, an end user with
  a used-up budget gets 429 while other end users, requests without an end user and the same id in
  another organization pass; one counter per end user for the default budget; an own rate limit
  replaces the default; a blocked end user gets 403; the usage event carries the end user.
- `apps/control-api/src/end-users/end-users.integration.test.ts`: defaults, own limits and blocking
  over HTTP, ids with `/` and `|`, the snapshot, the list, one end user's days, and
  `stats/dimensions` by end user and by model.
- `apps/worker/src/end-users.integration.test.ts`: the writer records end users and the ledger
  column, the rollup per end user, the cap of 1000 values per hour with `__other__`, and the
  reconcile of default budgets per end user.
- `apps/dashboard/src/pages/end-users.test.tsx`: the page and the analytics section.
