[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Local CI verification

## Acceptance status

Local verification on 2026-11-07: all 40 quality/build tasks passed, along with the 62 existing unit tests, nine package-selection tests (including real Git and Turbo), and two real-service tests. Root/CI ESLint, Prettier, `actionlint`, and `git diff --check` also passed.

All five images were produced on an ARM64 host, and the control-api image passed its health check. The Docker client for control-api did not exit after build/export completed and was stopped; that invocation does not count as a fully successful Docker command. The Linux AMD64 runner and GHCR publication remain unverified.

Local checks do not replace a GitHub run. The criterion "the pipeline is green on main" can be confirmed only after committing/pushing and observing a successful run on main. The unfinished card 2.1 Dockerfiles must also be present in the checkout; local-only files are not available to the runner. Code-review approval is a separate step and is not inferred from tool results.

---

<a id="persian"></a>

# بررسی محلی CI

## وضعیت پذیرش

بررسی محلی در تاریخ ۲۰۲۶-۱۱-۰۷: هر ۴۰ تسک کیفیت و ساخت موفق بودند، به همراه ۶۲ تست واحد موجود، نه تست انتخاب پکیج (شامل Git و Turbo واقعی) و دو تست سرویس واقعی. ESLint ریشه و CI، Prettier، `actionlint` و `git diff --check` هم موفق بودند.

هر پنج image روی یک هاست ARM64 ساخته شدند و image مربوط به control-api بررسی health را پاس کرد. کلاینت Docker برای control-api پس از پایان build/export خارج نشد و متوقف شد؛ این اجرا به‌عنوان یک دستور Docker کاملاً موفق حساب نمی‌شود. Runner لینوکس AMD64 و انتشار در GHCR هنوز تأیید نشده‌اند.

بررسی‌های محلی جایگزین اجرای GitHub نیستند. معیار «پایپلاین روی main سبز است» فقط پس از commit و push کردن و مشاهده‌ی یک اجرای موفق روی main قابل تأیید است. فایل‌های Dockerfile کارت ۲.۱ که هنوز کامل نشده‌اند باید در checkout وجود داشته باشند؛ فایل‌های فقط‌محلی برای runner در دسترس نیستند. تأیید code-review مرحله‌ی جداگانه است و از نتایج ابزارها استنباط نمی‌شود.
