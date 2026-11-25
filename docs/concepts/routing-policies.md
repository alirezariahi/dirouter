# Routing policies

> Code: `packages/routing` (`rules-expr.ts`, `rules.ts`), the gateway stage in
> `apps/gateway/src/routing-policy.ts`, the API in `apps/control-api/src/routing-policies` and the
> **Routing policies** page of the dashboard (sprint 5).

Routing policies run on every request **before** a model is chosen: after authentication,
guardrails and compression, and before `auto*` routing and the resolver of [routing](routing.md).
Everything downstream sees the policy's target as if the client had asked for it; the answer still
carries the name the client sent.

## 1. Conditional rules (card 32.2)

A rule is a condition and an action. Rules of an organization run in **priority order** (lowest
first). The first matching `route` or `reject` decides the request; a matching `tag` adds labels
and evaluation goes on.

| Action   | Effect                                                                              |
| -------- | ----------------------------------------------------------------------------------- |
| `route`  | Send the request to another model, alias, combo or `auto*` name of the organization |
| `reject` | Refuse it with the rule's message and status (403, 400 or 429)                      |
| `tag`    | Record up to 10 `key=value` labels with the request (usage event and request log)   |

A rule applies to the whole organization, or only to the keys of one **team** (a team's own
policy) or one project. Rules never widen a key's access: the key's `allowedModels` is checked
against the name the client sent before any rule runs.

### Expression language

A safe subset of CEL. Conditions are parsed and type checked when the rule is **saved** (an invalid
condition is refused with a 400 and the position of the problem) and compiled into closures when
the gateway loads a snapshot. There are no loops, regular expressions or user functions, so an
expression always finishes in time proportional to its length.

| Variable                                                    | Type   | Meaning                                                                              |
| ----------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `request.model`                                             | string | The name the client sent                                                             |
| `request.api`                                               | string | `openai.chat`, `anthropic.messages`, …                                               |
| `request.stream`, `request.has_tools`, `request.has_images` | bool   |                                                                                      |
| `request.headers['x-tier']`                                 | string | A request header (lower case); credential headers such as `authorization` are hidden |
| `request.metadata.feature`                                  | string | The request's `metadata` field                                                       |
| `request.estimated_tokens`, `request.max_output_tokens`     | number | Input estimate and output cap                                                        |
| `request.user`                                              | string | The end-user id                                                                      |
| `key.id`, `key.team`, `key.project`, `key.organization`     | string | The calling key (`key.team` is empty without a team)                                 |
| `budget.key`, `budget.project`, `budget.team`, `budget.max` | number | Percent of the current period's budget already spent (0 without a budget)            |

Operators: `|| && ! == != < <= > >= in + - * / %`; functions `size()`, `has()`, `int()`,
`double()`, `string()`; string methods `startsWith`, `endsWith`, `contains`, `lowerAscii`.

```text
budget.team > 80                                     → route to a cheap model
request.headers['x-tier'] == 'gold'                  → route to the best model
request.metadata.feature in ['search', 'autocomplete'] → tag feature=search
request.estimated_tokens > 100000 && key.team == ''  → reject (400)
```

### Budget spend

When a rule reads `budget.*`, the gateway reads the key's, project's and team's counters from
Valkey (one round trip, cached for one second per budget). Without Valkey every share reads 0.

### Cost on the hot path

The criterion is under 0.2 ms per request; the routing package measures a realistic set of 20
rules at a few microseconds (`rules.test.ts`). An organization without rules pays one map lookup.

### API

| Method and path                                            | Permission     |
| ---------------------------------------------------------- | -------------- |
| `GET /orgs/:orgId/routing/rules`                           | `models:read`  |
| `POST /orgs/:orgId/routing/rules`, `PATCH`/`DELETE …/:id`  | `models:write` |
| `POST /orgs/:orgId/routing/rules/validate` `{ condition }` | `models:read`  |
| `GET /orgs/:orgId/routing/rules/traffic?from&to`           | `usage:read`   |

The traffic report counts, for each rule, the requests it matched and decided and its share of the
organization's requests in the range (default: the last 24 hours), from the request log's `policy`
column. The routing simulator (`POST /orgs/:orgId/routes/simulate`) accepts `headers`, `metadata`
and `budget: { key, project, team }` and returns the matched rules and the final target.

Each request records what the rules did in the usage event's `policy.rules` (`matched`,
`decidedBy`, `target`, `tags`) and the response carries `x-dirouter-rule` with the deciding rule.

## 2. Canary and percentage traffic splits (card 32.3)

A split sends requests for one name (`match`, what clients or a rule ask for) to a `canary` target
for `canaryPercent` of the traffic (0–100, two decimals) and to `stable` for the rest. It runs
right after the rules, so a rule's target can be split too.

- **Stickiness.** `key` (default) keeps a key on its branch, `session` keeps a session (the
  session-affinity header, default `x-dirouter-session`, falling back to the key) and `request`
  draws per request. The branch comes from a hash of the split id and the identity into 10,000
  buckets: raising the percentage only moves stable identities to the canary. Over 10,000
  identities the observed share is within ±1% of the setting (`split.test.ts`,
  `traffic-split.test.ts` and the end-to-end scenario).
- **Versions.** Every change is a new version with its reason (`created`, `updated`, `rollback`,
  `auto_rollback`, `restore`). `POST …/rollback` without a body sends everything back to stable at
  once (state `rolled_back`); with `{ toVersion }` that version's settings become the newest
  version. Changing the canary or its share, or `PATCH { state: 'active' }`, resumes a rolled-back
  split.
