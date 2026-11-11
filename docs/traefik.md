[English](traefik.md) · [فارسی](traefik.fa.md)

# Traefik

> Files: `deploy/traefik/traefik.yml` (static, production), `deploy/traefik/traefik.dev.yml` (static, development), `deploy/traefik/dynamic/middlewares.yml` (dynamic, Go template with env), and the Docker labels in `compose.yaml`.

## Entrypoints

| Name        | Port                 | Purpose                                                                                                               |
| ----------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `web`       | 80                   | production: permanent redirect to HTTPS; dev: serves HTTP directly (for curl)                                         |
| `websecure` | 443                  | TLS. production: Let's Encrypt (`certResolver: le`); dev: Traefik's default self-signed certificate for `*.localhost` |
| `traefik`   | 8082 (not published) | ping (container health check) and Prometheus metrics                                                                  |

## Routers

| Domain                             | Service                              | Middlewares                                                                     |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `api.<DOMAIN>`                     | gateway                              | `security-headers`, `compress`                                                  |
| `admin.<DOMAIN>`                   | control-api                          | `security-headers`, `control-api-cors`, `control-api-ratelimit`, `compress`     |
| `app.<DOMAIN>`                     | dashboard                            | `security-headers`, `compress`                                                  |
| `traefik.<DOMAIN>`                 | Traefik dashboard (`api@internal`)   | `dashboard-ips` (ipAllowList), `dashboard-auth` (basicAuth), `security-headers` |
| `mail.localhost`, `mock.localhost` | mailpit and mock-provider (dev only) | —                                                                               |

Providers: Docker with `exposedByDefault: false` (only services with `traefik.enable=true`) on the `dirouter_edge` network, and the file provider for the `dynamic/` folder with `watch`.

## Middlewares

- **security-headers:** HSTS (one year, includeSubdomains, preload, and `forceSTSHeader` so that it is seen even over HTTP in dev), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and removal of `Server` and `X-Powered-By`.
- **compress:** with `excludedContentTypes: text/event-stream`. Compressing SSE means buffering, so it is never applied to streams.
- **control-api-cors:** only `app.<DOMAIN>`, with credentials (the refresh token cookie).
- **control-api-ratelimit:** 50 requests per second with a burst of 100 at the edge. The main LLM rate limit is in the gateway itself (Valkey, per key).
- **dashboard-auth / dashboard-ips:** users come from `TRAEFIK_DASHBOARD_USERS` (htpasswd, comma-separated) and IPs from `TRAEFIK_ALLOW_IPS`. If no user is defined, only one invalid user exists and the dashboard is effectively closed.

## Timeouts and their reasons

| Setting                                                                  | Value        | Reason                                                                                                       |
| ------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `respondingTimeouts.readTimeout`                                         | 300s         | Reading the request body (large prompts and images); the default of 60 seconds is too short for slow uploads |
| `respondingTimeouts.writeTimeout`                                        | 0 (infinite) | **SSE**: a stream response may take tens of minutes; any non-zero value cuts long streams                    |
| `respondingTimeouts.idleTimeout`                                         | 180s         | Closing idle client keep-alives                                                                              |
| `serversTransports.long-stream.forwardingTimeouts.responseHeaderTimeout` | 0            | The gateway itself controls TTFT with an adjustable timeout and fallback; Traefik must not cut earlier       |
| `long-stream.dialTimeout`                                                | 5s           | Connecting to a gateway replica on the internal network must be fast                                         |
| `lifeCycle.graceTimeOut`                                                 | 60s (prod)   | When Traefik stops, open streams have time to finish                                                         |

## Health check and removing an unhealthy replica

The gateway service has a health check in Traefik on `/readyz` every 2 seconds with a timeout of one second. The gateway returns 503 in these states: it has no snapshot yet, or it is draining (after SIGTERM). So an unhealthy replica, or one that is shutting down, leaves the rotation within about 2 to 3 seconds at most. In dev the check is on `/healthz`, so that the gateway is routed even without control-api.

## TLS

- production: `ACME_EMAIL` in `.env`; the default challenge is HTTP-01 on port 80. For a wildcard, enable `dnsChallenge` in `traefik.yml` and pass the DNS provider variables to the container.
- dev: `https://*.localhost` with a self-signed certificate (curl with `-k`), or `http://*.localhost`.

## Test results (2026-11-07)

| Test                                       | Result                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Ten-minute stream Traefik → gateway → mock | 602 seconds, 600 chunks and `[DONE]`, at most 3 lines per second and a 2-second interval: no buffering and no cut           |
| Frozen replica (`docker pause`) under load | Left the rotation about 3 seconds later; 4 failures out of 9656 requests (only the in-flight requests on that same replica) |
| Headers                                    | HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy` on all responses                                                      |
| production                                 | 301 redirect from HTTP to HTTPS                                                                                             |

Note: a request that is made at the same time as the freeze, on the same replica, waits until the client timeout (Traefik does not retry POST). A normal shutdown (SIGTERM) does not cause this, because the gateway drains first.
