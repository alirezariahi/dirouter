# Chaos test (card 18.1)

> Script: [`scripts/chaos/run.mjs`](../../scripts/chaos/run.mjs) · `make chaos` · `pnpm test:chaos`

The chaos test keeps a steady load on the gateway while one dependency at a time is removed, and measures the requests sent **while the fault is active**. A scenario passes when both hold for that fault window:

1. at most **1%** of the requests fail with a **5xx or a connection error** (`CHAOS_MAX_FAILURE_RATIO`);
2. at least **99%** of the requests succeed with a **2xx** (`CHAOS_MIN_SUCCESS_RATIO`). Without the second check a gateway that answers everything with 401 or 429 would pass the first one.

## Method

- Open-loop load: a request starts every `1000 / CHAOS_RPS` ms (default 20 req/s) whether or not earlier ones have finished, so a slow gateway cannot hide failures by slowing the test down.
- Each scenario runs 3 s of warm-up, the fault for `CHAOS_FAULT_SECONDS` (default 15 s) and 5 s of recovery. Every request is assigned to a phase by its start time. The **fault window** runs from the moment the fault is injected until the dependency has been started again; only its requests count for the two criteria, so healthy warm-up and recovery traffic cannot dilute a bad result. The recovery phase is reported next to it, with a warning when fewer than the minimum succeed there.
- Requests are `POST /v1/chat/completions` with a temporary virtual key against the seeded mock providers. A 4xx answer is not a "failed" request for the first criterion, but it is not a success either, so it counts against the second one.
- **Preflight.** Before any fault is injected, and again before each scenario, one request per model must return 2xx. If it does not (for example 401 because the stack was not seeded, or the snapshot is not loaded), the run stops with the status and the response body, and nothing is stopped.
- Every scenario here is one the gateway has to ride out, so all of them use the same minimum success share. A scenario that is allowed to shed load can set its own `minSuccess` in the script.
- Faults are injected with `docker compose stop/start` (and `docker kill -s SIGKILL` for a gateway replica). Everything the script stops is started again and the temporary key is revoked, also when the run fails or is interrupted with Ctrl-C (`SIGINT`) or `SIGTERM`; an interrupted run exits non-zero (130 or 143).

## Scenarios and expected behaviour

| Scenario          | Fault                                       | Why traffic should survive                                                                                                      |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `baseline`        | none                                        | reference numbers for the run                                                                                                   |
| `provider-down`   | the primary target of the combo answers 503 | retry and fallback move to the healthy target; the breaker then skips the broken provider                                       |
| `control-api`     | control-api stopped                         | the gateway serves from the last config snapshot (memory and disk)                                                              |
| `valkey`          | Valkey stopped                              | the rate limiter falls back to its local mode (`failMode: open`), usage events go to the on-disk outbox and are replayed        |
| `postgres`        | PostgreSQL stopped                          | the gateway has no database dependency; usage events wait in the queue until the worker can write                               |
| `worker`          | worker stopped                              | usage events accumulate in the queue; nothing on the request path waits for the worker                                          |
| `gateway-replica` | one gateway container killed                | Traefik's health check removes the replica; needs at least two replicas (prod or HA compose), otherwise the scenario is skipped |

With `failMode: closed` the `valkey` scenario is expected to fail by design: requests are rejected while the limiter cannot be consulted.

On the HA stack the `valkey` scenario stops the `valkey` service only. If it is the primary, the sentinels fail over to a replica within 5 to 15 seconds, so the scenario measures a failover instead of a full outage; if it is currently a replica, the scenario measures almost nothing (check with `sentinel get-master-addr-by-name dirouter` first).

## Running it

```bash
make up && make migrate && make seed
make chaos                      # all scenarios
make chaos s="valkey postgres"  # selected scenarios

# Against the production or HA stack (several gateway replicas):
CHAOS_COMPOSE="-f compose.yaml -f compose.prod.yaml -f compose.ha.yaml" \
E2E_GATEWAY_URL=https://api.example.com E2E_ADMIN_URL=https://admin.example.com \
node scripts/chaos/run.mjs
```

