# Rate limit and concurrency (cards 5.7 and 6.1)

DiRouter has two layers of limits:

| layer                        | where                          | scope  | purpose                                                                                                                             |
| ---------------------------- | ------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **distributed rate limiter** | Valkey, shared by all replicas | global | RPM, TPM and concurrency for key, project and team                                                                                  |
| **bulkhead**                 | memory of each replica         | local  | protects the node itself: concurrency cap for provider and key with a short queue ([gateway/internals.md](../gateway/internals.md)) |

## Scopes and configuration

| scope       | table / API                                                                               | fields                          |
| ----------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
| virtual key | `virtual_keys` (`POST/PATCH /orgs/:org/keys`)                                             | `rpm`, `tpm`, `maxConcurrency`  |
| project     | `rate_limit_policies` with scope=PROJECT (`PUT /orgs/:org/limits/project/:id`, card 25.5) | `rpm`, `tpm`, `max_concurrency` |
| team        | `rate_limit_policies` with scope=TEAM (`PUT /orgs/:org/limits/team/:id`)                  | same                            |

Each request must be under the limit of **all** its scopes (the key, the key's project, and the project's team). All are checked with one atomic Lua script, and if one rejects, none is consumed. Config comes from the snapshot (card 3.9), and a change reaches the gateway in less than one second.

## Algorithms

The reference clock `TIME` is Valkey's own, so clock differences between nodes have no effect.

- **RPM: exact sliding window** (sliding log)
  - Each accepted request is a member of ZSET `dirouter:rl:rpm:<scope>` with a time score. In any 60-second window at most `rpm` requests are accepted, and a burst at the start of the minute is not compensated later.
  - Memory is O(rpm) per scope.
  - `Retry-After` is exactly the time when the oldest request leaves the window.
- **TPM: reservation and settlement**
  - One-second buckets in HASH `dirouter:rl:tpm:<scope>`.
  - Before the request, an estimate is reserved: input with the fast tokenizer + `min(max_tokens ?? 1024, 8192)`.
  - After the response, the difference from actual usage (input + output) is settled in the same bucket. A failed request returns its estimate.
  - A request larger than the entire cap is accepted only when the window is empty, so it cannot get stuck forever.
- **Concurrency: semaphore with TTL**
  - ZSET `dirouter:rl:conc:<scope>` with an "expiry time" score (default 15 minutes).
  - Removed when the request (or stream) ends. If a node dies, its slot is reclaimed by the TTL.

## Response

A successful response (JSON and stream) carries these headers from the scope with the fewest remaining requests:

```
x-ratelimit-limit-requests: 60
x-ratelimit-remaining-requests: 59
x-ratelimit-reset-requests: 60s
x-ratelimit-limit-tokens: 100000        (if it has tpm)
x-ratelimit-remaining-tokens: 98200
x-ratelimit-reset-tokens: 60s
```

Rejection means 429 with `Retry-After` (seconds) and `x-ratelimit-remaining-requests: 0`:

- OpenAI: `{"error":{"type":"rate_limit_error","code":"rate_limited","message":"Rate limit exceeded for key (requests)"}}`
- Anthropic: `{"type":"error","error":{"type":"rate_limit_error",...}}`

The message says which scope (`key`, `project` or `team`) and which type (`requests`, `tokens` or `concurrency`), but not the IDs.

## Valkey outage

The limiter uses a separate Valkey connection with `enableOfflineQueue: false` and a 100ms timeout per command. Any error or slowness activates degraded mode for 1 second, so each request does not pay a timeout. Behavior is controlled by `settings.failMode`:

