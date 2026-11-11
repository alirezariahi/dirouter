[English](runbook.md) · [فارسی](runbook.fa.md)

<div dir="rtl">

# Runbook عملیاتی DiRouter

این سند برای **تشخیص و مهار حادثه** است. دستورها روی Compose production و دامنهٔ نمونه `example.com` نوشته شده‌اند؛ مقدار واقعی را جایگزین کنید. مسیر کد همان دایرکتوری‌ای است که `compose.yaml` دارد.

> **محدودیت اعتبارسنجی:** سناریوهای این نسخه روی محیط staging تمرین نشده‌اند و هیچ ادعای تمرین staging وجود ندارد. قبل از اجرای اقدام مخرب، دستور و blast radius را با اپراتور دوم مرور کنید. گزارش تستهای قبلی فقط در انتهای سند و با محیط واقعی خودشان آمده است.

## ۰. قواعد حادثه و دستورهای پایه

- ابتدا شدت/دامنه را مشخص کنید: همهٔ مدلها یا یک provider، یک کلید یا همه، data plane یا فقط dashboard/usage. زمان شروع و آخرین تغییر (deploy/config/secret) را ثبت کنید.
- secret کامل، prompt، response یا `.env` را در ticket/chat نگذارید. برای correlation فقط `X-Request-Id` را نقل کنید.
- `down -v`، حذف volume، `prisma migrate reset/dev`، `bootstrap.sh --force` و restore روی DB اصلی اقدام عادی رفع حادثه نیستند.
- ری‌استارت کورکورانه علت را پاک و outbox/stream را در خطر می‌کند. اول لاگ و وضعیت را بگیرید؛ برای gateway از drain استفاده کنید.
- `/metrics` سرویسها را روی اینترنت منتشر نکنید. دستور `exec` زیر فقط داخل شبکه/کانتینر اجرا می‌شود و نیاز به نصب curl در image را با fallback به Node پوشش می‌دهد.

```bash
P='docker compose -f compose.yaml -f compose.prod.yaml'
$P ps
$P logs --since=30m --tail=300 gateway control-api worker postgres valkey
curl -fsS https://api.example.com/healthz
curl -fsS https://api.example.com/readyz
curl -fsS https://admin.example.com/healthz
curl -fsS https://admin.example.com/readyz   # Postgres + Valkey؛ 503 یعنی readiness نیست
```

خواندن متریک worker بدون انتشار پورت:

```bash
$P exec -T worker sh -lc 'curl -fsS http://127.0.0.1:3100/metrics 2>/dev/null || node -e "fetch(\"http://127.0.0.1:3100/metrics\").then(r=>r.text()).then(console.log)"'
```

برای متریک gateway/control-api همین الگو با سرویس و پورت `8080` یا `3000` را داخل همان سرویس اجرا کنید. نام متریک‌ها و queryها در [observability.md](observability.fa.md) است.

### جدول ارجاع سریع

