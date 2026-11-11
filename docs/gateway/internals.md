[English](internals.md) · [فارسی](internals.fa.md)

# Gateway internal structure and request lifecycle

Code: `apps/gateway/src` · card 4.1

## Components

| file              | role                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `main.ts`         | env, creation of `UsageSink` and the gateway, listen, and drain on SIGTERM                           |
| `server.ts`       | Fastify instance, route registration, request id, `/healthz`, `/readyz` and `/internal/health`       |
| `config-store.ts` | in-memory snapshot: load from disk, poll with ETag from control-api, atomic swap (card 4.2)          |
| `auth.ts`         | virtual key authentication ([auth.md](auth.md))                                                      |
| `proxy.ts`        | hot path: canonical, resolve, retry and fallback, translation of the response or stream, usage event |
| `upstream.ts`     | separate undici dispatcher for each provider (keep-alive, proxy), multi-layer timeouts               |
| `usage-sink.ts`   | BullMQ queue with a local outbox ([usage-pipeline.md](../usage-pipeline.md))                         |

## Life of a request

```
Traefik ──▶ Fastify onRequest: x-request-id (from Traefik, or a fresh ULID), x-dirouter-instance
        ──▶ handleProxy(api)
              1. auth: HMAC + Map + timingSafeEqual, expiry, IP          → 401/403
              2. body validation with zod and conversion to canonical    → 400
              3. router.resolve: alias/combo → candidates
                 (context window filter, breaker, cooldown, allowed model) → 404/403/503
              3b. key bulkhead (rateLimit.maxConcurrency)                → 429
              4. executeWithFallback: for each candidate
                   provider bulkhead (maxConcurrency) — full: next candidate
                   adapter.buildRequest → callUpstream (connect/TTFT/idle/total)
                   error → classify → retry with backoff, or next candidate
              5. response: translated JSON, or stream (headers sent only with the first upstream event)
              6. emitUsage (synchronous, no I/O)
```

- **No heavy pipeline**: the `/v1/*` routes are direct Fastify handlers, with no global interceptors or pipes. Validation is done once, with zod. Fastify's internal logging is off, and the pino log is only at info level and contains no message content.
- **request id**: the incoming `X-Request-Id` is used if it is valid (`[\w.-]{1,128}`); otherwise `req_<ULID>`. It appears in the response, the log and the usage event.
- **Safe stream**: no byte goes to the client until the first upstream event arrives, so fallback is still possible. After the first byte, an error is sent as a standard SSE error event (card 5.7; details below).
- **Client disconnect**: the request's `AbortSignal` reaches `callUpstream` and closes the upstream connection. A test shows this takes under a second (`upstream.test.ts`).

## HTTP settings