- **Automatic rollback.** With `autoRollback` (`errorRate`, default 0.2; `minRequests`, default
  20; `windowSeconds`, default 60) the gateway watches the canary's failures (any 5xx answer,
  including no available provider) in a rolling window. When the rate crosses the threshold the
  replica stops using the canary at once, sets `dirouter:split:rolledback:<id>:<version>` in Valkey
  (the other replicas read these flags every two seconds) and queues an event on
  `dirouter:splits:rollbacks`; control-api turns it into a new `rolled_back` version within seconds.
  The stable branch is never rolled back.
- **Comparison.** `GET …/splits/:id/report?from&to&version` compares the branches: requests,
  errors and error rate, average and p95 latency, average time to first token, tokens and total and
  average cost, from the request log (`policy.split`).

Responses carry `x-dirouter-split: <id>; v=<version>; branch=<stable|canary>`; the client-facing
model name stays the one the client sent.

| Method and path                                                                   | Permission     |
| --------------------------------------------------------------------------------- | -------------- |
| `GET /orgs/:orgId/routing/splits`, `GET …/:id/versions`                           | `models:read`  |
| `POST /orgs/:orgId/routing/splits`, `PATCH`/`DELETE …/:id`, `POST …/:id/rollback` | `models:write` |
| `GET /orgs/:orgId/routing/splits/:id/report`                                      | `usage:read`   |

## 3. Shadow traffic (card 32.4)

A shadow policy mirrors a sample (`sampleRate`, 0–1) of the requests for one name (`match`, or
`*` for all, optionally one `projectId`) to a `target` model, to measure a new model on real
traffic without anyone noticing.

- **No effect on the client.** The copy starts only after the client has its whole answer (a
  stream has ended), detached from the request, as a non-streaming call with its own timeout
  (`timeoutMs`, default 60 s). It does not touch the key's rate limit or concurrency cap, budgets,
  wallet, provider bulkheads, breakers, routing statistics, caches or body capture, so a slow or
  failing shadow model changes nothing the client sees. A replica runs at most 32 copies at once
  and drops the rest; every error is swallowed.
- **Who pays.** The target must be one of the organization's **own** models (or an alias or combo
  of them): the organization pays its own provider for its own experiment. A public marketplace
  model is refused when the policy is saved and ignored by the gateway. The customer is charged
  nothing (`chargeUsd` 0), nothing is reserved or debited from a wallet, and the cost never counts
  against a key, project or team budget.
- **Recorded apart.** Each copy is a usage event with `shadow` set (`requestId` is
  `<primary>:shadow`). The worker stores it in `shadow_requests` only, never in `request_log`, the
  ledger, the hourly and daily rollups or a wallet, so usage, invoices and budgets are unchanged.
  Only the owning organization can read it.
- **Own budget.** `dailyBudgetUsd` caps a policy's spend per UTC day (Valkey counter
  `dirouter:shadow:spend:<policy>:<day>`); at the cap the policy stops until the next day. When the
  counter cannot be read the copy is skipped.
- **Comparison.** `GET …/shadows/:id/report?from&to` compares the shadow and the primary answers:
  errors, average and p95 latency and cost, plus today's shadow spend against the cap.

| Method and path                                             | Permission     |
| ----------------------------------------------------------- | -------------- |
| `GET /orgs/:orgId/routing/shadows`                          | `models:read`  |
| `POST /orgs/:orgId/routing/shadows`, `PATCH`/`DELETE …/:id` | `models:write` |
| `GET /orgs/:orgId/routing/shadows/:id/report`               | `usage:read`   |

## 4. Controls of automatic routing (card 32.8)

An organization and each of its keys can tune `auto*` routing without building a combo:

- **Cost tier** `low`, `medium` or `high`. A model's tier comes from its price per million tokens
  blended 3:1 (three input tokens per output token): `low` up to $1, `medium` up to $10, `high`
  above (instance-wide in `settings.autoRouting.costTiers`).
- **Allowed and denied models**: slugs or `*` patterns (`openai/*`). An empty allowed set means
  every model; a denied model is out whoever allows it.
- **Administrator lock** (organization only): a key's own policy can then only narrow it (the
  cheaper tier, both allowed sets, every denied model). Saving a key policy that would widen a
  locked one is refused with a 400.
- **Reasoning effort**: with `auto` (default) automatic routing picks an effort when the client
  sent none and the chosen model can reason: more for reasoning and large coding work, the least for
  chat, never above the tier (`low` keeps it `low`). `off` leaves it to the client.

The policy filters concrete models twice: the names `auto*` chooses between (a name whose models
are all excluded is not a choice; the cheapest capable pool entry that remains is used instead) and
the resolved candidates, so a combo's fallback cannot bring an expensive or excluded model back.
Hence with `low` no request reaches a model above the `low` ceiling and a model outside the allowed
set is never selected; when nothing remains the request gets a 404 or 403 naming the policy. Names
the client asks for directly are not affected.

The decision records the tier (`routing.costTier`), the chosen effort (`routing.reasoningEffort`)
and the reasons, e.g. `cost tier low: up to $1 per million tokens`, `allowed models: …` and
`reasoning effort medium`.

| Method and path                                                                 | Permission     |
| ------------------------------------------------------------------------------- | -------------- |
| `GET /orgs/:orgId/routing/auto` (both levels, tier ceilings, each model's tier) | `models:read`  |
| `PUT`/`DELETE /orgs/:orgId/routing/auto`                                        | `models:write` |
| `PUT`/`DELETE /orgs/:orgId/routing/auto/keys/:keyId`                            | `keys:write`   |