| failMode         | behavior during outage                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open` (default) | local limiter in each node's memory with share `ceil(limit / number of live nodes)`. The node count is read every 5 seconds from heartbeats (`dirouter:gateway:node:*`), and the last valid value is kept. |
| `closed`         | requests of scopes that have a cap get 429 "Rate limiter unavailable (fail-closed)"; keys without a cap work normally.                                                                                     |

In no mode does a Valkey outage return a 5xx error. Accuracy in `open` mode is lower: the local limiter has no window history. During an outage minute, up to a full extra cap may be accepted; after Valkey returns, global counting continues.

Without `VALKEY_URL` (single-node run), the local limiter works with its full share.

Status in `GET /internal/health` (with INTERNAL_TOKEN):

```
"rateLimiter": {"remote": …, "local": …, "rejected": …, "degraded": false, "nodes": 3}
```

## Verification (2026-11-08)

- **Tests:**
  - `apps/gateway/src/rate-limiter.test.ts`: 6 local limiter tests and 2 outage tests (Valkey down: local fail-open, fail-closed with 429). With `INTEGRATION_VALKEY_URL`, also 5 tests on a real Valkey:
    - three nodes with a cap of 60 over a compressed 3-second window in 7.5 seconds: 180 ± 5%
    - Retry-After
    - TPM between two nodes
    - global concurrency
    - reclaiming a slot with the TTL
  - `apps/gateway/src/limits.test.ts`: headers in JSON and stream, 429 in both formats, and the shared project cap.
- **Load test:**
  - Setup: three replicas of the production image behind Traefik, with one Valkey, and one key with `rpm: 60` created from control-api
  - Load: 11 concurrent clients over 150 seconds
  - Result: 180 requests accepted (60 / 60 / 60 per minute, zero error rate), 36822 responses of 429, and zero 5xx
  - Distribution across nodes: 61 / 61 / 58
  - 130-second repeat: again 180 accepted, with batches starting at 0.07s, 60.07s and 120.1s
  - With a 0.5-second tolerance for response-time jitter at the window edge, the maximum in any 60-second window was exactly 60.
- **Valkey outage:**
  - `docker pause` on Valkey for 20 seconds, during load
  - zero 5xx; 1175 requests with keys without a cap, all 200
  - each node went once to the local limiter (log "local fallback"), and after Valkey returned, it went back to global mode

# Budget (card 6.3)

A budget is a dollar or token cap for a period:

| scope          | setting                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| key            | `budgets` in `POST/PATCH /orgs/:org/keys` (up to two budgets: daily and monthly)                        |
| project / team | `budgets` in `PUT /orgs/:org/limits/:scope/:id` (card 25.5; `budgets` table with scope=PROJECT or TEAM) |

Each budget has these fields: `period` (`daily` or `monthly`), `limitUsd` and/or `limitTokens`, and `alertThresholds` (default `[50, 80, 100]`).

## Counter in Valkey

- **Key**: `dirouter:budget:<budgetId>:<periodKey>`, where `periodKey` is `d:2026-11-08` or `m:2026-11` (**UTC**).
- **Automatic reset**: the start of a period means a fresh key. The old key is deleted with a TTL one week after the period ends.
- **Fields**:
  - `usd`: integer in units of 1e-8 dollars, the same precision as the ledger's `Decimal(18,8)`, with no float error
  - `tokens`: input + output
  - `ts`: time of the last increase
- **Before the request**: if the counter of any budget of the key, project or team has reached its cap, the request is rejected. The cost of the request itself is not known before it runs, so a request that has started finishes, and the **next request** is rejected. As a result, spending can exceed the cap by the amount of the last concurrent requests.
- **After the request**: a Lua script atomically increases the counters by the actual cost and tokens (the same `costUsd` as the usage event).

## Response

429 with `Retry-After` until the start of the next period:

- OpenAI: `{"error":{"type":"insufficient_quota","code":"budget_exceeded","message":"Daily key budget exceeded (USD 5)"}}`
- Anthropic: `{"type":"error","error":{"type":"billing_error","message":"…"}}`

## Threshold alert

On each increase, the value before and after is compared. Crossing any threshold (dollar and token separately) is recorded only once, and only by one replica, using `SET NX` on `dirouter:budget:alerted:<id>:<period>:<kind>:<t>`, and the event is added to the list `dirouter:budget:alerts`.

The worker runs every 10 seconds (job `budget-alerts`) and writes this list to `audit_logs`:

```
action = budget.threshold_crossed, target_type = budget
diff = {threshold, kind, spent, limit, scope, scopeId, period, periodKey, at}
```

If the DB write fails, the events are returned to the list.

## Reconcile with the ledger

The job `budget-reconcile` in the worker runs every 5 minutes. For each budget, it computes the sum of `usage_ledger` for the current period. Scope column: `api_key_id`, `project_id` or `team_id`. It then reconciles the counter with an atomic Lua script:

| counter state                                       | action                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| missing (Valkey restart, outage during an increase) | equals the ledger                                                                                                       |
| quiet (no increase in the last 2 minutes)           | exactly equals the ledger, whether it was higher or lower (e.g. an event that went to the DLQ)                          |
| active                                              | only raised (`max(counter, ledger)`); the ledger lags a few seconds, and events in transit must not be subtracted twice |

Corrections are logged with `budget counters reconciled with ledger` and the drift list. The ledger is the source of truth for billing; the counter is only for fast decisions.

## Valkey outage

| failMode         | behavior                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| `open` (default) | the request passes. Lost increases are compensated by reconcile from the ledger |
| `closed`         | 429 `budget_exceeded` with "Budget check unavailable"                           |

## Verification (2026-11-08)

- **Tests:**
  - `apps/gateway/src/budget-guard.test.ts`: Valkey outage (open/closed), and with a real Valkey:
    - rejection of requests after the dollar and token cap
    - reset in the next period
    - the 50/80/100 thresholds fire exactly once with three simultaneous replicas
    - end to end: 429 with `insufficient_quota` and `billing_error`
  - `apps/worker/src/budgets.integration.test.ts`: a missing counter is restored, slow drift is corrected, an active counter is preserved, a second run has no effect, and alerts are recorded in audit_logs.
- **Through Traefik**, with a key that has a daily budget of 0.00001 dollars:
  - 4 requests returned 200, then 429 `budget_exceeded` (OpenAI: `insufficient_quota`; Anthropic: `billing_error`), with `Retry-After` until UTC midnight
  - the counter (1120 units, 72 tokens) exactly equaled the ledger sum (0.0000112 dollars, 72)
  - audit_logs had three rows, for 50, 80 and 100%
- **Counter deletion** (simulating loss): one request passed. The `budget-reconcile` job raised the counter from 280 to 1400 units (equal to the ledger), and the next request got 429 again.

# Team and project limits API (card 25.5)

The gateway enforced team and project limits from the snapshot since cards 6.1 and 6.3, but nothing
wrote them. `orgs/:orgId/limits` does, and the dashboard uses it on the **Organization** page
(edit) and the **Cost** page (current usage).

| Method and path                 | Permission   | What it does                                                                                                                                                       |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET limits`                    | `org:read`   | every team and project that has a rate limit or a budget                                                                                                           |
| `GET limits/:scope/:scopeId`    | `org:read`   | the limits of one team (`scope=team`) or project (`scope=project`); empty values when none are set                                                                 |
| `PUT limits/:scope/:scopeId`    | `org:write`  | `rpm`, `tpm`, `maxConcurrency` (a number, or `null` to remove; absent keeps it) and `budgets` (replaces every budget of the scope; absent keeps them)              |
| `DELETE limits/:scope/:scopeId` | `org:write`  | removes every rate limit and budget of the scope                                                                                                                   |
| `GET limits/usage`              | `usage:read` | every team and project with its spend today and this month (UTC) from the ledger, its rate limit, and each budget with `spentUsd`, `spentTokens` and `usedPercent` |

