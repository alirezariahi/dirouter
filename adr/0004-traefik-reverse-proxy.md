# ADR-0004: Traefik v3 as reverse proxy

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decision makers:** DiRouter team

## Context

Gateway, control-api, and dashboard need a single TLS entry point. Gateway serves long-lived SSE streams that must not be buffered or cut off by short timeouts. Deployment uses Docker Compose, and gateway replicas should be load-balanced without manually editing proxy configuration.

### Decision drivers

- Automatic TLS with Let's Encrypt.
- Service discovery from Docker labels.
- Correct SSE and long-lived stream handling: no buffering and configurable timeouts.
- Health checks and removal of unhealthy replicas.
- A migration path to Kubernetes.

### Considered options

1. Traefik v3.
2. Nginx.
3. Caddy.
4. Envoy.

## Decision

Use **Traefik v3** with the Docker provider and label-based configuration.

- Route `/v1/*` to gateway, `/api/*` to control-api, and other paths to dashboard.
- Use ACME (Let's Encrypt) for TLS and redirect HTTP to HTTPS.
- Configure long `respondingTimeouts`, no response buffering, and `/healthz` checks for gateway.
- Put security middleware (headers and request-body size limits) in Traefik. The primary application rate limiter lives in gateway.

## Consequences

### Positive

- Adding gateway replicas does not require proxy configuration edits.
- TLS does not need separate renewal scripts.
- The configuration model extends to Kubernetes through IngressRoute.

### Negative

- Docker socket access increases the attack surface. Restrict access using a socket proxy or an appropriately controlled socket integration; a read-only bind alone does not make Docker API operations read-only.
- Label-based configuration is harder to debug than a static Nginx configuration.

### Follow-up

- Implement the full configuration and test SSE through Traefik.