| علامت غالب                                            | بروید به                                                 |
| ----------------------------------------------------- | -------------------------------------------------------- |
| خطا فقط روی یک provider/model یا breaker باز          | [۱. قطعی provider](#۱-قطعی-provider-یا-credential)       |
| 429 در همهٔ replicaها، breaker ناهماهنگ، رشد outbox   | [۲. قطعی Valkey](#۲-قطعی-یا-کندی-valkey)                 |
| Control API/worker خطای DB و `/readyz` سرویسها 503    | [۳. قطعی PostgreSQL](#۳-قطعی-یا-کندی-postgresql)         |
| داشبورد/config خراب ولی LLM با config قبلی کار می‌کند | [۴. قطعی Control API](#۴-قطعی-control-api)               |
| کلید `dr-…` لو رفته                                   | [۵. نشت کلید مجازی](#۵-نشت-کلید-مجازی)                   |
| کلید upstream لو رفته                                 | [۶. نشت credential provider](#۶-نشت-credential-provider) |
| چرخش keyring رمزنگاری                                 | [۷. چرخش MASTER_KEY](#۷-چرخش-master_key)                 |
| لاگ/گزارش usage عقب است                               | [۸. تأخیر usage](#۸-تأخیر-یا-افت-usage-و-لاگ-درخواست)    |
| دیسک/volume در حال پر شدن                             | [۹. پر شدن دیسک](#۹-پر-شدن-دیسک)                         |
| CPU/همزمانی/latency بالا                              | [۱۰. Scale gateway](#۱۰-scale-گیتوی)                     |
| 5xx بعد از release                                    | [۱۱. Rollback](#۱۱-rollback-نسخه)                        |
| deploy/restart برنامه‌ریزی‌شده                        | [۱۲. Rolling](#۱۲-ریاستارت-rolling-و-استقرار-بدون-قطعی)  |

## ۱. قطعی provider یا credential

**علائم**

- 5xx/timeout/503 `no_available_provider` روی مدلهای یک provider؛ breaker `open` یا credential cooldown/disabled.
- `X-Dirouter-Attempts > 1` یا افزایش `dirouter_gateway_request_attempts` و خطای upstream؛ سایر مدلها سالم‌اند.

**تشخیص**

1. در Dashboard → **سلامت** و **Providerها** وضعیت provider/model/credential را ببینید. بین breaker provider، breaker model و lockout/cooldown credential تفاوت بگذارید.
2. تست provider را با همان credential بزنید. 401/403 یعنی auth/quota؛ 429 یعنی سهمیه؛ timeout/connection یعنی شبکه/proxy/DNS/TLS یا upstream. status و latency را ثبت کنید.
3. Logs را به مدل و بازه محدود کنید. `X-Request-Id` را در gateway trace کنید. متریک خطا بر اساس provider و `breaker_state{state=~"open|half_open"}` را ببینید.
4. اگر fallback فعال است ولی کار نمی‌کند: enabled بودن مدل/provider/credential بعدی، `fallbackOn`، بودجه/rate limit و context window را بررسی کنید. بعد از ارسال بخشی از stream، fallback ممکن نیست.

**اقدام**

- با مسیر سالم جایگزین از طریق combo/alias ترافیک را هدایت کنید؛ اگر provider خراب در اولویت است موقتاً آن را disable کنید. مدل/alias کلاینت را تغییر ندهید مگر ضروری.
- credential مشکل‌دار را disable یا با راز سالم rotate کنید. سهمیه تمام‌شده با reset breaker حل نمی‌شود.
- proxy/timeout را فقط با شواهد تغییر دهید؛ افزایش timeout در قطعی کامل latency را بدتر می‌کند. retry/fallback را بی‌حد افزایش ندهید.
- reset در Health فقط **بعد از رفع علت** برای پاک‌کردن وضعیت موقت است. OWNER/ADMIN لازم است و عمل audit می‌شود.

**بررسی**

- تست provider موفق، breaker closed، درخواست non-stream و stream با 200 و محتوای کامل.
- نرخ خطا/attempt به baseline برگردد و credential در cooldown/disable نماند. در Logs attribution همان provider جایگزین/سالم دیده شود.

## ۲. قطعی یا کندی Valkey

**علائم**

- صف usage و maintenance متوقف، `dirouter_queue_metrics_up == 0`، رشد `dirouter_gateway_usage_outbox_events` یا تأخیر لاگ.
- در fail-open محدودیتها دقیق نیستند و breakerها بین replicaها همگام نمی‌شوند. در fail-closed درخواستهای دارای limit/budget ممکن است 429 بگیرند. `/readyz` Control API و worker خطا می‌دهد.

**تشخیص**

```bash
$P ps valkey
$P logs --since=30m valkey gateway control-api worker
$P exec -T valkey valkey-cli ping                 # انتظار PONG
$P exec -T valkey valkey-cli info persistence    # AOF و آخرین ذخیره
$P exec -T valkey valkey-cli info memory         # maxmemory/noeviction و فشار حافظه
```

- قطعی شبکه internal را از crash/OOM/disk جدا کنید. `OOM command not allowed` یا خطای AOF را با قطعی ساده اشتباه نگیرید.
- gateway با limiter محلی/fail-open می‌تواند پاسخ بدهد؛ «درخواست 200 است» به معنی سالم بودن صف و بودجه نیست. خروجی `/metrics` را روی همهٔ سرویسها بگیرید.

**اقدام**

1. اگر صرفاً process متوقف است، `$P up -d valkey` و سپس صبر برای reconnect کنید. volume `valkeydata` را حذف نکنید و `FLUSHALL` نزنید.
2. خطای دیسک را طبق [بخش ۹](#۹-پر-شدن-دیسک) رفع کنید. برای OOM ابتدا رشد queue/outbox و مصرف حافظه را بفهمید؛ سیاست `noeviction` را برای عبور موقت به eviction تغییر ندهید چون job/state حذف می‌شود.
3. اگر fail-closed و قطعی طولانی است، تصمیم کاهش سرویس/بازکردن موقت limiter یک تغییر ریسک‌دار config است و باید با مالک سرویس هماهنگ شود؛ مقدار پیش‌فرض را بی‌سند تغییر ندهید.
4. worker را فقط اگر بعد از برگشت Valkey هم stuck است، controlled restart کنید: `$P up -d --force-recreate --no-deps worker` و زمان ۳۰ ثانیه برای jobs فعال بدهید. پاک‌سازی دستی queue/DLQ نکنید.

**بررسی**

- `PONG`، `/readyz` Control API/worker برابر 200، `dirouter_queue_metrics_up == 1`.
- outbox و waiting/active/delayed کاهش یابد، `outbox replayed` و `usage event written` دیده شود، DLQ رشد نکند.
- چند درخواست با کلید limit‌دار و بدون limit بزنید؛ نرخ limit دوباره سراسری و breaker/cooldown بین replicaها هماهنگ شود.

## ۳. قطعی یا کندی PostgreSQL

**علائم**

- login/dashboard/config با خطا، `/readyz` Control API یا worker برابر 503، خطای connection/timeout Prisma، رشد retry/DLQ.
- gateway به DB وصل نیست و ممکن است با snapshot قبلی LLM سرویس دهد؛ تغییر config، revocation و usage persistence در خطر است.

**تشخیص**

```bash
$P ps postgres
$P logs --since=30m postgres control-api worker
$P exec -T postgres pg_isready -U dirouter -d dirouter
# اگر نام کاربر/DB متفاوت است، مقدارهای .env را بدون چاپ رمز استفاده کنید.
set -a; . ./.env; set +a
$P exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
$P exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT now(), count(*) FROM pg_stat_activity;'
```

- `accepting connections` کافی نیست: connection pool، lock و disk را ببینید. خطای migration را از outage جدا کنید و آخرین `migrate` را بخوانید.

**اقدام**

- crash loop یا stop ساده: `$P up -d postgres`؛ صبر تا healthy. Volume یا data directory را دست‌کاری نکنید.
- pool پر: مصرف‌کننده/lock و replicaها را محدود کنید. `DB_MAX_CONNECTIONS` را بدون ظرفیت DB زیاد نکنید. worker را موقتاً متوقف کنید اگر فشار نوشتن مانع recovery control plane است، با این دانش که usage در صف/outbox عقب می‌ماند.
- migration ناموفق: نسخه‌ها و خطا را ثبت کنید؛ `migrate dev/reset` یا SQL اصلاح دستی بدون برنامه نزنید. release سازگار و migration قبلی را با DBA مرور کنید.
- corruption یا restore فقط با backup سالم و پنجرهٔ قطعی طبق [deploy-production](deploy-production.fa.md#10-postgresql-backup-fa) انجام شود. restore بدون MASTER_KEY/KEY_PEPPER بازیابی کامل نیست.

**بررسی**

- `pg_isready` و `SELECT 1` موفق، `/readyz` هر دو سرویس 200، login و خواندن config سالم.
- یک تغییر غیرمخرب config (یا تست provider) انجام و snapshot تازه ببینید. صف usage کم و DLQ رشد نکند. تعداد رکوردها و migration status پس از restore جداً بررسی شود.

## ۴. قطعی Control API

**علائم**

- dashboard/login/config/probe از Control API خطا یا 5xx؛ gateway هنوز با آخرین snapshot پاسخ می‌دهد.
- نسخهٔ config در Health ثابت می‌ماند و تغییرات/revoke اعمال نمی‌شود.

**تشخیص**

```bash
curl -sS -i https://admin.example.com/healthz
curl -sS -i https://admin.example.com/readyz
$P logs --since=30m control-api gateway
$P ps control-api gateway
```

- healthz فقط liveness است؛ readyz خطای DB/Valkey را مشخص می‌کند. خطای `INTERNAL_TOKEN` در gateway از خطای Postgres جدا کنید.
- با یک مدل/کلید **موجود و غیرمحرمانهٔ آزمایشی** gateway را تست کنید تا مرز data plane/control plane روشن شود. کلید نشت‌کرده را برای این تست دوباره استفاده نکنید.

**اقدام**

1. وابستگی خراب را اول رفع کنید ([Postgres](#۳-قطعی-یا-کندی-postgresql)/[Valkey](#۲-قطعی-یا-کندی-valkey)).
2. اگر process/config control-api خراب است: `$P up -d --force-recreate --no-deps control-api`. migration را صرفاً برای restart دوباره اجرا نکنید.
3. تا برگشت، تغییر config غیرضروری را فریز کنید. برای revocation اضطراری کلید مجازی، بازگرداندن Control API اولویت دارد؛ snapshot دستی را جایگزین منبع حقیقت نکنید.
4. اگر ناسازگاری token بعد از rotate است، مقدار یکسان را coordinated در control-api و gateway برگردانید/اعمال کنید؛ token را در لاگ چاپ نکنید.

**بررسی**

- healthz/readyz هر دو 200، login/refresh و dashboard سالم.
- تغییر آزمایشی config به سرعت در نسخهٔ snapshot تمام replicaها دیده شود؛ درخواست LLM با config موجود 200.
- gateway خطای snapshot/auth نداشته باشد و usage pipeline به کار خود ادامه دهد.

## ۵. نشت کلید مجازی

**علائم**

- کلید `dr-…` در Git/log/chat یا مصرف ناشناس روی prefix/پروژه، مدل یا IP غیرمنتظره.

**تشخیص**

- منبع نشت و دامنهٔ دسترسی را بدون بازنشر secret مشخص کنید. در Keys/Logs بر اساس کلید/پروژه و بازه، مدل، هزینه، آخرین استفاده و IP را بررسی کنید.
- prefix برای جست‌وجو کافی است؛ مقدار کامل را در گزارش نیاورید. از upstream logs برای ارتباط با provider استفاده کنید.

**اقدام**

1. **فوری:** در Keys روی **ابطال** بزنید؛ این برخلاف rotate بدون grace است. snapshot جدید باید به gateway برسد.
2. کلید جایگزین با حداقل مدل/limit/IP لازم بسازید و secret را فقط از کانال امن به مالک بدهید. کلاینت را منتقل و قدیمی را revoked نگه دارید.
3. secret را از مخزن/لاگ حذف و در صورت commit بودن تاریخچه را طبق فرآیند امنیتی پاک کنید؛ حذف فایل به‌تنهایی revocation نیست. mirror، backup، CI log و artifact را هم آلوده بدانید.
4. هزینه/مصرف سوءاستفاده را ارزیابی و provider budget/rate limit موقت را در صورت حمله محدود کنید. incident را با زمان revocation ثبت کنید.

**بررسی**

- درخواست با کلید لو رفته 401 بگیرد و کلید جایگزین 200. اگر هنوز 401 نمی‌گیرید، config sync/Control API را فوری بررسی کنید.
- در Logs مصرف جدید روی کلید قدیمی متوقف شود؛ کلید خام در لاگها/اسناد جدید وجود نداشته باشد.

## ۶. نشت credential provider

**علائم**

- secret upstream در Git/ticket/log یا مصرف/هزینهٔ غیرعادی در console provider، 401/403 پس از revoke خارجی.

**تشخیص**

- کدام provider/credential و چه مدلهایی در معرض‌اند را با prefix ماسک و آیدی داخلی مشخص کنید. از billing/audit provider استفاده کنید.
- مصرف DiRouter و upstream را در یک بازه مقایسه کنید؛ اختلاف می‌تواند استفادهٔ خارج از gateway باشد. راز کامل را جست‌وجو یا چاپ نکنید.

**اقدام**

1. در console provider راز لو رفته را **revoke/rotate** کنید و quota/IP restrictions موجود را محدود کنید.
2. بلافاصله در Providers همان credential را **چرخش** و secret تازه وارد کنید. اگر راز جایگزین آماده نیست، credential را disable و ترافیک را به مسیر سالم ببرید.
3. reset breaker/cooldown فقط بعد از ذخیرهٔ راز سالم. آثار نشت در repo/log/backup را مدیریت و هزینهٔ سوءاستفاده را ثبت کنید.
4. اگر MASTER_KEY هم لو رفته، فقط rotate provider کافی نیست؛ بخش بعد و فرآیند re-encryption لازم است.

**بررسی**

- تست credential تازه ok و درخواست مدل 200؛ credential قدیمی در upstream دیگر پذیرفته نشود.
- خطاهای auth/429 به baseline برگردد و مصرف خارجی متوقف شود. هیچ پاسخ API/audit جدیدی secret کامل نداشته باشد.

## ۷. چرخش MASTER_KEY

`MASTER_KEY` یک keyring است: `1:<old-base64>,2:<new-base64>`؛ بالاترین نسخه برای encrypt جدید و نسخه‌های قدیمی برای decrypt نگه داشته می‌شوند.

**علائم/ریسک**

- چرخش برنامه‌ریزی‌شده یا نشت keyring. خطای `key vN is not in the keyring`/`decryption failed` یعنی نسخهٔ لازم حذف یا keyring اشتباه است.
- تغییر env رکوردهای DB را re-encrypt **نمی‌کند**. حذف old key پیش از re-encryption همهٔ credentialهای قدیمی، از دسترس رفتن آن‌هاست.

**تشخیص و آماده‌سازی**

1. backup تازه و تست restore، نسخهٔ رمزشدهٔ `.env`/keyring قدیمی و پنجرهٔ عملیات داشته باشید.
2. روی نصب غیر production ابتدا تمرین کنید. نسخهٔ ciphertextها و ابزار re-encryption موجود release را بررسی کنید؛ در این مخزن helperهای `encrypt`/`needsReencryption` وجود دارد ولی migration خودکار re-encrypt مستند نشده است.
3. key تازه را با CSPRNG بسازید و آن را در history/chat ننویسید. نسخهٔ جدید باید یکتا و بالاتر باشد.

**اقدام امن**

1. keyring جدید را با **قدیم + جدید** در control-api و gateway یکسان قرار دهید. نمونهٔ placeholder، نه مقدار واقعی: `MASTER_KEY=1:<OLD>,2:<NEW>`.
2. سرویسها را controlled recreate کنید؛ gateway rolling و سپس control-api. هیچ نسخه‌ای را حذف نکنید.
3. credentialهای موجود و یک credential تازه را تست کنید؛ این ثابت می‌کند decrypt قدیمی و encrypt جدید هر دو کار می‌کنند.
4. با ابزار بررسی‌شده، همهٔ ciphertextهای قدیمی را در تراکنش/دستهٔ قابل resume به نسخهٔ جدید re-encrypt کنید و قبل/بعد backup و شمارش نسخه بگیرید. اگر چنین ابزاری در release موجود نیست، **اینجا متوقف و keyring دو نسخه‌ای نگه دارید**؛ اسکریپت SQL ساده جای decrypt/AAD/GCM را نمی‌گیرد.
5. فقط وقتی هیچ ciphertext قدیمی نمانده و rollback نیاز به old key ندارد، old key را در تغییر جداگانه حذف و دوباره مرحلهٔ ۳ را تکرار کنید.

**بررسی**

- decrypt همهٔ credentialهای فعلی و تست provider موفق؛ لاگ decryption error صفر.
- secret تازه با `key_version` جدید و پاسخ 200؛ rollback keyring و backup قابل دسترس تا پایان پنجرهٔ مشاهده.
- `KEY_PEPPER` با MASTER_KEY فرق دارد: تغییر pepper همهٔ virtual keyها را بی‌اعتبار می‌کند و بخشی از این چرخش نیست.

<a id="8-usage-delay-fa"></a>

## ۸. تأخیر یا افت usage و لاگ درخواست

**علائم**

- Overview/Logs عقب، هزینهٔ صفر/ناقص، رشد outbox/backlog/DLQ، بودجه با ledger اختلاف دارد؛ درخواستها ممکن است 200 باشند.

**تشخیص**

1. در gateway متریک `dirouter_gateway_usage_outbox_events`، در control-api/worker `dirouter_queue_jobs{state=~waiting|active|delayed|failed}` و `dirouter_queue_metrics_up` را بخوانید.
2. `dirouter_usage_events_written_total`، `failed_total` و `dead_total` و لاگ `usage event write failed`/`moved to dead-letter` را بررسی کنید.
3. Postgres و Valkey را با بخشهای ۲ و ۳ بسنجید. حجم/مجوز volume `gateway-data` و خطاهای `dropping corrupt outbox line` را ببینید.
4. با `X-Request-Id` یک درخواست معلوم، `request completed` در gateway و `usage event written` در worker را بیابید. عدم وجود آن در UI به‌تنهایی اثبات drop نیست؛ ingestion تاخیری است.

**اقدام**

- علت اتصال/DB/disk را رفع کنید؛ صف و outbox را پاک نکنید. `jobId=requestId` ارسال تکراری را idempotent می‌کند و worker نیز رکورد تکراری نمی‌سازد.
- worker را با grace ۳۰ ثانیه recreate کنید فقط اگر پس از سالم‌شدن وابستگی‌ها هم مصرف resume نشود: `$P up -d --force-recreate --no-deps worker`.
- برای invalid event در DLQ، نسخهٔ contract/مبدأ را اصلاح و replay کنترل‌شده با ابزار آزموده انجام دهید. حذف DLQ یا تغییر payload بدون برنامه ممنوع است؛ رویداد خراب با retry درست نمی‌شود.
- budget-reconcile هر ۵ دقیقه شمارنده را با ledger تطبیق می‌دهد؛ اصلاح گزارش/بودجه را پس از تخلیهٔ صف ارزیابی کنید و دستی شمارنده نسازید.

**بررسی**

- درخواست تازه با request id در Logs ظاهر شود و هزینه/توکن/attempt درست باشد.
- outbox و backlog به صفر/سطح عادی برسد، written افزایش یابد و failed/dead رشد نکند. بودجه پس از reconcile با ledger سازگار شود.

## ۹. پر شدن دیسک

**علائم**

- PostgreSQL/Valkey خطای write/AOF/WAL، gateway نتواند snapshot/outbox بنویسد، Traefik نتواند ACME ذخیره کند، crash loop و `ENOSPC`.

**تشخیص**

```bash
df -h
df -i
docker system df
docker system df -v
$P ps
$P logs --since=30m postgres valkey gateway traefik worker
```

- volume را با مصرف `pgdata`، `valkeydata`، `gateway-data` و `traefik-acme` تفکیک کنید. `du` داخل volume mount/cانتینر و رشد فایلهای outbox/WAL را بررسی کنید.
- inode تمام‌شده با GB آزاد فرق دارد. لاگ `json-file` در production rotation دارد ولی دیسک/DB/outbox همچنان رشد می‌کنند.

**اقدام**

1. نوشتن غیرضروری و ترافیک را در صورت خطر corruption مهار کنید. فضای امن روی همان filesystem آزاد یا ظرفیت دیسک را افزایش دهید.
2. فقط artifact شناخته‌شده و غیرضروری را حذف کنید. imageهای قدیمی unused را با احتیاط prune کنید؛ **volume و backup را prune نکنید**. `docker system prune --volumes` ممنوع است.
3. `request_log` retention را با policy موجود worker انجام دهید، نه حذف random partition. backup قدیمی را به ذخیره‌سازی خارجی منتقل کنید، نه حذف تنها نسخه.
4. outbox را حذف نکنید: نشاندهندهٔ usage ارسال‌نشده است. Valkey/DB را سالم کنید تا replay شود. اگر volume خراب است، recovery برنامه‌ریزی‌شده لازم است.

**بررسی**

- `df` و inode حاشیهٔ امن دارند، DB `SELECT 1`/write آزمایشی و Valkey `PONG`/AOF سالم.
- gateway می‌تواند config/outbox بنویسد، outbox کم و سرویسها ready هستند؛ هشدار ظرفیت با هدف زمان‌دار تنظیم شود.

## ۱۰. Scale گیت‌وی

**علائم**

- CPU/RAM بالا، p95/TTFT بدتر، صف bulkhead/concurrency rejection، رشد active streams؛ در حالی که upstream و DB سالم‌اند.

**تشخیص**

- متریک duration، active streams، attempts و admission rejection را بخوانید. خطای upstream را از اشباع gateway جدا کنید.
- ظرفیت Valkey، پهنای باند، connectionهای upstream و سهمیهٔ provider را بسنجید؛ scale ممکن است فقط فشار را به آن‌ها منتقل کند.
- Compose فعلی روی یک میزبان است. HA چندمیزبانه یا scale Postgres/Valkey با همین دستور ایجاد نمی‌شود.

**اقدام**

```bash
# مقدار GATEWAY_REPLICAS را هم در .env به‌روز کنید تا drift نماند.
make scale n=3
# معادل: $P up -d --no-recreate --scale gateway=3 gateway
$P ps gateway
curl -fsS https://api.example.com/readyz
```

- یک replica را در زمان افزایش، حداقل دو replica برای availability نگه دارید. تغییر drain/grace و rollback را از قبل بدانید.
- control-api و worker را با همان الگو scale نکنید؛ چیدمان چند replica control-api پیش‌فرض تست‌شده نیست و worker مصرف DB/صف را چندبرابر می‌کند.

**بررسی**

- همهٔ replicaها در Health دیده و ready هستند، configVersion یکسان و heartbeat تازه دارند.
- ترافیک بین replicaها توزیع و p95/rejection بهتر می‌شود؛ 5xx، retry storm یا خطای Valkey/upstream افزایش نمی‌یابد. usage idempotent و بدون backlog غیرعادی بماند.

## ۱۱. Rollback نسخه

**علائم**

- بعد از release: افزایش 5xx، startup/migration failure، ترجمه/stream خراب، config sync یا usage failure.

**تشخیص**

- `TAG` فعلی/قبلی، زمان تغییر، لاگ migrate و diff migration را ثبت کنید. مرز خرابی را provider/config جدا کنید.
- **image rollback، DB rollback نیست.** اگر migration حذفی/ناسازگار اعمال شده، image قبلی ممکن است ناامن باشد.

**اقدام**

1. در صورت خرابی گسترده deploy را متوقف و ترافیک را به replicaهای سالم نگه دارید. backup و دسترسی keyring را بررسی کنید.
2. `TAG` قبلی سازگار را در `.env` بنویسید و imageهای همان release را pull کنید؛ `latest` نه.
3. migration جدید را برای rollback دوباره اجرا نکنید. control-api/worker/dashboard قبلی را فقط در صورت سازگاری schema بازگردانید و gateway را rolling طبق بخش ۱۲ برگردانید.
4. اگر schema ناسازگار است، expand/contract یا restore با پنجرهٔ قطعی و از دست رفتن دادهٔ بعد از backup را با مالک سرویس انتخاب کنید؛ restore تصادفی نکنید.

```bash
# TAG=sha-<previous-verified-commit> در .env
$P pull
$P up -d --no-deps control-api worker dashboard
# gateway را با روش rolling بخش ۱۲ و TAG قبلی جایگزین کنید.
```

**بررسی**

- startup/readyz، login/config، درخواست non-stream و stream و usage ingestion سالم.
- نرخ 5xx/latency به baseline برگردد، `forced=0` در drain، migration/DB سالم و نسخه‌های image/config ثبت شوند. علت release جدید در incident باز شود.

<a id="12-rolling-restart-fa"></a>

## ۱۲. ری‌استارت rolling و استقرار بدون قطعی

با رسیدن SIGTERM، gateway ابتدا `/readyz` را `503 {"status":"draining"}` می‌کند ولی درخواستهای موجود را سرویس می‌دهد؛ پس از ready delay از چرخش Traefik خارج و listener بسته می‌شود. streamها تا `GATEWAY_SHUTDOWN_DRAIN_MS` ادامه دارند، سپس UsageSink flush می‌کند. در لاگ `drained` مقدار `forced` باید صفر باشد.

| تنظیم                             |                   پیش‌فرض | شرط                                       |
| --------------------------------- | ------------------------: | ----------------------------------------- |
| `GATEWAY_SHUTDOWN_READY_DELAY_MS` |                      5000 | بیشتر از دو دور health check دوثانیه‌ای   |
| `GATEWAY_SHUTDOWN_DRAIN_MS`       |                     30000 | متناسب با طولانی‌ترین stream مجاز         |
| `stop_grace_period`               |                       45s | بیشتر از ready delay + drain + زمان flush |
| Traefik ready check               | `/readyz`، 2s، timeout 1s | replica draining باید خارج شود            |

اگر drain را تغییر می‌دهید، grace را هم تغییر دهید؛ SIGKILL می‌تواند stream/flush را قطع کند.

### ری‌استارت همان image

با حداقل ۲ replica و یکی‌یکی:

```bash
for c in $($P ps -q gateway); do
  docker stop -t 45 "$c"
  docker start "$c"
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" = healthy ]; do sleep 1; done
  sleep 5
done
```

اگر health status موجود نبود یا timeout رخ داد، حلقه را بی‌نهایت رها نکنید؛ وضعیت را بررسی و پیش از replica بعدی توقف کنید.

### استقرار image جدید

اول migration سازگار و control-api/worker/dashboard، بعد replicaهای gateway جدید؛ سپس drain قدیمی‌ها:

```bash
n=$($P ps -q gateway | wc -l | tr -d ' ')
old=$($P ps -q gateway)
$P pull gateway
$P up -d --no-deps --no-recreate --scale gateway=$((n * 2)) gateway
for c in $($P ps -q gateway); do
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" = healthy ]; do sleep 1; done
done
sleep 5
for c in $old; do docker stop -t 45 "$c" && docker rm "$c"; done
```

دستور بالا timeout ندارد؛ در عملیات واقعی deadline و بررسی شکست اضافه کنید و هیچ‌گاه همهٔ replicaهای سالم را برای گذر از health ناموفق حذف نکنید.

### بررسی بعد از deploy/restart

```bash
curl -fsS https://api.example.com/readyz
curl -fsS https://admin.example.com/readyz
$P logs --since=15m gateway control-api worker
$P ps
```

- non-stream و stream 200 و کامل، نسخهٔ config سالم، usage ثبت و `forced: 0`.
- `forced > 0` یعنی درخواست/stream از سقف drain گذشته؛ grace/drain را بر اساس stream واقعی اصلاح یا deploy را در زمان کم‌بار انجام دهید.

## ۱۳. بعد از حادثه

- زمان شروع/تشخیص/مهار/بازیابی، اقدامها، نسخه و request idهای نمونه را بدون secret ثبت کنید.
- lost/replayed/dead-letter usage، هزینه و درخواستهای تحت تأثیر را ارزیابی کنید؛ «200 بعد از recovery» اثبات کامل بودن داده نیست.
- alert ابزاری را که حادثه را زودتر نشان می‌داد اضافه کنید و فقط سناریوی واقعاً اجراشده را با تاریخ، محیط و نتیجه در این سند علامت بزنید.

## سوابق بررسی قبلی (نه تمرین staging این سند)

### ۲۰۲۶-۱۱-۰۸ — rolling gateway روی محیط توسعه/تست

- `apps/gateway/src/shutdown.test.ts`: در ready delay مقدار readyz=503 اما درخواست تازه 200 و stream کامل؛ stream طولانی با خطای قابل‌پارس پایان یافته؛ درخواست معلق 503 shutdown.
- دو replica image production پشت Traefik dev با health/transport production و بار ۱۶ کلاینت هم‌زمان (۶۰٪ non-stream و ۴۰٪ stream سه‌ثانیه‌ای).
- اجرای اول: ۹۴۲ درخواست 200 و ۳۷۹ stream کامل؛ اجرای دوم: ۱۰۲۲ درخواست 200 و ۴۱۶ stream کامل؛ صفر 5xx و `forced: 0`. این نتایج staging ادعا نمی‌شوند.

مستندات مرتبط: [deploy-production](deploy-production.fa.md)، [observability](observability.fa.md)، [usage pipeline](usage-pipeline.fa.md)، [routing](concepts/routing.fa.md)، [limits](concepts/limits.fa.md).

</div>
