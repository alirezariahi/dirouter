[English](#english) · [فارسی](#persian)

<a id="english"></a>

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

---

<a id="persian"></a>

# ADR-0004: Traefik v3 به‌عنوان reverse proxy

- **Status:** Accepted
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه

gateway، control-api و dashboard به یک نقطه ورود واحد با TLS نیاز دارند. gateway جریان‌های SSE طولانی‌مدت ارائه می‌دهد که نباید بافر شوند یا با timeoutهای کوتاه قطع شوند. استقرار با Docker Compose انجام می‌شود و replicaهای gateway باید بدون ویرایش دستی پیکربندی proxy بار را متعادل کنند.

### عوامل تصمیم

- TLS خودکار با Let's Encrypt.
- کشف سرویس از روی labelهای Docker.
- مدیریت درست SSE و جریان‌های طولانی: بدون buffer و با timeoutهای قابل تنظیم.
- health checkها و حذف replicaهای ناسالم.
- مسیر مهاجرت به Kubernetes.

### گزینه‌های بررسی‌شده

1. Traefik v3.
2. Nginx.
3. Caddy.
4. Envoy.

## تصمیم

از **Traefik v3** با provider داکر و پیکربندی مبتنی بر label استفاده شود.

- `/v1/*` به gateway، `/api/*` به control-api و سایر مسیرها به dashboard مسیریابی شوند.
- از ACME (Let's Encrypt) برای TLS استفاده شود و HTTP به HTTPS هدایت شود.
- `respondingTimeouts` بلند، بدون بافر کردن پاسخ و health checkهای `/healthz` برای gateway پیکربندی شوند.
- middlewareهای امنیتی (هدرها و محدودیت اندازه بدنه درخواست) در Traefik قرار گیرند. محدودکننده اصلی نرخ درخواست در gateway است.

## پیامدها

### مثبت

- افزودن replicaهای gateway نیازی به ویرایش پیکربندی proxy ندارد.
- TLS نیازی به اسکریپت‌های جداگانه برای تمدید ندارد.
- مدل پیکربندی از طریق IngressRoute به Kubernetes قابل توسعه است.

### منفی

- دسترسی به سوکت Docker سطح حمله را افزایش می‌دهد. دسترسی را با یک socket proxy یا یکپارچه‌سازی سوکت با کنترل مناسب محدود کنید؛ صرفاً یک bind فقط‌خواندنی عملیات API داکر را فقط‌خواندنی نمی‌کند.
- پیکربندی مبتنی بر label نسبت به پیکربندی ثابت Nginx دیباگ آن دشوارتر است.

### پیگیری

- پیاده‌سازی کامل پیکربندی و تست SSE از طریق Traefik.