```json
PUT /api/v1/orgs/org_1/limits/project/prj_search
{
  "rpm": 120,
  "tpm": 50000,
  "maxConcurrency": null,
  "budgets": [{ "period": "monthly", "limitUsd": "25.50", "alertThresholds": [50, 90] }]
}
```

- A budget has the same shape as a key budget: `period`, `limitUsd` (up to 8 decimals) and/or
  `limitTokens`, and `alertThresholds` (1-100, default `[50, 80, 100]`); one budget per period.
- A budget keeps its id when its amount changes (upsert by scope, scope id and period), so the
  gateway keeps counting the current period on the same Valkey counter.
- **Four-eyes (card 22.2):** when the organization requires approval, a `PUT` or `DELETE` that
  changes the budgets answers `202` with the pending change request (kind `limit.budgets`) and
  nothing changes until a second person approves it. Changing only rate limits, or sending the
  same budgets again, is applied at once.
- Every change is audited as `limit.updated` and reaches the gateway with the next snapshot.
- Once a project's (or team's) budget is reached, every key of that project (or of every project
  of that team) gets `429 budget_exceeded`, e.g. `Monthly project budget exceeded (USD 25.5)`;
  keys of other projects are not affected (`apps/gateway/src/scope-budget.test.ts`).

# Organization, member, model and provider scopes; weekly and yearly budgets (card 33.1)

