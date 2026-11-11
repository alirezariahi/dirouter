[English](monitoring.md) · [فارسی](monitoring.fa.md)

<div dir="rtl">

# مانیتورینگ با Prometheus و Grafana

پروفایل اختیاری `monitoring` چهار هدف را هر ۱۵ ثانیه scrape می‌کند: gateway روی `8080`، control-api روی `3000`، worker روی `3100` و Traefik روی `8082`. پورت Traefik همان entryPoint داخلی `traefik` در پیکربندی static است؛ `8080` پورت gateway است، نه Traefik. هیچ‌یک از `/metrics`ها از Traefik عمومی منتشر نمی‌شوند.

Prometheus به شبکهٔ `internal` دسترسی دارد تا متریک worker را بخواند. Grafana فقط روی `edge` است و از طریق آدرس داخلی `http://prometheus:9090` query می‌زند؛ دسترسی مستقیم Grafana به worker یا Postgres ندارد. داشبورد، datasource و قوانین هشدار از فایل provision می‌شوند و برای بازبینی تغییرات در Git باقی می‌مانند.

## اجرا در development

در `code/.env` یک رمز مدیریتی جدا و قوی برای Grafana قرار دهید (رمز پیش‌فرض یا `admin/admin` مجاز نیست):

```dotenv
GRAFANA_ADMIN_PASSWORD=<a-long-random-password>
```

سپس:

```bash
make bootstrap # فقط اگر code/.env هنوز وجود ندارد
docker compose -f compose.yaml -f compose.dev.yaml \
  --profile monitoring up -d --wait
```

- Grafana: <http://127.0.0.1:53000>؛ نام کاربر پیش‌فرض `admin` و رمز همان `GRAFANA_ADMIN_PASSWORD` است. بعد از اولین ورود رمز را عوض کنید.
- Prometheus: <http://127.0.0.1:59090>؛ وضعیت scrape در **Status → Targets** و قوانین در **Alerts** قابل بررسی‌اند.
- داشبورد **DiRouter — نمای عملیاتی** به‌صورت خودکار در پوشهٔ **DiRouter** ساخته می‌شود. datasource پیش‌فرض `Prometheus` است و queryها نیاز به تنظیم دستی ندارند.

برای تغییر پورت‌های localhost می‌توان `GRAFANA_PORT` و `PROMETHEUS_PORT` را تنظیم کرد. این پورت‌ها عمداً فقط روی `127.0.0.1` bind می‌شوند؛ برای دسترسی از راه دور SSH tunnel یا یک reverse proxy احرازهویت‌شده با TLS استفاده کنید. رمز Grafana را در URL، لاگ یا دستور `docker compose config` منتشر نکنید.

## اجرا در production

فایل‌های مانیتورینگ در همان پروژهٔ Compose قرار دارند؛ محدودیت CPU/RAM و چرخش لاگ در `compose.prod.yaml` اعمال می‌شود:

```bash
docker compose -f compose.yaml -f compose.prod.yaml \
  --profile monitoring up -d --wait
```

داده‌های Prometheus در volume نام‌دار `prometheus-data` و تنظیمات/کاربران Grafana در `grafana-data` نگهداری می‌شوند. پیش‌فرض نگهداری TSDB پانزده روز است و با `PROMETHEUS_RETENTION` قابل تغییر است (مثلاً `30d`). ظرفیت دیسک را متناسب با تعداد replica، labelها و retention بررسی کنید؛ backup از داشبورد به‌تنهایی backup از تاریخچهٔ متریک نیست.

برای انتشار امن Grafana در production، bind روی localhost را حفظ کنید و از طریق SSH یا کنترل‌دسترسی سازمانی به آن وصل شوید. اگر آن را روی شبکه عمومی قرار می‌دهید، باید TLS، احرازهویت قوی (ترجیحاً SSO)، allowlist شبکه و سیاست backup جداگانه فراهم شود. متریک‌ها هرچند بدون prompt و secret هستند، وضعیت بهره‌برداری و نام provider/model را آشکار می‌کنند و عمومی محسوب نمی‌شوند.

