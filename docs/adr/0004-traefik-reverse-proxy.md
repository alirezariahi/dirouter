[English](#english) · [فارسی](#persian)

<a id="english"></a>

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

---

<a id="persian"></a>

# ADR-0004: Traefik v3 به‌عنوان ریورس پراکسی

- **وضعیت:** پذیرفته‌شده
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه (Context)

همهٔ اپ‌ها (gateway، control-api، dashboard) باید پشت یک نقطهٔ ورود با TLS قرار بگیرند. گیت‌وی stream طولانی SSE دارد که نباید buffer یا با timeout کوتاه قطع شود. استقرار با docker compose انجام می‌شود و چند replica از گیت‌وی باید بدون پیکربندی دستی load balance شوند.

### معیارهای تصمیم (Decision Drivers)

- TLS خودکار با Let's Encrypt
- کشف خودکار سرویس از labelهای Docker
- پشتیبانی درست از SSE و stream طولانی (بدون buffer، timeout قابل تنظیم)
- health check و حذف replica ناسالم
- مسیر رشد به Kubernetes

### گزینه‌های بررسی‌شده (Considered Options)

1. Traefik v3
2. Nginx
3. Caddy
4. Envoy

## تصمیم (Decision)

**Traefik v3** با provider داکر و پیکربندی از labelها.

- routing: `/v1/*` به gateway، `/api/*` به control-api، بقیه به dashboard.
- TLS با ACME (Let's Encrypt)، ریدایرکت HTTP به HTTPS.
- برای گیت‌وی: `respondingTimeouts` بلند، بدون buffering پاسخ، health check روی `/healthz`.
- middlewareهای امنیتی (هدرها، محدودیت اندازهٔ بدنه) در Traefik؛ rate limit اصلی در گیت‌وی است، نه Traefik.

## پیامدها (Consequences)

### مثبت

- افزودن replica گیت‌وی بدون تغییر پیکربندی proxy.
- TLS بدون اسکریپت جانبی.
- همان مدل پیکربندی (IngressRoute) در Kubernetes.

### منفی

- دسترسی Traefik به Docker socket سطح حمله را بالا می‌برد؛ socket فقط‌خواندنی یا از طریق socket-proxy.
- debug پیکربندی labelها از Nginx سخت‌تر است.

### پیگیری

- کارت ۲.۳ پیکربندی کامل و تست SSE پشت Traefik.
