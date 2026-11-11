[English](config-sync.md) · [فارسی](config-sync.fa.md)

<div dir="rtl">

# Config Snapshot و همگام‌سازی گیت‌وی

کد: `apps/control-api/src/snapshot` و `apps/gateway/src/config-store.ts` · کارت‌های ۳.۹ و ۴.۲

```
داشبورد/API ──تغییر موفق زیر /orgs/──▶ control-api: rebuild (debounce ۵۰ms)
                                         │ checksum تازه؟ → config_versions (version++)
                                         └─ PUBLISH dirouter:config:updated <version>
gateway ◀── SUBSCRIBE ── فوراً GET /internal/config/snapshot (If-None-Match)
gateway ◀── هر ۲ ثانیه همان GET (پشتیبان وقتی Valkey قطع است) → 304 اگر تغییری نیست
gateway: اعتبارسنجی zod → swap اتمیک در حافظه → ذخیره روی دیسک (بوت بدون control-api)
```

## snapshot

- **همهٔ سازمان‌ها** در یک snapshot: providerها با credential **رمزشده**، مدل‌ها و قیمت‌ها، comboها، aliasها، کلیدهای فعال (فقط hash)، محدودیت و بودجهٔ پروژه، تیم و کلید، و تنظیمات.
- **هیچ secret بازی ندارد.** secretها فقط در حافظهٔ گیت‌وی با MASTER_KEY باز می‌شوند. کلیدهای ابطال‌شده یا منقضی در snapshot نیستند.
- محتوا با کلیدهای مرتب‌شده سریال می‌شود و checksum آن (SHA-256) فقط با تغییر واقعی عوض می‌شود. پس rebuild بدون تغییر نسخهٔ تازه نمی‌سازد.
- `config_versions`: شمارهٔ نسخه افزایشی است (`SERIAL`) و ۵۰ نسخهٔ آخر نگه داشته می‌شود. advisory lock جلوی ساخت هم‌زمان در چند replica از control-api را می‌گیرد.
- **چه چیزی rebuild را راه می‌اندازد**: هر درخواست غیر GET موفق (کد کمتر از 400) زیر `/api/v1/orgs/` (provider، credential، مدل، alias، combo، کلید، پروژه و …)، و شروع control-api.

## endpoint داخلی

`GET /internal/config/snapshot` با `Authorization: Bearer $INTERNAL_TOKEN`:

- بدون توکن 404 می‌دهد.
- `ETag: "v<version>-<checksum16>"` دارد. با `If-None-Match` یکسان پاسخ **304 بدون بدنه** است.

## گیت‌وی

- snapshot رسیده از control-api **منبع حقیقت** است: هر نسخهٔ متفاوتی از آن پذیرفته می‌شود، مثلاً بعد از بازیابی DB یا جایگزینی snapshot آزمایشی dev. نسخهٔ دیسک فقط اگر تازه‌تر باشد اعمال می‌شود.
- snapshot نامعتبر رد و لاگ می‌شود و config فعلی می‌ماند (کارت ۴.۲).
- بدون control-api، گیت‌وی از آخرین snapshot سالم روی دیسک بالا می‌آید.

## بررسی (۲۰۲۶-۱۱-۰۷)

- integration در control-api:
  - نسخه با هر تغییر افزایش می‌یابد و روی Valkey اعلام می‌شود.
  - rebuild بدون تغییر نسخه نمی‌سازد.
  - ETag و 304 کار می‌کنند و اسکیما معتبر است.
  - secret بازی در snapshot نیست.
  - کلید ابطال‌شده از نسخهٔ بعدی حذف می‌شود.
  - بدون توکن 404.
- compose (تغییر در control-api تا اثر در گیت‌وی):
  - کلید تازه بعد از ۴۸ تا ۱۸۶ms قابل استفاده شد.
  - ابطال بعد از ۱۲۵ تا ۱۴۰ms اعمال شد.
  - با Valkey متوقف، تغییر از poll دوره‌ای رسید (۱۵۵ms در این اجرا، و در بدترین حالت حدود ۲ ثانیه).

</div>