## داشبورد و هشدارها

داشبورد نرخ و نسبت خطای درخواست، p95/p99 latency، TTFT، streamهای باز، outbox مصرف، وضعیت صف‌ها، jobهای worker، درخواست‌های control-api و پاسخ‌های HTTP Traefik را نشان می‌دهد. هشدارهای پایه در `deploy/monitoring/alerts/dirouter.yml` عبارت‌اند از:

- قطعی scrape هر چهار هدف و ناموفق بودن جمع‌آوری وضعیت صف از Valkey؛
- نرخ خطای gateway بیش از ۱۰٪، p95 بیش از ۳۰ ثانیه، رشد outbox بالای ۱۰۰۰ رویداد و breaker باز؛
- backlog صف بیش از ۱۰۰۰ job، dead-letter شدن رویداد مصرف و نرخ خطای بیش از ۱۰٪ در jobهای worker.

قوانین برای جلوگیری از هشدار روی ترافیک نزدیک به صفر حداقل نرخ درخواست/job دارند. آستانه‌ها را با SLO و الگوی ترافیک واقعی تنظیم کنید؛ مقادیر فعلی نقطهٔ شروع عملیاتی‌اند.

> Prometheus فقط قوانین را ارزیابی و وضعیت `pending`/`firing` را نمایش می‌دهد. ارسال Slack، ایمیل یا PagerDuty به Alertmanager نیاز دارد که در این پروفایل اجرا نمی‌شود؛ برای هشدار بیرونی باید Alertmanager و `alerting.alertmanagers` را در استقرار خود اضافه کنید. از notification channelهای قدیمی Grafana برای جایگزینی این مسیر استفاده نکنید.

## تغییر و اعتبارسنجی پیکربندی

```bash
# رندر و اعتبارسنجی هر دو محیط (راز لازم را در .env قرار دهید)
docker compose -f compose.yaml -f compose.dev.yaml --profile monitoring config --quiet
docker compose -f compose.yaml -f compose.prod.yaml --profile monitoring config --quiet

# بررسی syntax پیکربندی و تمام قواعد، بدون اجرای سرور
docker run --rm \
  -v "$PWD/deploy/monitoring:/etc/dirouter-monitoring:ro" \
  prom/prometheus:v3.7.3 \
  --entrypoint promtool \
  check config /etc/dirouter-monitoring/prometheus.yml
docker run --rm \
  -v "$PWD/deploy/monitoring:/etc/dirouter-monitoring:ro" \
  prom/prometheus:v3.7.3 \
  --entrypoint promtool \
  check rules /etc/dirouter-monitoring/alerts/dirouter.yml
```

بعد از تغییر `prometheus.yml` یا ruleها، با reload سرویس یا `POST /-/reload` (به‌دلیل فعال بودن `--web.enable-lifecycle`) پیکربندی جدید را اعمال کنید. داشبورد و datasourceها در فایل‌های زیر نگهداری می‌شوند:

```text
deploy/monitoring/prometheus.yml
deploy/monitoring/alerts/dirouter.yml
deploy/monitoring/grafana/provisioning/datasources/prometheus.yml
deploy/monitoring/grafana/provisioning/dashboards/dirouter.yml
deploy/monitoring/grafana/dashboards/dirouter-overview.json
```

فهرست کامل متریک‌ها، قرارداد labelها و نمونه queryها در [observability.md](observability.fa.md) است. برای عیب‌یابی اول `/api/health` Grafana، `/-/healthy` Prometheus و سپس **Status → Targets** را بررسی کنید؛ `dirouter_queue_metrics_up=0` جدا از `up=1` به معنی مشکل در خواندن Valkey است، نه قطعی خود endpoint.

</div>