Limits and budgets also apply to four more scopes, and budgets have two more periods.

| scope          | `scopeId`                                                          | what it covers                                                | when exhausted                                                                                 |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `organization` | the organization id                                                | every key of the organization                                 | `429` for every key                                                                            |
| `user`         | a member's user id                                                 | every key that member created (`api_keys.created_by_id`)      | `429` for those keys                                                                           |
| `model`        | a model id of the organization (or a public model of the platform) | requests the organization sends to that model                 | the model is taken out of the route; a combo falls back, a request for the model itself is 429 |
| `provider`     | a provider id of the organization                                  | requests the organization sends to any model of that provider | the provider's targets are taken out of the route, as for a model                              |

They are written through the same API as teams and projects: `PUT /orgs/:org/limits/:scope/:scopeId`
with `scope` one of `organization`, `team`, `project`, `user`, `model` or `provider`. A scope id
outside the organization is `404` (another organization, someone who is not a member, another
tenant's model or provider). `GET limits/usage` lists the organization, every team and project and
every member, model and provider that has limits, with spend `today`, this `week`, this `month` and
this `year`; each budget's `usedPercent` is measured in its own period.

```json
PUT /api/v1/orgs/org_1/limits/organization/org_1
{ "budgets": [{ "period": "monthly", "limitUsd": "5000" }, { "period": "weekly", "limitUsd": "1500" }] }

PUT /api/v1/orgs/org_1/limits/model/mdl_gpt5
{ "rpm": 300, "budgets": [{ "period": "daily", "limitUsd": "200" }] }
```

## Periods

`period` is `daily`, `weekly`, `monthly` or `yearly`, all in UTC, for key budgets and shared
budgets alike (at most one budget per period, so up to four per scope).

| period    | counter key suffix | starts                                                     |
| --------- | ------------------ | ---------------------------------------------------------- |
| `daily`   | `d:2026-11-29`     | 00:00 UTC                                                  |
| `weekly`  | `w:2026-11-23`     | Monday 00:00 UTC (ISO 8601 week; the suffix is its Monday) |
| `monthly` | `m:2026-11`        | the 1st, 00:00 UTC                                         |
| `yearly`  | `y:2026`           | 1 January, 00:00 UTC                                       |

As before, a new period is a new counter, so the reset needs no job, and `Retry-After` points at the
start of the next period: `Weekly organization budget exceeded (USD 1500)`.

## On the request path

`apps/gateway/src/spend-guard.ts` decides what covers a request, for chat and for the metered APIs
(embeddings, images, audio):

1. **Budgets** of the key, its project and team, the organization, the key's member, and of every
   model and provider among the route's candidates are read in **one pipelined round trip**. An
   exhausted key, project, team, organization or member budget rejects the request. An exhausted
   model or provider budget removes the matching candidates; only when none is left is the request
   rejected (`… budget exceeded for every target of '<model>'`).
2. **Rate limits** of the same request scopes plus the model and provider of the first remaining
   candidate are checked and applied by **one atomic Lua script**, as for keys, teams and projects.
3. After the response, every budget is counted by one Lua script. Model and provider budgets only
   count requests that their model or provider actually served (a fallback is counted where it
   landed).

So the number of Valkey round trips per request does not grow with the number of scopes. Rate
counters of shared scopes carry the organization in their name (`org:<org>`,
`user:<org>:<user>`, `model:<org>:<model>`, `provider:<org>:<provider>`), and budgets are counted by
their own id, so one member who belongs to two organizations, or two organizations on one platform
model, never share a counter. The outage behaviour is unchanged: `failMode: open` lets requests
through and reconcile catches up, `closed` answers 429.

## Reconcile

The worker's `budget-reconcile` job rebuilds every counter from `usage_ledger`, always within the
budget's organization: `organization_id` for the organization, the member's keys for `user`, and the
new ledger columns `model_id` and `provider_id` for models and providers. Ledger rows written before
this release have no model or provider, so a model or provider budget starts counting at the
upgrade.

## Verification

- `apps/gateway/src/budget-scopes.test.ts`, with `INTEGRATION_VALKEY_URL`:
  - a monthly organization budget stops every key of the organization (another project and team
    included) and no key of another organization;
  - a member budget stops that member's keys, not a colleague's, and not the same person's key in
    another organization;
  - a used-up model budget moves a combo to its next target and refuses the model itself;
  - a provider rate limit counts every key of the organization on that provider;
  - a weekly budget is exhausted until Monday 00:00 UTC and starts from zero then, and a yearly
    budget until 1 January, on a fake clock;
  - overhead: the gateway and Valkey CPU of one admission, with and without the four extra scopes,
    differs by well under 0.3 ms (about 0.2 ms on a loaded development machine; the number of round
    trips is the same).
- `apps/control-api/src/limits/limits.integration.test.ts`: the four scopes over HTTP, ids outside
  the organization refused, the snapshot, keys carrying their member, and usage per period.
- `apps/worker/src/budgets.integration.test.ts`: each new scope rebuilt from its own ledger rows,
  never another tenant's.
- `packages/contracts/src/budget.test.ts`: week and year boundaries, including a week across New
  Year.

# Limits of a key on one model; input and output TPM (card 33.3)

## Input and output tokens per minute

Every rate limit (a key, a shared scope, or a key's model entry) can cap input and output tokens
apart, next to the total TPM:

| field (API) | snapshot                | counts                                                   |
| ----------- | ----------------------- | -------------------------------------------------------- |
| `tpm`       | `tokensPerMinute`       | input + output                                           |
| `inputTpm`  | `inputTokensPerMinute`  | input tokens (the fast-tokenizer estimate)               |
| `outputTpm` | `outputTokensPerMinute` | output tokens (`min(max_tokens ?? 1024, 8192)` reserved) |

Each side has its own one-second buckets (`dirouter:rl:itpm:<scope>`, `dirouter:rl:otpm:<scope>`),
checked and applied in the same Lua script as RPM, TPM and concurrency. After the response each
side is settled with the actual input and output tokens. A rejection names the side:
`Rate limit exceeded for key (input_tokens)` or `(output_tokens)`. The local fallback limiter
counts both sides the same way.

## A key's limits on one model

`POST/PATCH /orgs/:org/keys` take `modelLimits` (up to 50 entries, replacing all of them):

```json
{
  "modelLimits": [
    {
      "model": "openai/gpt-5",
      "rpm": 10,
      "outputTpm": 20000,
      "budgets": [{ "period": "daily", "limitUsd": "5" }]
    },
    { "model": "smart", "rpm": 30 }
  ]
}
```

`model` is a name as clients use it, like `allowedModels`:

- **A model slug** limits that model wherever it serves the key: a direct request, an alias, or a
  combo target. Its budget works like a model budget (card 33.1): when it is used up the model is
  taken out of the route, so a combo moves on and a request for the model itself gets
  `429 Daily key model budget exceeded for every target of 'openai/gpt-5'`. Its rate limit counts
  the request when the model is the first target.
- **An alias or combo name** limits the requests for that name as a whole.
- Every other model of the key stays free (only the key's own limits apply).

A budget keeps its id while its model and period stay the same, so the running counter survives an
edit; rotation moves the entries and their budgets to the new key. Budget changes in `modelLimits`
need four-eyes approval like other key budgets. The budgets are `budgets` rows with scope
`api_key_model` and scope id `<key id>|<model>`; the worker reconciles them from the ledger rows of
the key whose `requested_model` is the name or whose model has that slug (`usage_ledger` keeps the
requested name since this card).

In the dashboard, the key form has **Limits on single models**: one row per name with RPM, TPM,
input and output TPM and one budget (period and dollars; budgets set through the API on other
periods are kept).

## Verification

- `apps/gateway/src/model-limits.test.ts`: input and output windows in the local limiter and on
  Valkey (each side rejects alone and settles with the actual usage); through the gateway, a key
  with a cap on the expensive model is limited there and free on the cheap one, another key on the
  same model is not affected, a used-up per-model budget stops the model while a combo falls back,
  and an entry naming a combo limits that name.
- `apps/control-api/src/keys/keys.integration.test.ts`: entries and input and output TPM over HTTP,
  the snapshot, budget ids kept on edit, duplicate entries refused, rotation.
- `apps/worker/src/budgets.integration.test.ts`: reconcile of a key's model budget.
- `apps/dashboard/src/pages/model-limits.test.tsx`: the form rows.
