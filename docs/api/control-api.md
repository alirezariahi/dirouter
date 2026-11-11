[English](control-api.md) · [فارسی](control-api.fa.md)

# Management API (control-api)

Base: `https://admin.<DOMAIN>/api/v1` · Swagger: `/api/docs` (JSON: `/api/docs/openapi.json`) · cards 3.3 and 3.10

- **Authentication**: `Authorization: Bearer <accessToken>` from `/auth/login`; the refresh token is in a cookie ([auth.md](../control-api/auth.md)).
- **Errors**: `application/problem+json` with a stable `code` (`not_found`, `forbidden`, `validation_failed` with `errors[]`, `conflict`, `login_locked` and …) and `requestId`.
- **Access**: all organization routes below are under `/orgs/:orgId/…`, with the permission matrix in [rbac.md](../rbac.md). Not being a member returns 404.

| Group (tag)   | Routes                                                                                     | Document                                    |
| ------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| auth          | `/auth/setup`, `login`, `refresh`, `logout`, `password`, `me`, `invitations/accept`        | [auth.md](../control-api/auth.md)           |
| organizations | `/orgs/:orgId`, `members`, `invitations`, `teams`, `projects`                              | [rbac.md](../rbac.md)                       |
| providers     | `/orgs/:orgId/providers` and credentials, `test` and `discover`                            | [providers.md](../control-api/providers.md) |
| virtual keys  | `/orgs/:orgId/keys`, `revoke` and `rotate`                                                 | [keys.md](../control-api/keys.md)           |
| models        | `catalog`, `models` (and `sync-catalog`), `aliases` and `combos`                           | [routing.md](../concepts/routing.md)        |
| stats & logs  | `stats/overview`, `stats/timeseries`, `stats/top`, `logs`, `logs/:id` and `health/runtime` | Below on this page                          |

`openapi.test.ts` checks in CI that the document is complete:

- Every operation has a response schema.
- Every write operation that has a body has a request schema. All schemas are built from the same zod validation, so the document and the behavior are identical.
- `/internal/*` endpoints are not in the public document.

## Stats and logs (card 3.10, permission `usage:read`)

Shared filters:

- `from` and `to` (ISO; default is the last 24 hours, and for logs the last 7 days; maximum 400 days)
- `projectId`, `apiKeyId`
- `model` (requested name: model, alias or combo)

| endpoint                                                                     | Source                                                                | Output                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET stats/overview`                                                         | `usage_hourly`, or `usage_daily` for a range longer than 7 days       | requests, errors, errorRate, tokens, costUsd, avgLatencyMs, avgTtftMs, `latencyP50/P95/P99Ms` (approximate from the histogram: upper bound of the bucket), activeKeys, models |
| `GET stats/timeseries?granularity=hour\|day`                                 | hourly or daily                                                       | data points for each bucket                                                                                                                                                   |
| `GET stats/top?by=model\|key\|project\|provider&metric=cost\|requests&limit` | aggregated                                                            | top consumers                                                                                                                                                                 |
| `GET logs?status&httpStatus&limit&cursor`                                    | `request_log` (always with a time range, until partitions are pruned) | newest first, with `nextCursor`                                                                                                                                               |
| `GET logs/:id`                                                               | `request_log`                                                         | details and **all attempts** (`attempts`)                                                                                                                                     |
| `GET health/runtime`                                                         | gateway (`/internal/health`, synchronized across replicas)            | breaker for each provider and model; cooldown, lockout and disabled state of each credential. Only items of this organization.                                                |

- **Stable cursor**: sorting is on `(created_at, id)`, and the cursor is that pair encoded as base64url. The next page is `WHERE (created_at, id) < cursor`. So rows that arrive during paging or share the same timestamp do not shift or duplicate pages.
- Integration test:
  - 130 rows (30 of them with the same timestamp) in pages of 17, with 5 new rows arriving mid-way: exactly 130 unique IDs, with no duplicates or gaps.
  - Data from other organizations was not visible on any endpoint.