| setting                        | value                                             | reason                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bodyLimit`                    | 20MB                                              | base64 images in messages                                                                                                                                                                                                        |
| `requestTimeout`               | 0                                                 | ten-minute stream; timeouts are controlled in the upstream layer                                                                                                                                                                 |
| `keepAliveTimeout`             | 95s                                               | must be greater than `idleConnTimeout` (90s) in the serversTransport named `long-stream` in Traefik. If the gateway closes an idle connection earlier, Traefik may send a request on a connection that is closing and get a 502. |
| `trustProxy`                   | true                                              | the real IP from X-Forwarded-For, which Traefik rewrites                                                                                                                                                                         |
| undici Agent for each provider | keep-alive, `connections: 256`, `connect.timeout` | warm, separate connections; a slow provider does not starve the others                                                                                                                                                           |

## Readiness and drain

- `/healthz`: only the liveness of the process.
- `/readyz`: 200 only when the snapshot is loaded and we are not draining. Before that it returns 503 with `no_config`, so Traefik sends no traffic.
- **SIGTERM**: first `readyz=503`, so Traefik (healthcheck every 2 seconds) removes the replica; then a pause (maximum 5 seconds), then `app.close()`, which finishes in-flight requests; and finally `usageSink.close()`.

## Why NestJS is not in the hot path

ADR-001 proposed "NestJS with FastifyAdapter and direct handlers for `/v1/*`". The current gateway is plain Fastify, because:

- The hot path deliberately did not use DI, interceptors or pipes, so the Nest shell only added boot time and extra dependencies.
- The gateway has no management API. All management endpoints are in control-api, which is NestJS.

If a module shared with control-api becomes necessary, the same Fastify instance can be passed to `new FastifyAdapter(app)` without changing any routes.

## Overhead

`scripts/bench/overhead.mjs` runs the mock provider and the gateway from `dist` with `NODE_ENV=production`, and hits both paths sequentially with keep-alive (300 warmup requests are not counted):

```bash
pnpm build && node scripts/bench/overhead.mjs 5000
```

| run (2026-11-07, Apple Silicon) | direct p50 | via gateway p50 | overhead p50 | overhead p95 |
| ------------------------------- | ---------- | --------------- | ------------ | ------------ |
| 3000 requests                   | 3.816ms    | 4.010ms         | **0.19ms**   | 0.27ms       |
| 5000 requests                   | 3.688ms    | 4.175ms         | **0.49ms**   | 0.47ms       |

Both runs are under the 3 ms threshold. At p99 the difference came out negative, which is scheduling noise. The overhead includes auth, zod validation, translation to canonical and back, resolution, one extra HTTP hop, and the usage event.

## Safe stream fallback and bulkhead (card 5.7)

### Stream

- **Before the first byte**: the 200 header and the first data are sent only when the first meaningful upstream event has arrived. If an HTTP error, connection drop, timeout or error event arrives before that, the attempt is not "committed", and the executor retries or falls back as it does in non-stream mode.
- **After the first byte**: no other attempt is allowed (`reason: committed`), because the client has already received part of the response, and combining two broken responses would be harmful. The gateway sends a standard error event in the client's format and closes the stream:
  - OpenAI:
    ```
    data: {"error":{"message":"upstream stream interrupted","type":"api_error","param":null,"code":"connection"}}
    ```
    The official openai SDK converts this to an `APIError`. `[DONE]` is not sent.
  - Anthropic:
    ```
    event: error
    data: {"type":"error","error":{"type":"api_error","message":"upstream stream interrupted"}}
    ```
    The type is always one of the standard Anthropic types: `api_error`, `overloaded_error`, `rate_limit_error` or `timeout_error` (`anthropicErrorType`). The official SDK converts it into an error.
- The stream error message is generic and does not reveal the internal address of the upstream or the proxy. The exact class is recorded in the logs and the usage event.

### Bulkhead

A local semaphore on each node, with a short queue (`packages/routing/src/bulkhead.ts`):

| level       | setting                                                          | when full                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider    | `providers.max_concurrency` (`maxConcurrency` in the API)        | the candidate is skipped without contacting upstream, and the next combo candidate is tried; if no candidate remains, 429 with `rate_limit_error` and `Retry-After: 1` |
| virtual key | `virtual_keys.max_concurrency` (`maxConcurrency` in the key API) | immediate 429 with `rate_limit_error` (code `rate_limited`) and `Retry-After: 1`                                                                                       |

- **Queue**: the default is 16 waiting and 2 seconds, configurable with `settings.bulkhead.queueSize` and `settings.bulkhead.queueTimeoutMs`. A full queue means immediate rejection. A waiter whose client disconnects is removed from the queue.
- **No effect on health**: a rejection in the bulkhead is a "skipped" entry in attempts. It does not open the breaker, does not put the credential into cooldown, and does not require the combo's `fallbackOn`.
- **Release**: the provider slot is freed after the attempt fully ends (for a stream, after the last byte), and the key slot is freed after the whole request ends, including when the client disconnects.
- **undici connection cap**: each provider's pool also has `connections = maxConcurrency` (default 256). The bulkhead rejects before that, so requests do not wait in undici's unbounded queue.
- **Counting is local**: with N replicas, the real cap is N × maxConcurrency. The global cap (rpm/tpm) is the job of the distributed rate limiter in card 6.1.
- The current status in `GET /internal/health` (with INTERNAL_TOKEN), under `bulkheads`: `[{name:"provider:<id>", active, queued, limit}]`.

### Verification (2026-11-08)

- `apps/gateway/src/stream-safety.test.ts` (9 tests):
  - stream fallback before the first byte; a stream cut in the middle with a parsable error event in both formats and no fallback (the mock received only one request); the openai and anthropic SDKs both see the error
  - a slow provider with a cap of 2 and six simultaneous requests: two 200, four 429, and `maxInFlight` at the mock exactly 2
  - combo overflow to the next target (2 on slow and 3 on ok, all 200)
  - a key cap with 429 in the OpenAI and Anthropic formats; the slot is freed after the request ends and after a client disconnect
- `packages/routing`: Bulkhead tests (queue, timeout, abort, cap change) and admission in the executor (no effect on breaker and cooldown).
- Through Traefik, with a provider created from control-api (`maxConcurrency: 2`, mock with `ttft=1500`): six simultaneous requests gave:
  - two 200 in 1.5 seconds
  - two 200 in 3 seconds, which came from the queue
  - two 429 after the queue timeout (2 seconds)

  mock: `maxInFlight = 2`, 4 requests arrived. With a key of `maxConcurrency: 1` and three requests: two 200 (one from the queue) and one 429 with `Too many concurrent requests for this key (limit 1)`. A stream cut in the middle gave a standard error event in both APIs.
