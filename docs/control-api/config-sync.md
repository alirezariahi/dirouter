[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Config Snapshot and gateway synchronization

Code: `apps/control-api/src/snapshot` and `apps/gateway/src/config-store.ts` · cards 3.9 and 4.2

```
dashboard/API ──successful change under /orgs/──▶ control-api: rebuild (debounce 50ms)
                                         │ fresh checksum? → config_versions (version++)
                                         └─ PUBLISH dirouter:config:updated <version>
gateway ◀── SUBSCRIBE ── immediately GET /internal/config/snapshot (If-None-Match)
gateway ◀── the same GET every 2 seconds (fallback when Valkey is down) → 304 if nothing changed
gateway: zod validation → atomic swap in memory → save to disk (boot without control-api)
```

## Snapshot

- **All organizations** in one snapshot: providers with **encrypted** credentials, models and prices, combos, aliases, active keys (hash only), the limits and budgets of projects, teams and keys, and settings.
- **Contains no plain secrets.** Secrets are decrypted only in the gateway's memory with MASTER_KEY. Revoked or expired keys are not in the snapshot.
- The content is serialized with sorted keys, and its checksum (SHA-256) changes only with a real change. So a rebuild without a change does not create a new version.
- `config_versions`: the version number is incremental (`SERIAL`), and the last 50 versions are kept. An advisory lock prevents simultaneous builds across several control-api replicas.
- **What triggers a rebuild**: every successful non-GET request (status below 400) under `/api/v1/orgs/` (provider, credential, model, alias, combo, key, project, etc.), and the control-api startup.

## Internal endpoint

`GET /internal/config/snapshot` with `Authorization: Bearer $INTERNAL_TOKEN`:

- Without the token, it returns 404.
- It has `ETag: "v<version>-<checksum16>"`. With a matching `If-None-Match`, the response is **304 with no body**.

## Gateway

- The snapshot received from control-api is the **source of truth**: any different version is accepted, for example after a DB restore or the replacement of a test snapshot in dev. The disk version is applied only if it is newer.
- An invalid snapshot is rejected and logged, and the current config stays in place (card 4.2).
- Without control-api, the gateway starts from the last valid snapshot on disk.

## Verification (2026-11-07)

- Integration in control-api:
  - The version increases with each change and is announced on Valkey.
  - A rebuild without a change does not create a version.
  - ETag and 304 work, and the schema is valid.
  - No plain-text secret is in the snapshot.
  - A revoked key is removed in the next version.
  - Without a token: 404.
- compose (a change in control-api until its effect in the gateway):
  - A fresh key became usable after 48 to 186 ms.
  - Revocation was applied after 125 to 140 ms.
  - With Valkey stopped, the change arrived via the periodic poll (155 ms in this run, and in the worst case about 2 seconds).

---

<a id="persian"></a>

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