| Variable                  | Default                               | Meaning                                                        |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `CHAOS_RPS`               | `20`                                  | requests per second                                            |
| `CHAOS_FAULT_SECONDS`     | `15`                                  | how long each fault lasts                                      |
| `CHAOS_MAX_FAILURE_RATIO` | `0.01`                                | largest share of 5xx and connection errors in the fault window |
| `CHAOS_MIN_SUCCESS_RATIO` | `0.99`                                | smallest share of 2xx answers in the fault window              |
| `CHAOS_COMPOSE`           | `-f compose.yaml -f compose.dev.yaml` | compose files of the stack under test                          |

The script prints both numbers for every scenario, exits non-zero when a scenario misses either limit or the preflight fails, prints a Markdown table, and writes `.verify/chaos-<timestamp>.json` and `.md`.

**Do not run it against a stack that serves real users**: it stops PostgreSQL and Valkey on purpose.

## Results

Measured on 2026-11-20 on the sprint 2 working tree: development stack (`compose.yaml` + `compose.dev.yaml`) on a single Docker host (macOS Docker Desktop, 4 CPUs / 4 GB), one gateway replica, 20 req/s, 15 s fault window, limits 5xx + network ≤ 1% and 2xx ≥ 99%. All six scenarios that can run with one gateway replica passed without a failed request.

The `gateway-replica` scenario was measured on 2026-11-22 on the same stack scaled to two gateway replicas (`up -d --no-deps --scale gateway=2 gateway`), three runs with the same result. The first measurement failed: 29 of 553 requests (5.24%) got 502/504, because Traefik did not retry and waited five seconds for a connection to the dead replica. The gateway router now retries a request that cannot reach its replica (`gateway-retry`, four tries) and the dial timeout is one second; the row below is the result with that change. The one failed request is the request that was in flight on the killed replica.

<!-- chaos-results:start -->

| Scenario                                            | Result | Requests in fault window | Failed (5xx + network) | Succeeded (2xx) | p95 ms | Recovery phase |
| --------------------------------------------------- | ------ | ------------------------ | ---------------------- | --------------- | ------ | -------------- |
| No fault (baseline)                                 | pass   | 291                      | 0 (0.00%)              | 291 (100.00%)   | 16     | 0/97 failed    |
| Primary provider returns 503 (combo falls back)     | pass   | 291                      | 0 (0.00%)              | 291 (100.00%)   | 17     | 0/98 failed    |
| control-api stopped                                 | pass   | 329                      | 0 (0.00%)              | 329 (100.00%)   | 18     | 0/97 failed    |
| Valkey stopped (limiter, usage queue, health sync)  | pass   | 312                      | 0 (0.00%)              | 312 (100.00%)   | 36     | 0/95 failed    |
| PostgreSQL stopped                                  | pass   | 312                      | 0 (0.00%)              | 312 (100.00%)   | 16     | 0/98 failed    |
| worker stopped (usage events queue up)              | pass   | 343                      | 0 (0.00%)              | 343 (100.00%)   | 43     | 0/98 failed    |
| One gateway replica killed (2 replicas, 2026-11-22) | pass   | 310                      | 1 (0.32%)              | 309 (99.68%)    | 18     | 0/97 failed    |

<!-- chaos-results:end -->

## Reading a failure

- **Preflight failed with 401 or 404**: the stack is not seeded or the gateway has no snapshot; run `make seed` and check `configVersion` in `/readyz`.
- **Few 5xx but a low 2xx share**: read the status codes column. 429 during `valkey` means the limiter does not fail open; 401 during `control-api` means the gateway lost its snapshot or key cache.
- **5xx during `valkey`**: check `settings.failMode` and the gateway log for limiter or budget errors; with `open` the request path must not depend on Valkey.
- **5xx during `control-api` or `postgres`**: the gateway should not call either on the request path; look for a semantic-cache lookup without a timeout or a snapshot that failed to load.
- **Network errors during `gateway-replica`**: requests in flight on the killed replica are lost by definition (SIGKILL). They should be a small share at 20 req/s; if not, check Traefik's health-check interval and retry settings.
- **Warning about the recovery phase**: a dependency came back but a client did not reconnect; see the reconnect settings of that client.
