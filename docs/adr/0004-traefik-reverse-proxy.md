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
