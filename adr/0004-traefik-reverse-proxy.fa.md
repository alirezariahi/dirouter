[English](0004-traefik-reverse-proxy.fa.md) · [فارسی](0004-traefik-reverse-proxy.fa.md)

<div dir="rtl">

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

</div>
