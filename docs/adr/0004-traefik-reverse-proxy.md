[English](0004-traefik-reverse-proxy.md) · [فارسی](0004-traefik-reverse-proxy.fa.md)

# ADR-0004: Traefik v3 as reverse proxy

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** DiRouter team

## Context

All apps (gateway, control-api, dashboard) must sit behind a single entry point with TLS. The gateway has long SSE streams that must not be buffered or cut off by a short timeout. Deployment is done with docker compose, and several gateway replicas must be load balanced without manual configuration.

### Decision Drivers

- automatic TLS with Let's Encrypt
- automatic service discovery from Docker labels
- correct support for SSE and long streams (no buffering, configurable timeouts)
- health checks and removal of unhealthy replicas
- a growth path to Kubernetes

### Considered Options

1. Traefik v3
2. Nginx
3. Caddy
4. Envoy

## Decision

**Traefik v3** with the Docker provider and configuration from labels.

- routing: `/v1/*` to the gateway, `/api/*` to control-api, the rest to the dashboard.
- TLS with ACME (Let's Encrypt), and a redirect from HTTP to HTTPS.
- for the gateway: long `respondingTimeouts`, no response buffering, and a health check on `/healthz`.
- security middlewares (headers, request body size limit) in Traefik; the main rate limit is in the gateway, not in Traefik.

## Consequences

### Positive

- a gateway replica can be added without changing the proxy configuration.
- TLS without an auxiliary script.
- the same configuration model (IngressRoute) in Kubernetes.

### Negative

- Traefik's access to the Docker socket raises the attack surface; the socket should be read-only or accessed through a socket-proxy.
- debugging label configuration is harder than with Nginx.

### Follow-up

- card 2.3: full configuration and SSE testing behind Traefik.
