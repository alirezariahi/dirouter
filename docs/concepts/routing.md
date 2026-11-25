# Routing, fallback and health

> Code: `packages/routing` (cards 5.1, 5.3, 5.5, 5.6). No I/O; the index is built once per ConfigSnapshot.

See also [request-level routing](request-routing.md): provider preferences, fallback models and routing policies (sprint 5).

## 1. Model name resolution

```
client name ──► alias? ──► model | combo
           └─► combo slug? ──► combo
           └─► model slug?  ──► model
           └─► model_not_found (404)
```

- Lookup is always within the **key's organization**; names of other organizations are not visible.
- If the key's `allowedModels` is not empty, the requested name must be in it (`model_not_allowed`, 403).

## 2. Target order (combo strategy)

| strategy      | behavior                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `priority`    | by `order` (fill-first): always the first one, then fallback                                       |
| `weighted`    | weighted random order without replacement; a target with weight 0 is always last                   |
| `round-robin` | rotating start; the counter is per (combo, key), so each key has its own rotation (sticky per key) |

The credentials of each model are also randomly ordered by weight (`weight`), and each (model, credential) pair is a **candidate**.

## 3. Filters

A target is dropped in these cases (the reason is recorded in `skipped` for logs and the simulator):
`model_disabled`, `provider_disabled`, `context_window` (estimated input tokens + max_tokens exceed the model's context), `provider_circuit_open`, `model_circuit_open`, `credential_disabled`, `credential_cooldown`.
If no candidate remains: `no_available_provider` (503).

## 4. Execution: retry and fallback

For each candidate, in order:

1. Attempt; if successful → done.
2. If the error is `retryable` (server, overloaded, timeout, connection) and the attempts are fewer than `retry.maxAttempts` → wait (Retry-After, or exponential backoff with full jitter: `random(0, min(maxDelay, base·2^(n-1)))`) and try again on the same candidate.
3. `rate_limit` is not repeated on the same credential; it moves directly to the next candidate (usually another credential of the same model).
4. Fallback happens only if the error class is `fallbackAllowed` **and** it is in `combo.fallbackOn`. `bad_request` and `content_filter` never fall back ([errors.md](errors.md)).
5. After a provider-level error (server, overloaded, connection, timeout), the remaining candidates of the same provider are skipped in this request.
6. After `context_length`, only candidates with a larger context window are tried.

Limits:

- The total request **deadline**; a wait that goes past the deadline is not performed.
- A per-node global **retry budget**: in each 10-second window, retries and fallbacks are at most 20% of requests + 10. During a full outage, traffic to upstream does not multiply.
- **committed**: if part of a stream has already reached the client, no other attempt is made.
- A client disconnect (`AbortSignal`) stops all attempts.

All attempts (`provider`, `model`, `credential`, result, error class, status, latency and start time) are recorded in `attempts`. This array is part of the UsageEvent, and the worker stores it in the JSONB column `request_log.attempts`. A real example in dev for alias `gpt-4.1`:

```sql
SELECT jsonb_array_length(attempts), attempts->0->>'outcome', attempts->-1->>'providerId'
FROM request_log WHERE requested_model = 'gpt-4.1';
-- 3 | error | mock      (two 503 errors on mock-down, then success on mock)
```

### Multi-layer timeouts

| timeout       | default | what it measures                                                                                                                | after that                                                            |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `connectMs`   | 5s      | TCP and TLS handshake (`connect.timeout` in undici)                                                                             | `timeout` error, with possible retry and fallback                     |
| `firstByteMs` | 60s     | stream only: until the headers **and** the first chunk. Not applied in non-stream, because the model builds the whole response. | before any byte is sent, fallback                                     |
| `idleMs`      | 60s     | gap between two chunks in a stream                                                                                              | if bytes were already sent, a stream error (fallback is not possible) |
| `totalMs`     | 10m     | whole attempt                                                                                                                   | same as above                                                         |

The layers stack field by field: the `settings.defaultTimeouts` defaults, then `combo.timeouts`, then `provider.timeouts`. The last word belongs to the provider, because it knows the real upstream limit (for example `mock-long` with a fifteen-minute total). Each timeout reaches upstream through an `AbortController` and really closes the connection.

Separate tests for each layer are in `apps/gateway/src/upstream.test.ts`, on raw TCP/HTTP servers:

- connect with a server that never completes the TLS handshake: under 1.5 seconds, class `timeout`, fallbackAllowed.
- TTFT: once without headers, and once with headers but no chunk.
- idle: a stream that stops after the first chunk.
- total: a stream that keeps sending chunks but exceeds the total.
- TTFT is not applied to non-stream.
- upstream is closed under 1 second after the client disconnects.

## 5. Circuit breaker (provider and model)

- 30-second sliding window (10 buckets), minimum 10 requests, 50% error threshold.
- Only service-health errors are counted (server, overloaded, timeout, connection); a user error or key does not open the breaker.
- `CLOSED → OPEN` (15 seconds, doubling with each consecutive opening up to 5 minutes) `→ HALF_OPEN` (1 concurrent probe; 2 successes → CLOSED; a failure → OPEN).
- The state is in each node's memory; changes are announced to other nodes through Valkey. A Valkey outage only stops the synchronization.

### Synchronization between replicas

Code: `apps/gateway/src/health-sync.ts`

- Every local change in `HealthRegistry` is published on the Valkey channel `dirouter:health`: a breaker opening or closing, cooldown, lockout and credential disabling. The other replicas apply it with `applyRemote`. A node's own message is ignored, and a corrupt or unknown message is rejected.
- **Valkey is not the source of state, only a notification channel.** During an outage, publishing silently fails (counter `dropped`), and each node continues with its local breaker. After Valkey returns, ioredis re-establishes the subscription automatically.
- `GET /internal/health` (breaker and credential status) requires `Authorization: Bearer $INTERNAL_TOKEN`. Without it, it returns 404, because this path is reachable through Traefik too.

Check in compose with two gateway replicas (2026-11-07):

| step                                                          | result                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 6 errors only to replica 1 (`mock/down`)                      | breaker `mock-down` opened in **both** replicas                                                                                       |
| Valkey stopped; 6 errors only to replica 2 (`mock/deadproxy`) | the breaker in replica 2 opened locally. `mock/small` still returned 200. Replica 1 did not know, which is expected during an outage. |
| Valkey back up; 429 on replica 1                              | the cooldown of the same credential was seen in replica 2 (automatic subscription re-established)                                     |

Tests in `health-sync.test.ts`: breaker and cooldown publishing, Valkey outage, corrupt message, and two nodes on a real Valkey (in the integration job in CI).

## 6. Cooldown and lockout

| event                                                        | effect                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| generic 429                                                  | cooldown of the same credential until Retry-After; without it, 10 seconds × 2^(repeat−1), up to 5 minutes |
| model-specific 429 (message includes model / tokens per min) | lockout of only that model on the same credential                                                         |
| 401/403 or `insufficient_quota`                              | credential disabled (one hour, or until the key changes) + alert event                                    |

The cooldown ends automatically, and the other credentials of the same provider keep working. The statuses are visible from `/health/runtime` and the Health page.

## 7. Combo example

```json
{
  "slug": "smart",
  "strategy": "priority",
  "targets": [
    { "modelId": "anthropic/claude-sonnet-4-5", "order": 0 },
    { "modelId": "openai/gpt-4.1", "order": 1 },
    { "modelId": "deepseek/deepseek-chat", "order": 2 }
  ],
  "fallbackOn": [
    "rate_limit",
    "overloaded",
    "server",
    "timeout",
    "connection",
    "auth",
    "not_found",
    "context_length"
  ],
  "retry": { "maxAttempts": 2, "baseDelayMs": 200, "maxDelayMs": 2000 }
}
```

## Creating a combo through the API (card 3.8)

```bash
A=https://admin.example.com/api/v1/orgs/$ORG
# model from the catalog: price, context and capabilities are filled in automatically
curl -X POST $A/models -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"providerId":"'$OPENAI'","upstreamModel":"gpt-4.1","catalogKey":"openai/gpt-4.1"}'
# three-target combo: first gpt-4.1, and on a rate_limit, server or timeout error, the next ones
curl -X POST $A/combos -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"slug":"smart","strategy":"priority","retryMaxAttempts":3,
       "fallbackOn":["rate_limit","server","timeout"],
       "targets":[{"modelId":"'$GPT41'"},{"modelId":"'$CLAUDE'"},{"modelId":"'$DEEPSEEK'"}]}'
# alias for clients
curl -X POST $A/aliases -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"slug":"gpt-best","comboId":"'$SMART'"}'
```

Validation:

- A duplicate target is rejected (`422`, "duplicate target").
- A missing model, or one belonging to another organization, is rejected (`422`, "unknown model").
- An invalid error class in `fallbackOn` is rejected.
- Model, alias and combo names share one namespace, and a duplicate gives 409.
- A model used in a combo or alias, and a combo that has an alias, cannot be deleted (409).

Strategies:

- `priority`: by `order`.
- `weighted`: random, using `weight`.
- `round-robin`: turn-based among the nodes.

If `fallbackOn` is empty, `DEFAULT_FALLBACK_ON` is used.

## Price catalog without migration

> Since card 27.5 the catalog is also synced from external price sources by the worker; see [catalog-sync.md](../catalog-sync.md). The bundled `catalog.json` is the starting point and the fallback.

- `packages/model-catalog/src/catalog.json` is a versioned file (`version: YYYY.MM.DD`) with the prices and capabilities of the main models. `GET /orgs/:orgId/catalog` displays it.
- A model created with a `catalogKey` is updated to the new catalog price and context with `POST /orgs/:orgId/models/sync-catalog`. So a price update is just a JSON change and a deploy, and needs no migration.
- A manual price (`PATCH` with `pricing`) marks the model `priceOverride: true` and keeps its `catalogKey`, so neither `sync-catalog` nor the catalog price sync overwrites it; `PATCH` with `followCatalog: true` returns it to the catalog price.
- Capabilities `documents` and `audioInput` (card 27.2) say whether a model takes PDF/file and audio input in chat. `false` keeps such requests away from the model; unset leaves it to what the provider type can translate. See [translation](../gateway/translation.md#documents-and-audio).
- js-tiktoken is an optional peer of `@dirouter/model-catalog`. The gateway and control-api (whose guardrail live test counts tokens like the gateway) declare it and keep it in their images; the other apps only import `@dirouter/model-catalog/catalog`.

## Advanced routing (Sprint 2)

> Code: `packages/routing/src/{router,stats,hedging}.ts`, `apps/gateway/src/{proxy,health-probe}.ts` (cards 12.1 to 12.5).

### Smart combo strategies (12.1)

| Strategy     | Target order                                                                          |
| ------------ | ------------------------------------------------------------------------------------- |
| `latency`    | lowest latency score first. Score = PeakEWMA × (1 + in-flight requests)               |
| `cost`       | cheapest estimate for this request first (estimated input + output cap × model price) |
| `least-used` | fewest (requests in the last 60 seconds + in-flight) first; spreads load              |
| `headroom`   | most context window left after this request first                                     |

- **PeakEWMA**: an exponential latency average (α = 0.2) next to a "peak" that jumps on every slow sample and decays with a 60-second time constant. A provider that suddenly slows down is avoided sooner than with a plain average, and returns gradually after it recovers.
- **P2C** (power of two choices): live traffic on `latency` combos samples two targets and the faster one wins; the rest follow by score. This avoids sending every request to the single "fastest" target. The test in `packages/routing/src/sprint2.test.ts` shows that P2C rejects the slow-tailed target of the two samples and lowers the p95.
- A model without statistics yet sorts last under `latency` (until it is tried once as a fallback).
- Statistics live in each replica's memory; a restart only costs a short warm-up and routing never waits on the network.

### Request hedging (12.2)

If the first target has not answered within `afterMs`, a second request goes to the next target and whichever answers first wins; the other is cancelled. Configured in a combo's `hedging`:

| Field         | Default | Description                                          |
| ------------- | ------- | ---------------------------------------------------- |
| `enabled`     | `false` | hedging is opt-in                                    |
| `afterMs`     | `800`   | delay before the parallel attempt starts             |
| `maxParallel` | `2`     | maximum simultaneous attempts (2 to 4)               |
| `maxRatio`    | `0.2`   | share of requests allowed to hedge within the window |
| `windowMs`    | `60000` | budget window length                                 |

- **Budget**: `HedgeBudget` is a rolling window; a parallel attempt only starts while hedges are below `maxRatio × requests`. Fallback after an error is not subject to this budget.
- **Cost**: the number of extra attempts is recorded in the usage event's `hedgeAttempts` and the `request_log.hedge_attempts` column, and every attempt is listed in `attempts`. The recorded cost is the winning attempt's; a cancelled attempt reports no token usage, so if the provider bills for it, DiRouter does not see it. `hedgeAttempts` is there to estimate that overhead and `maxRatio` caps it.
- In a stream, no further attempt starts after the first byte reached the client (committed).

### Periodic health probes (12.3)

Each round the gateway calls the cheap "list models" endpoint of every enabled credential (no tokens are generated, so it costs nothing on usage-billed providers).

| Setting (`settings.healthProbe`) | Default | Description                                               |
| -------------------------------- | ------- | --------------------------------------------------------- |
| `enabled`                        | `false` | off by default                                            |
| `intervalSeconds`                | `60`    | time between rounds (minimum 10)                          |
| `failureThreshold`               | `3`     | consecutive auth failures before a credential is disabled |
| `successThreshold`               | `1`     | consecutive successes before a credential is restored     |
| `maxPerRound`                    | `50`    | cap of credentials probed per round (rotating window)     |

- Only an `auth` class error disables a credential. A provider outage (5xx, timeout, connection) is the circuit breaker's job; disabling every key during an outage would hide the real cause.
- A disabled credential (by a probe or by a live-traffic error) returns automatically as soon as a probe succeeds, and the change is published to all replicas.
- With Valkey only one replica probes per round (lock `dirouter:health:probe-lock`), so the upstream sees one request per credential.
- A model list answers even when an account has no credit; scheduled channel tests send a real one-token request instead ([upstream-balances.md](../upstream-balances.md), card 32.9).
- **Uptime history**: samples are queued in the `dirouter:health:samples` list and the worker's `health-samples` job moves them to the `provider_health_samples` table every 30 seconds (retention: `HEALTH_SAMPLE_RETENTION_DAYS`, default 30 days). Read it with `GET /orgs/:orgId/health/uptime?from=&to=`: uptime percent, average latency and hourly buckets per provider.

### Session affinity (12.4)

For combos with `sticky: true` a session stays on the same model and credential until the TTL ends (while it is healthy). The benefit: the provider-side prompt cache hits on every turn of a long conversation (for example Claude Code).

| Setting (`settings.sessionAffinity`) | Default              |
| ------------------------------------ | -------------------- |
| `enabled`                            | `false`              |
| `header`                             | `x-dirouter-session` |
| `ttlSeconds`                         | `3600`               |

The session identity is resolved in this order:

1. The configured header value (at most 200 characters), together with the key id; two keys never share a session.
2. Without the header: a SHA-256 hash of the stable conversation prefix (system prompt + first message). Agent tools resend this part unchanged on every turn, which is exactly what the provider cache keys on. A single-message request without a system prompt is not pinned.

If the pinned target becomes unhealthy (breaker, cooldown), the request follows the normal strategy and the session is pinned to the new successful target. Prompt text never appears in the identity or in logs.

### Routing simulator (12.5)

`POST /orgs/:orgId/routes/simulate` (permission `models:read`) runs the same resolver as live traffic without any I/O:

```json
{
  "model": "smart",
  "virtualKeyId": "key_…",
  "estimatedInputTokens": 120000,
  "maxOutputTokens": 4096
}
```

The response contains `candidates` (in attempt order, with provider and credential) and `skipped` (every target left out with its reason: `model_disabled`, `provider_disabled`, `context_window`, `provider_circuit_open`, `model_circuit_open`, `credential_disabled`, `credential_cooldown`). Routing errors (`model_not_found`, `model_not_allowed`, `no_available_provider`, `context_length_exceeded`) are valid simulation results too and come back with `ok: false`. In the dashboard: the "Routing simulator" page.

Every candidate also carries `signals`, the live inputs of the dynamic strategies (card 25.4): `latencyMs` (PeakEWMA, absent until the model has traffic), `costMicroUsd` (estimated price of the simulated request), `recentRequests` and `inFlight`, and `headroomTokens` (absent when the model has no context window set). The simulator page shows the one the combo's strategy sorted on.

### Gateway-wide settings

`healthProbe`, `sessionAffinity`, `cache`, `compression`, `tracing` and `breaker` are stored in a single `gateway_settings` row and reach every replica through `ConfigSnapshot.settings`:

```bash
curl -X PUT "$ADMIN/orgs/$ORG/config/settings" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"healthProbe":{"enabled":true,"intervalSeconds":60},"sessionAffinity":{"enabled":true}}'
```

The whole object is validated before it is stored; an invalid payload changes nothing. `GET` on the same path returns the stored value and the effective value (with defaults).
