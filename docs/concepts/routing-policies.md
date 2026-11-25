[English](routing-policies.md) · [فارسی](routing-policies.fa.md)

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
